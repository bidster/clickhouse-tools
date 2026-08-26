import type { ClickHouseClient } from "@clickhouse/client";
import {
  Logger,
  Module,
  type DynamicModule,
  type InjectionToken,
  type ModuleMetadata,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import {
  ClickHouseBatchWriter,
  type ClickHouseBatchWriterOptions,
} from "../batch-writer.js";
import { getClickHouseBatchWriterToken } from "./batch-writer.tokens.js";
import {
  ClickHouseBatchWriterPrometheusMetrics,
  type ClickHouseBatchWriterPrometheusOptions,
} from "./batch-writer.metrics.js";
import { CLICKHOUSE_CLIENT } from "./clickhouse.tokens.js";

type WriterConfiguration<T extends object> = Omit<
  ClickHouseBatchWriterOptions<T>,
  "client" | "logger" | "metrics"
>;

export interface ClickHouseBatchWriterDefinition<
  T extends object,
> extends WriterConfiguration<T> {
  name: string;
}

export interface ClickHouseBatchWriterRootOptions extends Pick<
  ModuleMetadata,
  "imports"
> {
  writers: ReadonlyArray<ClickHouseBatchWriterDefinition<any>>;
  clientToken?: InjectionToken;
  global?: boolean;
  prometheus?: ClickHouseBatchWriterPrometheusOptions;
}

export interface ClickHouseBatchWriterModuleOptions<T extends object>
  extends WriterConfiguration<T>, Pick<ModuleMetadata, "imports"> {
  name: string;
  clientToken?: InjectionToken;
  global?: boolean;
  prometheus?: ClickHouseBatchWriterPrometheusOptions;
}

export interface ClickHouseBatchWriterModuleAsyncOptions<
  T extends object,
> extends Pick<ModuleMetadata, "imports"> {
  name: string;
  clientToken?: InjectionToken;
  global?: boolean;
  prometheus?: ClickHouseBatchWriterPrometheusOptions;
  inject?: InjectionToken[];
  useFactory: (
    ...args: any[]
  ) => WriterConfiguration<T> | Promise<WriterConfiguration<T>>;
}

function createWriter<T extends object>(
  name: string,
  client: ClickHouseClient,
  configuration: WriterConfiguration<T>,
  prometheus?: ClickHouseBatchWriterPrometheusMetrics,
): ClickHouseBatchWriter<T> {
  const logger = new Logger(
    `ClickHouseBatchWriter:${configuration.insert.table}`,
  );

  return new ClickHouseBatchWriter({
    ...configuration,
    client,
    metrics: prometheus?.forWriter(name, configuration.insert.table),
    logger: {
      verbose: (message) => logger.verbose(message),
      warn: (message) => logger.warn(message),
      error: (message, error) => logger.error(message, error?.stack),
    },
  });
}

function createWriterLifecycle<T extends object>(
  writer: ClickHouseBatchWriter<T>,
): OnApplicationBootstrap & OnApplicationShutdown {
  return {
    onApplicationBootstrap: () => writer.open(),
    onApplicationShutdown: () => writer.close(),
  };
}

const CLICKHOUSE_BATCH_WRITER_REGISTRY = Symbol(
  "CLICKHOUSE_BATCH_WRITER_REGISTRY",
);

class ClickHouseBatchWriterRegistry
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly writers = new Map<string, ClickHouseBatchWriter<any>>();

  constructor(
    definitions: ReadonlyArray<ClickHouseBatchWriterDefinition<any>>,
    client: ClickHouseClient,
    prometheus?: ClickHouseBatchWriterPrometheusOptions,
  ) {
    const metrics = prometheus
      ? new ClickHouseBatchWriterPrometheusMetrics(prometheus)
      : undefined;
    definitions.forEach((definition) => {
      const { name, ...configuration } = definition;
      this.writers.set(
        name,
        createWriter(name, client, configuration, metrics),
      );
    });
  }

  get<T extends object>(name: string): ClickHouseBatchWriter<T> {
    const writer = this.writers.get(name);
    if (!writer) {
      throw new Error(`ClickHouse batch writer "${name}" is not registered`);
    }
    return writer as ClickHouseBatchWriter<T>;
  }

  onApplicationBootstrap(): void {
    this.writers.forEach((writer) => writer.open());
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all(
      [...this.writers.values()].map((writer) => writer.close()),
    );
  }
}

