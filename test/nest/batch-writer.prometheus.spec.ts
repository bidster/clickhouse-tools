import type { ClickHouseClient } from "@clickhouse/client";
import { Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import * as prometheus from "prom-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClickHouseBatchWriter } from "../../src/batch-writer.js";
import { ClickHouseBatchWriterModule } from "../../src/nest/batch-writer.module.js";
import { getClickHouseBatchWriterToken } from "../../src/nest/batch-writer.tokens.js";

type EventRow = { id: string };

const TEST_CLIENT = Symbol("TEST_CLIENT");
const insert = vi.fn<ClickHouseClient["insert"]>();

@Module({
  providers: [{ provide: TEST_CLIENT, useValue: { insert } }],
  exports: [TEST_CLIENT],
})
class TestClientModule {}

async function metricValue(
  name: string,
  writer: string,
  sampleName = name,
): Promise<number> {
  const metric = prometheus.register.getSingleMetric(name);
  if (!metric) return 0;
  const values = (await metric.get()).values as Array<{
    metricName?: string;
    labels: Record<string, string | number>;
    value: number;
  }>;
  const sample = values.find(
    (value) =>
      (value.metricName ?? name) === sampleName && value.labels.writer === writer,
  );
  return sample?.value ?? 0;
}

describe("ClickHouseBatchWriterModule Prometheus integration", () => {
  afterEach(() => {
    prometheus.register.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("tracks a retried delivery without removing it from the queue early", async () => {
    vi.useFakeTimers();
    insert
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        executed: true,
        query_id: "retry-success",
        response_headers: {},
      });
    const moduleRef = await Test.createTestingModule({
      imports: [
        ClickHouseBatchWriterModule.forRoot({
          imports: [TestClientModule],
          clientToken: TEST_CLIENT,
          prometheus: { client: prometheus, prefix: "test_" },
          writers: [
            {
              name: "events",
              insert: { table: "events", columns: ["id"] },
              maxBatchSize: 3,
              flushIntervalMs: 10,
              maxRetryDelayMs: 10,
            },
          ],
        }),
        ClickHouseBatchWriterModule.forFeature(["events"]),
      ],
    }).compile();
    const writer = moduleRef.get<ClickHouseBatchWriter<EventRow>>(
      getClickHouseBatchWriterToken("events"),
    );

    writer.write([{ id: "one" }, { id: "two" }]);
    expect(
      await metricValue("test_clickhouse_batch_writer_queue_batches", "events"),
    ).toBe(1);
    expect(insert).not.toHaveBeenCalled();

    const flushing = writer.flush();
    await vi.advanceTimersByTimeAsync(0);

    expect(
      await metricValue("test_clickhouse_batch_writer_rows_accepted_total", "events"),
    ).toBe(2);
    expect(
      await metricValue("test_clickhouse_batch_writer_queue_rows", "events"),
    ).toBe(2);
    expect(
      await metricValue("test_clickhouse_batch_writer_queue_batches", "events"),
    ).toBe(1);
    expect(
      await metricValue("test_clickhouse_batch_writer_insert_attempts_total", "events"),
    ).toBe(1);
    expect(
      await metricValue("test_clickhouse_batch_writer_insert_errors_total", "events"),
    ).toBe(1);
    expect(
      await metricValue("test_clickhouse_batch_writer_rows_inserted_total", "events"),
    ).toBe(0);

    await vi.advanceTimersByTimeAsync(10);
    await flushing;

    expect(
      await metricValue("test_clickhouse_batch_writer_insert_attempts_total", "events"),
    ).toBe(2);
    expect(
      await metricValue("test_clickhouse_batch_writer_retries_total", "events"),
    ).toBe(1);
    expect(
      await metricValue("test_clickhouse_batch_writer_rows_inserted_total", "events"),
    ).toBe(2);
    expect(
      await metricValue("test_clickhouse_batch_writer_batches_succeeded_total", "events"),
    ).toBe(1);
    expect(
      await metricValue("test_clickhouse_batch_writer_queue_rows", "events"),
    ).toBe(0);
    expect(
      await metricValue("test_clickhouse_batch_writer_queue_batches", "events"),
    ).toBe(0);
    expect(
      await metricValue(
        "test_clickhouse_batch_writer_batch_size_rows",
        "events",
        "test_clickhouse_batch_writer_batch_size_rows_count",
      ),
    ).toBe(1);
    expect(
      await metricValue(
        "test_clickhouse_batch_writer_insert_duration_seconds",
        "events",
        "test_clickhouse_batch_writer_insert_duration_seconds_count",
      ),
    ).toBe(2);
    expect(
      await metricValue(
        "test_clickhouse_batch_writer_delivery_latency_seconds",
        "events",
        "test_clickhouse_batch_writer_delivery_latency_seconds_count",
      ),
    ).toBe(1);

    await moduleRef.close();
  });

  it("reuses collectors when multiple modules use the same prefix", async () => {
    insert.mockResolvedValue({
      executed: true,
      query_id: "success",
      response_headers: {},
    });

    const moduleRef = await Test.createTestingModule({
      imports: [
        ClickHouseBatchWriterModule.register<EventRow>({
          imports: [TestClientModule],
          clientToken: TEST_CLIENT,
          name: "events",
          insert: { table: "events", columns: ["id"] },
          prometheus: { client: prometheus, prefix: "shared_" },
        }),
        ClickHouseBatchWriterModule.register<EventRow>({
          imports: [TestClientModule],
          clientToken: TEST_CLIENT,
          name: "audit",
          insert: { table: "audit", columns: ["id"] },
          prometheus: { client: prometheus, prefix: "shared_" },
        }),
      ],
    }).compile();

    expect(await prometheus.register.getMetricsAsJSON()).toHaveLength(11);
    await moduleRef.close();
  });
});
