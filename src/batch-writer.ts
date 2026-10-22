import type { ClickHouseClient, ClickHouseSettings } from '@clickhouse/client';
import { addAbortSignal, Readable } from 'node:stream';
import {
  TsvRowEncoder,
} from './encoders/tsv-row-encoder.js';
import type {
  ClickHouseRowEncoder,
  ClickHouseTextInsertFormat,
} from './encoders/row-encoder.interface.js';
import { ClickHouseArrayRowBuffer } from './buffers/array-row-buffer.js';
import type { ClickHouseRowBuffer } from './buffers/row-buffer.interface.js';

export interface ClickHouseToolsLogger {
  verbose?(message: string): void;
  warn?(message: string): void;
  error?(message: string, error?: Error): void;
}

export interface ClickHouseBatchWriterMetrics {
  writerConfigured(maxBatchSize: number): void;
  rowsAccepted(count: number): void;
  insertAttempt(retry: boolean): void;
  insertFailed(durationSeconds: number): void;
  batchInserted(
    rowCount: number,
    insertDurationSeconds: number,
    deliveryLatencySeconds: number,
  ): void;
  queueChanged(rowCount: number, batchCount: number): void;
}

export interface ClickHouseBatchWriterInsertOptions<T extends object> {
  table: string;
  columns: ReadonlyArray<keyof T & string>;
  clickhouse_settings?: ClickHouseSettings;
}

export interface ClickHouseBatchWriterOptions<T extends object> {
  client: ClickHouseClient;
  insert: ClickHouseBatchWriterInsertOptions<T>;
  buffer?: ClickHouseRowBuffer<T>;
  rowEncoder?: ClickHouseRowEncoder<T>;
  flushIntervalMs?: number;
  maxBatchSize?: number;
  maxRetryDelayMs?: number;
  shutdownTimeoutMs?: number;
  logger?: ClickHouseToolsLogger;
  metrics?: ClickHouseBatchWriterMetrics;
}

interface Batch {
  body: string;
  format: ClickHouseTextInsertFormat;
  rowCount: number;
  attempts: number;
  acceptedAt: number;
}

const MAXIMUM_TIMER_DELAY_MS = 2_147_483_647;

/** Buffers rows and writes batches to ClickHouse one at a time. */
export class ClickHouseBatchWriter<T extends object> {
  private readonly client: ClickHouseClient;
  private readonly insert: {
    table: string;
    columns: [keyof T & string, ...(keyof T & string)[]];
    clickhouse_settings?: ClickHouseSettings;
  };
  private readonly rowEncoder: ClickHouseRowEncoder<T>;
  private readonly buffer: ClickHouseRowBuffer<T>;
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;
  private readonly maxRetryDelayMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly logger?: ClickHouseToolsLogger;
  private readonly metrics?: ClickHouseBatchWriterMetrics;

  private deliveryQueue: Batch[] = [];
  private queuedRowCount = 0;
  private bufferedRowCount = 0;
  private readonly unsubscribeBuffer: () => void;
  private flushTimer?: NodeJS.Timeout;
  private delivery?: {
    task: Promise<void>;
    abortController: AbortController;
  };
  private closed = false;
  private bufferedRowsAcceptedAt?: number;

  constructor(options: ClickHouseBatchWriterOptions<T>) {
    if (options.insert.columns.length === 0) {
      throw new Error('At least one ClickHouse insert column is required');
    }

    const [firstColumn, ...remainingColumns] = options.insert.columns;
    this.client = options.client;
    this.insert = {
      table: options.insert.table,
      columns: [firstColumn!, ...remainingColumns],
      clickhouse_settings: options.insert.clickhouse_settings,
    };
    this.rowEncoder =
      options.rowEncoder ?? new TsvRowEncoder(this.insert.columns);
    this.buffer = options.buffer ?? new ClickHouseArrayRowBuffer<T>();
    this.flushIntervalMs = options.flushIntervalMs ?? 1_000;
    this.maxBatchSize = options.maxBatchSize ?? 10_000;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 30_000;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 30_000;
    this.logger = options.logger;
    this.metrics = options.metrics;

    if (!Number.isSafeInteger(this.maxBatchSize) || this.maxBatchSize <= 0) {
      throw new RangeError('maxBatchSize must be a positive safe integer');
    }
    for (const [name, value] of [
      ['flushIntervalMs', this.flushIntervalMs],
      ['maxRetryDelayMs', this.maxRetryDelayMs],
      ['shutdownTimeoutMs', this.shutdownTimeoutMs],
    ] as const) {
      if (
        !Number.isSafeInteger(value) ||
        value <= 0 ||
        value > MAXIMUM_TIMER_DELAY_MS
      ) {
        throw new RangeError(
          `${name} must be a positive integer no greater than ${MAXIMUM_TIMER_DELAY_MS}`,
        );
      }
    }

    this.metrics?.writerConfigured(this.maxBatchSize);
    this.bufferedRowCount = this.buffer.size;
    if (this.bufferedRowCount > 0) {
      this.bufferedRowsAcceptedAt = performance.now();
      this.metrics?.rowsAccepted(this.bufferedRowCount);
    }

    this.unsubscribeBuffer = this.buffer.subscribe(() => {
      if (this.closed) return;
      const addedRowCount = this.buffer.size - this.bufferedRowCount;
      this.bufferedRowCount = this.buffer.size;
      if (this.buffer.size > 0 && this.bufferedRowsAcceptedAt === undefined) {
        this.bufferedRowsAcceptedAt = performance.now();
      }
      if (addedRowCount > 0) this.metrics?.rowsAccepted(addedRowCount);
      this.metrics?.queueChanged(
        this.remainingRowCount,
        this.remainingBatchCount,
      );
      if (this.buffer.size < this.maxBatchSize) return;

      this.queueNextBatch();
      this.restartFlushTimer();
      void this.drainDeliveryQueue();
    });
    this.metrics?.queueChanged(this.remainingRowCount, this.remainingBatchCount);
  }

