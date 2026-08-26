import type { ClickHouseBatchWriterMetrics } from "../batch-writer.js";

type PrometheusMetric = {
  labels(labels: Record<string, string>): {
    inc(value?: number): void;
    set(value: number): void;
    observe(value: number): void;
  };
};

type PrometheusMetricConstructor = new (configuration: any) => unknown;

export interface ClickHouseBatchWriterPrometheusClient {
  Counter: PrometheusMetricConstructor;
  Gauge: PrometheusMetricConstructor;
  Histogram: PrometheusMetricConstructor;
  register: {
    getSingleMetric(name: string): unknown;
  };
}

export interface ClickHouseBatchWriterPrometheusOptions {
  client: ClickHouseBatchWriterPrometheusClient;
  prefix?: string;
}

type MetricDefinition = {
  type: "Counter" | "Gauge" | "Histogram";
  name: string;
  help: string;
  buckets?: readonly number[];
};

const METRIC_DEFINITIONS = [
  {
    type: "Counter",
    name: "rows_accepted_total",
    help: "Rows accepted by ClickHouse batch writers.",
  },
  {
    type: "Counter",
    name: "rows_inserted_total",
    help: "Rows successfully inserted by ClickHouse batch writers.",
  },
  {
    type: "Gauge",
    name: "queue_rows",
    help: "Rows currently waiting for successful ClickHouse insertion.",
  },
  {
    type: "Gauge",
    name: "queue_batches",
    help: "Buffered and encoded batches waiting for successful ClickHouse insertion.",
  },
  {
    type: "Counter",
    name: "batches_succeeded_total",
    help: "Batches successfully inserted into ClickHouse.",
  },
  {
    type: "Counter",
    name: "insert_attempts_total",
    help: "ClickHouse insert attempts, including retries.",
  },
  {
    type: "Counter",
    name: "insert_errors_total",
    help: "Failed ClickHouse insert attempts.",
  },
  {
    type: "Counter",
    name: "retries_total",
    help: "ClickHouse insert retry attempts.",
  },
  {
    type: "Histogram",
    name: "batch_size_rows",
    help: "Number of rows in successfully inserted ClickHouse batches.",
    buckets: [
      1, 10, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 25_000,
      50_000, 100_000,
    ],
  },
  {
    type: "Histogram",
    name: "batch_fill_ratio",
    help: "Successful ClickHouse batch size divided by the configured maximum batch size.",
    buckets: [0.1, 0.25, 0.5, 0.75, 0.9, 1, 1.25, 1.5, 2, 5],
  },
  {
    type: "Gauge",
    name: "max_batch_size_rows",
    help: "Configured maximum batch size for ClickHouse batch writers.",
  },
  {
    type: "Histogram",
    name: "insert_duration_seconds",
    help: "Duration of ClickHouse insert attempts, including failed attempts.",
  },
  {
    type: "Histogram",
    name: "delivery_latency_seconds",
    help: "Time from accepting the oldest row in a batch until successful insertion.",
  },
] as const satisfies readonly MetricDefinition[];

export class ClickHouseBatchWriterPrometheusMetrics {
  private readonly metrics: Record<
    (typeof METRIC_DEFINITIONS)[number]["name"],
    PrometheusMetric
  >;

  constructor(options: ClickHouseBatchWriterPrometheusOptions) {
    this.metrics = Object.fromEntries(
      METRIC_DEFINITIONS.map((definition) => {
        const name = `${options.prefix ?? ""}clickhouse_batch_writer_${definition.name}`;
        const Metric = options.client[definition.type];
        return [
          definition.name,
          (options.client.register.getSingleMetric(name) ??
            new Metric({
              name,
              help: definition.help,
              labelNames: ["writer", "table"],
              registers: [options.client.register],
              ...("buckets" in definition
                ? { buckets: [...definition.buckets] }
                : {}),
            })) as unknown as PrometheusMetric,
        ];
      }),
    ) as ClickHouseBatchWriterPrometheusMetrics["metrics"];
  }

  forWriter(writer: string, table: string): ClickHouseBatchWriterMetrics {
    const labels = { writer, table };
    let maxBatchSize: number;
    const metric = (name: (typeof METRIC_DEFINITIONS)[number]["name"]) =>
      this.metrics[name].labels(labels);

    return {
      writerConfigured: (configuredMaxBatchSize) => {
        maxBatchSize = configuredMaxBatchSize;
        metric("max_batch_size_rows").set(configuredMaxBatchSize);
      },
      rowsAccepted: (count) => metric("rows_accepted_total").inc(count),
      insertAttempt: (retry) => {
        metric("insert_attempts_total").inc();
        if (retry) metric("retries_total").inc();
      },
      insertFailed: (durationSeconds) => {
        metric("insert_errors_total").inc();
        metric("insert_duration_seconds").observe(durationSeconds);
      },
      batchInserted: (
        rowCount,
        insertDurationSeconds,
        deliveryLatencySeconds,
      ) => {
        metric("rows_inserted_total").inc(rowCount);
        metric("batches_succeeded_total").inc();
        metric("batch_size_rows").observe(rowCount);
        metric("batch_fill_ratio").observe(rowCount / maxBatchSize);
        metric("insert_duration_seconds").observe(insertDurationSeconds);
        metric("delivery_latency_seconds").observe(deliveryLatencySeconds);
      },
      queueChanged: (rowCount, batchCount) => {
        metric("queue_rows").set(rowCount);
        metric("queue_batches").set(batchCount);
      },
    };
  }
}
