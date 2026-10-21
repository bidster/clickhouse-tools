import type { ClickHouseClient, ClickHouseSettings } from '@clickhouse/client';
import { Readable } from 'node:stream';
import { vi } from 'vitest';
import {
  ClickHouseBatchWriter,
  type ClickHouseBatchWriterOptions,
  type ClickHouseToolsLogger,
} from '../../src/batch-writer.js';
import type { ClickHouseRawTsvValue } from '../../src/encoders/tsv-row-encoder.js';

export type EventRow = {
  id: string;
  timestamp: string;
};

export type VerboseRow = {
  relation_key: string;
  timestamp: string;
  campaign_id: number | null;
  placement_id: null;
  request: ClickHouseRawTsvValue;
  response: ClickHouseRawTsvValue;
  error: boolean;
};

type ExecRequest = {
  table: string;
  columns: string[];
  format: string;
  values: Readable;
  abort_signal?: AbortSignal;
  clickhouse_settings?: ClickHouseSettings;
};

export type ExecResult = unknown;
export type Exec = (request: ExecRequest) => Promise<ExecResult>;
export type ExecMock = ReturnType<typeof vi.fn<Exec>>;

type ServiceOptions = Partial<
  Pick<
    ClickHouseBatchWriterOptions<EventRow>,
    | 'flushIntervalMs'
    | 'buffer'
    | 'maxBatchSize'
    | 'maxRetryDelayMs'
    | 'shutdownTimeoutMs'
    | 'metrics'
  >
>;

export async function readBody(values: Readable): Promise<string> {
  let body = '';
  for await (const chunk of values) body += chunk.toString();
  return body;
}

export function createSuccessfulExec(
  insertedBodies: string[] = [],
): ExecMock {
  return vi.fn<Exec>(async ({ values }) => {
    insertedBodies.push(await readBody(values));
    return { stream: Readable.from([]) };
  });
}

export function createLogger(): Required<ClickHouseToolsLogger> {
  return {
    verbose: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

export function createService(
  exec: ExecMock,
  options: ServiceOptions = {},
  logger: ClickHouseToolsLogger = createLogger(),
): ClickHouseBatchWriter<EventRow> {
  return new ClickHouseBatchWriter<EventRow>({
    client: { insert: exec } as unknown as ClickHouseClient,
    insert: {
      table: 'custom_events',
      columns: ['id', 'timestamp'],
    },
    logger,
    ...options,
  });
}

export function row(id: number): EventRow {
  return {
    id: String(id),
    timestamp: `2026-08-11 10:00:0${id}`,
  };
}

export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}