  open(): void {
    if (this.closed) {
      throw new Error(
        `Cannot reopen closed batch writer for ${this.insert.table}`,
      );
    }
    if (this.buffer.size >= this.maxBatchSize) {
      this.queueNextBatch();
      void this.drainDeliveryQueue();
    }
    this.restartFlushTimer();
  }

  write(rows: readonly T[]): void {
    if (this.closed || rows.length === 0) return;
    this.buffer.add(rows);
  }

  async flush(): Promise<void> {
    if (!this.closed) {
      this.queueNextBatch();
      this.restartFlushTimer();
    }
    await this.drainDeliveryQueue();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.unsubscribeBuffer();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.queueNextBatch();

    const delivery = this.drainDeliveryQueue();
    const shutdownTimer = setTimeout(
      () => this.delivery?.abortController.abort(),
      this.shutdownTimeoutMs,
    );

    try {
      await delivery;
    } finally {
      clearTimeout(shutdownTimer);
    }

    if (this.deliveryQueue.length > 0) {
      throw new Error(
        `Timed out flushing ${this.insert.table} queue during shutdown; ${this.remainingRowCount} rows remain`,
      );
    }
  }

  private queueNextBatch(): void {
    if (this.buffer.size === 0) return;
    const rows = this.buffer.drain();
    this.bufferedRowCount = 0;
    if (rows.length === 0) return;
    const acceptedAt = this.bufferedRowsAcceptedAt ?? performance.now();
    this.bufferedRowsAcceptedAt = undefined;
    try {
      this.deliveryQueue.push({
        body: this.rowEncoder.encode(rows),
        format: this.rowEncoder.format,
        rowCount: rows.length,
        attempts: 0,
        acceptedAt,
      });
      this.queuedRowCount += rows.length;
    } finally {
      this.metrics?.queueChanged(
        this.remainingRowCount,
        this.remainingBatchCount,
      );
    }
  }

  private drainDeliveryQueue(): Promise<void> {
    if (this.delivery) return this.delivery.task;
    if (this.deliveryQueue.length === 0) return Promise.resolve();

    const abortController = new AbortController();
    const task = this.deliverQueuedBatches(abortController.signal).finally(() => {
      this.delivery = undefined;
    });
    this.delivery = { task, abortController };
    return task;
  }

  private async deliverQueuedBatches(signal: AbortSignal): Promise<void> {
    let retryDelayMs = 0;

    while (this.deliveryQueue.length > 0 && !signal.aborted) {
      const batch = this.deliveryQueue[0]!;
      batch.attempts += 1;
      this.metrics?.insertAttempt(batch.attempts > 1);
      const insertStartedAt = performance.now();

      try {
        const { stream } = await this.client.exec({
          query: `INSERT INTO ${this.insert.table.trim()} (${this.insert.columns.join(', ')}) FORMAT ${batch.format}`,
          clickhouse_settings: this.insert.clickhouse_settings,
          abort_signal: signal,
          values: Readable.from([batch.body], { objectMode: false }),
        });
        // The client stops observing the external signal once exec() returns.
        for await (const chunk of addAbortSignal(signal, stream)) {
          void chunk;
        }
      } catch (cause) {
        this.metrics?.insertFailed(
          (performance.now() - insertStartedAt) / 1_000,
        );
        if (signal.aborted) return;
        retryDelayMs = Math.min(
          retryDelayMs === 0 ? this.flushIntervalMs : retryDelayMs * 2,
          this.maxRetryDelayMs,
        );
        const error = cause instanceof Error ? cause : new Error(String(cause));
        this.logger?.error?.(
          `Failed to insert ${batch.rowCount} rows into ${this.insert.table} on attempt ${batch.attempts}; queue size: ${this.remainingRowCount}; delivery resumes in ${retryDelayMs}ms`,
          error,
        );
        await this.waitForRetry(retryDelayMs, signal);
        continue;
      }

      this.deliveryQueue.shift();
      this.queuedRowCount -= batch.rowCount;
      this.metrics?.batchInserted(
        batch.rowCount,
        (performance.now() - insertStartedAt) / 1_000,
        (performance.now() - batch.acceptedAt) / 1_000,
      );
      this.metrics?.queueChanged(
        this.remainingRowCount,
        this.remainingBatchCount,
      );
      retryDelayMs = 0;
      this.logger?.verbose?.(
        `Inserted ${batch.rowCount} rows into ${this.insert.table}`,
      );
    }
  }

  private waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, delayMs);
      timer.unref?.();
      signal.addEventListener('abort', finish, { once: true });
    });
  }

  private restartFlushTimer(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.closed) {
      this.flushTimer = undefined;
      return;
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      try {
        this.queueNextBatch();
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        this.logger?.error?.(
          `Failed to encode rows for ${this.insert.table}; the drained batch was discarded`,
          error,
        );
      }
      void this.drainDeliveryQueue();
      this.restartFlushTimer();
    }, this.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  private get remainingRowCount(): number {
    return this.buffer.size + this.queuedRowCount;
  }

  private get remainingBatchCount(): number {
    return this.deliveryQueue.length + (this.buffer.size > 0 ? 1 : 0);
  }
}
