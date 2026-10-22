import { Readable } from "node:stream";
import type { ClickHouseClient } from "@clickhouse/client";
import { Inject, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { describe, expect, it, vi } from "vitest";
import { ClickHouseBatchWriter } from "../../src/batch-writer.js";
import { ClickHouseBatchWriterModule } from "../../src/nest/batch-writer.module.js";
import { getClickHouseBatchWriterToken } from "../../src/nest/batch-writer.tokens.js";
import { ClickHouseModule } from "../../src/nest/clickhouse.module.js";
import { CLICKHOUSE_CLIENT } from "../../src/nest/clickhouse.tokens.js";

type EventRow = { id: string; timestamp: string };

const EVENT_WRITER_NAME = "events";
const TEST_CLIENT = Symbol("TEST_CLIENT");
const EVENT_WRITER = getClickHouseBatchWriterToken(EVENT_WRITER_NAME);
const WRITER_CONFIGURATION = Symbol("WRITER_CONFIGURATION");
const CLIENT_LIFECYCLE = Symbol("CLIENT_LIFECYCLE");
const exec = vi.fn(async () => ({ stream: Readable.from([]), query_id: "test" }));
const shutdownOrder: string[] = [];

@Module({
  providers: [
    {
      provide: TEST_CLIENT,
      useValue: { exec } as unknown as ClickHouseClient,
    },
    {
      provide: CLIENT_LIFECYCLE,
      useValue: {
        onApplicationShutdown: () => shutdownOrder.push("client-close"),
      },
    },
  ],
  exports: [TEST_CLIENT],
})
class TestClientModule {}

describe(ClickHouseBatchWriterModule.name, () => {
  it("shares one root writer instance across feature modules", async () => {
    class FirstConsumer {
      constructor(
        @Inject(EVENT_WRITER) readonly writer: ClickHouseBatchWriter<EventRow>,
      ) {}
    }
    class SecondConsumer {
      constructor(
        @Inject(EVENT_WRITER) readonly writer: ClickHouseBatchWriter<EventRow>,
      ) {}
    }

    @Module({
      imports: [ClickHouseBatchWriterModule.forFeature([EVENT_WRITER_NAME])],
      providers: [FirstConsumer],
      exports: [FirstConsumer],
    })
    class FirstFeatureModule {}

    @Module({
      imports: [ClickHouseBatchWriterModule.forFeature([EVENT_WRITER_NAME])],
      providers: [SecondConsumer],
      exports: [SecondConsumer],
    })
    class SecondFeatureModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        ClickHouseBatchWriterModule.forRoot({
          imports: [TestClientModule],
          clientToken: TEST_CLIENT,
          writers: [
            {
              name: EVENT_WRITER_NAME,
              insert: {
                table: "events",
                columns: ["id", "timestamp"],
              },
            },
          ],
        }),
        FirstFeatureModule,
        SecondFeatureModule,
      ],
    }).compile();
    const first = moduleRef.get(FirstConsumer).writer;
    const second = moduleRef.get(SecondConsumer).writer;
    const open = vi.spyOn(first, "open");
    const close = vi.spyOn(first, "close");

    expect(first).toBe(second);
    await moduleRef.init();
    expect(open).toHaveBeenCalledOnce();

    await moduleRef.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects duplicate root writer names", () => {
    expect(() =>
      ClickHouseBatchWriterModule.forRoot({
        writers: [
          {
            name: EVENT_WRITER_NAME,
            insert: { table: "events", columns: ["id"] },
          },
          {
            name: EVENT_WRITER_NAME,
            insert: { table: "other_events", columns: ["id"] },
          },
        ],
      }),
    ).toThrow(
      `ClickHouse batch writer "${EVENT_WRITER_NAME}" is configured more than once`,
    );
  });

  it("flushes root writers before the global application client closes", async () => {
    const order: string[] = [];
    const moduleRef = await Test.createTestingModule({
      imports: [
        ClickHouseModule.forRoot({
          url: "http://127.0.0.1:8123",
          global: true,
        }),
        ClickHouseBatchWriterModule.forRoot({
          writers: [
            {
              name: EVENT_WRITER_NAME,
              insert: { table: "events", columns: ["id", "timestamp"] },
            },
          ],
        }),
        ClickHouseBatchWriterModule.forFeature([EVENT_WRITER_NAME]),
      ],
    }).compile();
    const client = moduleRef.get<ClickHouseClient>(CLICKHOUSE_CLIENT);
    vi.spyOn(client, "exec").mockImplementation(async () => {
      order.push("writer-flush");
      return { stream: Readable.from([]), query_id: "test", response_headers: {} };
    });
    vi.spyOn(client, "close").mockImplementation(async () => {
      order.push("client-close");
    });
    moduleRef
      .get<ClickHouseBatchWriter<EventRow>>(EVENT_WRITER)
      .write([{ id: "one", timestamp: "2026-08-11 10:00:00" }]);

    await moduleRef.close();

    expect(order).toEqual(["writer-flush", "client-close"]);
  });

  it("registers and exports a lifecycle-aware writer provider", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ClickHouseBatchWriterModule.register<EventRow>({
          imports: [TestClientModule],
          clientToken: TEST_CLIENT,
          name: EVENT_WRITER_NAME,
          insert: {
            table: "events",
            columns: ["id", "timestamp"],
          },
        }),
      ],
    }).compile();
    const writer = moduleRef.get<ClickHouseBatchWriter<EventRow>>(EVENT_WRITER);
    const open = vi.spyOn(writer, "open");
    const close = vi.spyOn(writer, "close");

    await moduleRef.init();
    writer.write([{ id: "one", timestamp: "2026-08-11 10:00:00" }]);
    await writer.flush();

    expect(writer).toBeInstanceOf(ClickHouseBatchWriter);
    expect(open).toHaveBeenCalledOnce();
    expect(exec).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "INSERT INTO events (id, timestamp) FORMAT TabSeparated",
      }),
    );

    await moduleRef.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("resolves async writer configuration through Nest injection", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ClickHouseBatchWriterModule.registerAsync<EventRow>({
          imports: [
            TestClientModule,
            {
              module: class WriterConfigurationModule {},
              providers: [
                {
                  provide: WRITER_CONFIGURATION,
                  useValue: {
                    insert: {
                      table: "async_events",
                      columns: ["id", "timestamp"],
                    },
                  },
                },
              ],
              exports: [WRITER_CONFIGURATION],
            },
          ],
          clientToken: TEST_CLIENT,
          name: EVENT_WRITER_NAME,
          inject: [WRITER_CONFIGURATION],
          useFactory: (configuration) => configuration,
        }),
      ],
    }).compile();

    expect(moduleRef.get(EVENT_WRITER)).toBeInstanceOf(ClickHouseBatchWriter);
    await moduleRef.close();
  });

  it("flushes the writer before its imported client module shuts down", async () => {
    shutdownOrder.length = 0;
    exec.mockImplementationOnce(async () => {
      shutdownOrder.push("writer-flush");
      return { stream: Readable.from([]), query_id: "test" };
    });
    const moduleRef = await Test.createTestingModule({
      imports: [
        ClickHouseBatchWriterModule.register<EventRow>({
          imports: [TestClientModule],
          clientToken: TEST_CLIENT,
          name: EVENT_WRITER_NAME,
          insert: {
            table: "events",
            columns: ["id", "timestamp"],
          },
        }),
      ],
    }).compile();
    const writer = moduleRef.get<ClickHouseBatchWriter<EventRow>>(EVENT_WRITER);
    writer.write([{ id: "one", timestamp: "2026-08-11 10:00:00" }]);

    await moduleRef.close();

    expect(shutdownOrder).toEqual(["writer-flush", "client-close"]);
  });
});