@Module({})
export class ClickHouseBatchWriterModule {
  static forRoot(options: ClickHouseBatchWriterRootOptions): DynamicModule {
    const names = new Set<string>();
    for (const writer of options.writers) {
      if (names.has(writer.name)) {
        throw new Error(
          `ClickHouse batch writer "${writer.name}" is configured more than once`,
        );
      }
      names.add(writer.name);
    }

    return {
      module: ClickHouseBatchWriterModule,
      global: options.global ?? true,
      imports: options.imports ?? [],
      providers: [
        {
          provide: CLICKHOUSE_BATCH_WRITER_REGISTRY,
          inject: [options.clientToken ?? CLICKHOUSE_CLIENT],
          useFactory: (client: ClickHouseClient) =>
            new ClickHouseBatchWriterRegistry(
              options.writers,
              client,
              options.prometheus,
            ),
        },
      ],
      exports: [CLICKHOUSE_BATCH_WRITER_REGISTRY],
    };
  }

  static forFeature(names: readonly string[]): DynamicModule {
    return {
      module: ClickHouseBatchWriterModule,
      providers: names.map((name) => ({
        provide: getClickHouseBatchWriterToken(name),
        inject: [CLICKHOUSE_BATCH_WRITER_REGISTRY],
        useFactory: (registry: ClickHouseBatchWriterRegistry) =>
          registry.get(name),
      })),
      exports: names.map(getClickHouseBatchWriterToken),
    };
  }

  static register<T extends object>(
    options: ClickHouseBatchWriterModuleOptions<T>,
  ): DynamicModule {
    const lifecycleToken = Symbol("CLICKHOUSE_BATCH_WRITER_LIFECYCLE");
    const {
      name,
      clientToken = CLICKHOUSE_CLIENT,
      global = false,
      imports = [],
      prometheus,
      ...configuration
    } = options;
    const writerToken = getClickHouseBatchWriterToken(name);

    return {
      module: ClickHouseBatchWriterModule,
      global,
      imports,
      providers: [
        {
          provide: writerToken,
          inject: [clientToken],
          useFactory: (client: ClickHouseClient) => {
            const metrics = prometheus
              ? new ClickHouseBatchWriterPrometheusMetrics(prometheus)
              : undefined;
            return createWriter(name, client, configuration, metrics);
          },
        },
        {
          provide: lifecycleToken,
          inject: [writerToken],
          useFactory: (writer: ClickHouseBatchWriter<T>) =>
            createWriterLifecycle(writer),
        },
      ],
      exports: [writerToken],
    };
  }

  static registerAsync<T extends object>(
    options: ClickHouseBatchWriterModuleAsyncOptions<T>,
  ): DynamicModule {
    const clientToken = options.clientToken ?? CLICKHOUSE_CLIENT;
    const writerToken = getClickHouseBatchWriterToken(options.name);
    const lifecycleToken = Symbol("CLICKHOUSE_BATCH_WRITER_LIFECYCLE");

    return {
      module: ClickHouseBatchWriterModule,
      global: options.global ?? false,
      imports: options.imports ?? [],
      providers: [
        {
          provide: writerToken,
          inject: [clientToken, ...(options.inject ?? [])],
          useFactory: async (client: ClickHouseClient, ...args: any[]) =>
            createWriter(
              options.name,
              client,
              await options.useFactory(...args),
              options.prometheus
                ? new ClickHouseBatchWriterPrometheusMetrics(
                    options.prometheus,
                  )
                : undefined,
            ),
        },
        {
          provide: lifecycleToken,
          inject: [writerToken],
          useFactory: (writer: ClickHouseBatchWriter<T>) =>
            createWriterLifecycle(writer),
        },
      ],
      exports: [writerToken],
    };
  }
}
