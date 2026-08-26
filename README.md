# @bidster/clickhouse-tools

Open-source ClickHouse tools for TypeScript, Node.js, and NestJS applications.
The package contains only infrastructure-level code and intentionally has no
Bidster product-domain models, configuration, environment variable names, or
business rules.

## Installation

```sh
npm install @bidster/clickhouse-tools
```

NestJS support is optional. Install the Nest peer dependencies only when using
the `/nest` entry point.

## Vanilla TypeScript

```ts
import {
  ClickHouseArrayRowBuffer,
  ClickHouseBatchWriter,
  KeyedSortBuffer,
  rawTsv,
  type ClickHouseRawTsvValue,
} from "@bidster/clickhouse-tools";
import { createClient } from "@clickhouse/client";

type EventRow = {
  id: string;
  created_at: string;
  attributes: ClickHouseRawTsvValue;
};

const client = createClient({
  url: process.env.CLICKHOUSE_URL,
  username: process.env.CLICKHOUSE_USER,
  password: process.env.CLICKHOUSE_PASSWORD,
  database: process.env.CLICKHOUSE_DATABASE,
});

const eventBuffer = new ClickHouseArrayRowBuffer<EventRow>();

const events = new ClickHouseBatchWriter<EventRow>({
  client,
  buffer: eventBuffer,
  insert: {
    table: "events",
    columns: ["id", "created_at", "attributes"],
    clickhouse_settings: {
      insert_deduplicate: 1,
    },
  },
  logger: console,
});

events.open();
eventBuffer.add([
  {
    id: "event-1",
    created_at: "2026-08-11 10:00:00.000",
    attributes: rawTsv("{'source':'api'}"),
  },
]);

await events.close();
await client.close();
```

`buffer` is optional. Without it, the writer creates its own
`ClickHouseArrayRowBuffer`, which stores rows in insertion order. Calling
`writer.write(rows)` delegates to the configured buffer, so an application may
write through either `writer.write(rows)` or a retained buffer instance. A
custom buffer can expose additional insertion methods, but it must implement
the common `size`, `add`, `drain`, and `subscribe` contract. A buffer must have
only one active consumer because `drain()` removes its complete current
contents.

`KeyedSortBuffer` groups rows in nested maps by configured sorting columns. An
application can pass complete rows through `writer.write()` or avoid creating a
complete row by passing its sorting-key values and unsorted tail separately:

```ts
const sortedEventBuffer = new KeyedSortBuffer<EventRow, ["id", "created_at"]>({
  keys: ["id", "created_at"],
});

const sortedEvents = new ClickHouseBatchWriter<EventRow>({
  client,
  buffer: sortedEventBuffer,
  insert: {
    table: "events",
    columns: ["id", "created_at", "attributes"],
  },
});

sortedEventBuffer.addKeyed(["event-1", "2026-08-11 10:00:00.000"], {
  attributes: rawTsv("{'source':'api'}"),
});
```

Leaves store only tails; `drain()` sorts every key level and materializes the
complete rows. Rows with equal keys retain their insertion order. The default
ascending comparator supports strings, finite numbers, bigints, and booleans.
Other types require a comparator in the corresponding `comparators` tuple. A
custom comparator is also how an application defines descending or
ClickHouse-specific ordering.

`insert.table` and `insert.columns` form part of the INSERT query and must come
from trusted application configuration, not from user input.
Optional `insert.clickhouse_settings` are passed to every ClickHouse insert
request. They override client-level ClickHouse settings for that request.
The default TSV encoder handles strings, finite numbers, bigints, booleans, and
`null` (`\\N`). Strings receive TSV escaping; numbers, bigints, and booleans use
their string representation. Dates and schema-dependent values such as maps,
arrays, tuples, and objects must be formatted by the caller. Wrap their final
ClickHouse representation in `rawTsv()` to prevent additional escaping.

`ClickHouseBatchWriter` consumes the configured row buffer and owns encoding,
queueing, retries, and delivery. It uses
`ClickHouseTsvRowEncoder` with the `TabSeparated` format by default. A custom
`rowEncoder` owns both its text format and batch serialization while retaining
the same batching and retry behavior. JSON and binary formats are intentionally
outside this string-body encoder contract.

`maxBatchSize` is the threshold that triggers immediate draining; it is not a
hard batch-size limit. `drain()` atomically removes every row currently in the
buffer, so adding 25,000 rows with `maxBatchSize: 10_000` creates one 25,000-row
batch. Each threshold-triggered drain restarts the flush timer. When the timer
expires, any remaining rows are drained as one batch and the timer starts
again. Inserts are serialized; a batch accumulated during an active insert is
sent immediately after that insert completes.

Rows are encoded before their batch enters the delivery queue. Consequently,
an encoding error is reported directly by `write()`, `flush()`, or `close()`;
an automatic timer logs the error. Because the buffer has already been drained,
an encoding error discards that extracted batch. Once encoding succeeds, the
encoded body remains in the delivery queue, and only ClickHouse insert failures
participate in retry behavior.

`flush()` queues the current partial batch, restarts the timer, and waits until
the delivery queue is empty. If ClickHouse is unavailable, it remains pending
while the writer retries; it does not return after the first failed attempt.

## NestJS

```ts
import { Injectable, Module } from "@nestjs/common";
import { ClickHouseBatchWriter } from "@bidster/clickhouse-tools";
import {
  ClickHouseBatchWriterModule,
  ClickHouseModule,
  InjectClickHouseBatchWriter,
} from "@bidster/clickhouse-tools/nest";

const EVENT_WRITER_NAME = "events";

@Injectable()
class EventService {
  constructor(
    @InjectClickHouseBatchWriter(EVENT_WRITER_NAME)
    private readonly events: ClickHouseBatchWriter<EventRow>,
  ) {}

  track(row: EventRow) {
    this.events.write([row]);
  }
}

@Module({
  imports: [
    ClickHouseBatchWriterModule.register<EventRow>({
      imports: [
        ClickHouseModule.forRoot({
          url: "http://localhost:8123",
          database: "default",
          global: false,
        }),
      ],
      name: EVENT_WRITER_NAME,
      insert: {
        table: "events",
        columns: ["id", "created_at", "attributes"],
      },
    }),
  ],
  providers: [EventService],
})
export class AppModule {}
```

`ClickHouseBatchWriterModule` exports the writer under the token derived from
its `name`; no custom wrapper module or provider is required. Nest starts
periodic flushing and drains the queue during application shutdown. Use
`registerAsync` when the table or batch settings come from an injected
configuration service.

When one writer is consumed by multiple feature modules, register all shared
writers once with `forRoot()` and expose only the required names from each
feature with `forFeature()`. Every feature receives the same buffered writer
instance, and its lifecycle runs once:

```ts
@Module({
  imports: [
    ClickHouseModule.forRoot({ url: "http://localhost:8123" }),
    ClickHouseBatchWriterModule.forRoot({
      writers: [
        {
          name: "events",
          insert: { table: "events", columns: ["id", "created_at"] },
        },
      ],
    }),
  ],
})
class AppModule {}

@Module({
  imports: [ClickHouseBatchWriterModule.forFeature(["events"])],
  providers: [EventService],
})
class EventModule {}
```

Writer names passed to `forRoot()` must be unique. `forFeature()` fails during
provider resolution when it references a name absent from the root registry.

The batch writer uses the default `CLICKHOUSE_CLIENT` provider unless an
explicit `clientToken` is supplied. Inject the default client with
`@InjectClickHouse()`. For a named client, declare its token once and pass it to
the writer:

```ts
import type { ClickHouseClient } from "@clickhouse/client";
import {
  getClickHouseToken,
  InjectClickHouse,
} from "@bidster/clickhouse-tools/nest";

const ANALYTICS_CLIENT = getClickHouseToken("analytics");

ClickHouseModule.forRoot({ name: "analytics", url: "http://localhost:8123" });
ClickHouseBatchWriterModule.register({
  name: "events",
  clientToken: ANALYTICS_CLIENT,
  insert: { table: "events", columns: ["id"] },
});

class AnalyticsService {
  constructor(
    @InjectClickHouse("analytics")
    private readonly clickhouse: ClickHouseClient,
  ) {}
}
```

Use `getClickHouseToken(name)` for named clients created by `ClickHouseModule`.
Custom providers may pass any Nest `InjectionToken` through `clientToken`. Use
`getClickHouseBatchWriterToken(name)` when resolving a writer without the
injection decorator.

### Prometheus metrics

Prometheus support is optional. Install `prom-client` in the application and
pass its module namespace to `prometheus` when registering writers:

```ts
import * as prometheus from "prom-client";

ClickHouseBatchWriterModule.forRoot({
  prometheus: {
    client: prometheus,
    prefix: "service_",
  },
  writers: [
    {
      name: "events",
      insert: { table: "events", columns: ["id", "created_at"] },
    },
  ],
});
```

The same `prometheus` option is available to `register()` and
`registerAsync()`. The prefix is used verbatim; include a trailing underscore
when one is required. Every metric has `writer` and `table` labels:

| Metric suffix after `<prefix>clickhouse_batch_writer_` | Type | Meaning |
| --- | --- | --- |
| `rows_accepted_total` | Counter | Rows accepted by `write()` |
| `rows_inserted_total` | Counter | Rows acknowledged by successful inserts |
| `queue_rows` | Gauge | Buffered and encoded rows awaiting success |
| `queue_batches` | Gauge | Partial buffered and encoded batches awaiting success |
| `batches_succeeded_total` | Counter | Successfully inserted batches |
| `insert_attempts_total` | Counter | All insert attempts |
| `insert_errors_total` | Counter | Failed insert attempts |
| `retries_total` | Counter | Attempts after the initial attempt |
| `batch_size_rows` | Histogram | Rows per successful batch |
| `insert_duration_seconds` | Histogram | Duration of successful and failed attempts |
| `delivery_latency_seconds` | Histogram | Time from the oldest accepted row to batch success |

Metric collectors are reused from the supplied `prom-client` registry, so
multiple writer modules using the same prefix do not register them twice.
Queue gauges include a non-empty partial buffer and an in-flight batch, and
decrease only after ClickHouse has acknowledged the insert.

On insert failure, the batch remains at the head of the delivery queue. The
single delivery loop waits and retries it, preserving strict FIFO order. Its
delay doubles after consecutive failures up to `maxRetryDelayMs` and resets
after a successful insert. The flush timer continues moving new partial batches
into the delivery queue while that loop is waiting.

Every retry uses exactly the same encoded body and format so ClickHouse can
recognize the repeated block for deduplication. The writer does not discard
batches or impose a retry limit. During shutdown the queue follows the same
policy until it is drained or `shutdownTimeoutMs` expires (30 seconds by
default). On timeout the current insert or retry wait is aborted and `close()`
reports how many rows remain.

## Module compatibility

Both ESM (`import`) and CommonJS (`require`) builds are published. Vanilla
imports do not load NestJS; Nest integration lives in the explicit `/nest`
entry point.

## License

MIT
