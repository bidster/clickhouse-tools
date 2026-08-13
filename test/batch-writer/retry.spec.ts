import type { ClickHouseClient } from '@clickhouse/client';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClickHouseBatchWriter } from '../../src/batch-writer.js';
import { ClickHouseTsvRowEncoder } from '../../src/encoders/tsv-row-encoder.js';
import {
  type EventRow,
  type Exec,
  type ExecResult,
  createLogger,
  createService,
  createSuccessfulExec,
  deferred,
  readBody,
  row,
} from './fixtures.js';

describe('ClickHouseBatchWriter retry', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('applies exponential backoff to the delivery loop and caps it', async () => {
    vi.useFakeTimers();
    const exec = vi
      .fn<Exec>()
      .mockRejectedValueOnce('offline')
      .mockRejectedValueOnce(new Error('still offline'))
      .mockRejectedValueOnce(new Error('still offline'))
      .mockResolvedValue({ stream: Readable.from([]) });
    const logger = createLogger();
    const service = createService(
      exec,
      { flushIntervalMs: 100, maxBatchSize: 1, maxRetryDelayMs: 250 },
      logger,
    );

    service.write([row(1)]);
    let flushCompleted = false;
    const flushing = service.flush().then(() => {
      flushCompleted = true;
    });

    await vi.advanceTimersByTimeAsync(99);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(flushCompleted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(exec).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(199);
    expect(exec).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(exec).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(249);
    expect(exec).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    await flushing;

    expect(exec).toHaveBeenCalledTimes(4);
    expect(flushCompleted).toBe(true);

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('delivery resumes in 100ms'),
      expect.any(Error),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('delivery resumes in 200ms'),
      expect.any(Error),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('delivery resumes in 250ms'),
      expect.any(Error),
    );

    await service.close();
  });

  it('retries a failed batch before later batches', async () => {
    const firstInsert = deferred<ExecResult>();
    const insertedBodies: string[] = [];
    const successfulInsert = createSuccessfulExec(insertedBodies);
    const exec = vi
      .fn<Exec>()
      .mockImplementationOnce(() => firstInsert.promise)
      .mockImplementation((params) => successfulInsert(params));
    const service = createService(exec, {
      flushIntervalMs: 10,
      maxBatchSize: 2,
    });

    service.write([row(0), row(1)]);
    service.write([row(2), row(3), row(4)]);
    firstInsert.reject(new Error('insert failed'));
    await service.flush();
    await service.close();

    expect(insertedBodies).toEqual([
      '0\t2026-08-11 10:00:00\n1\t2026-08-11 10:00:01',
      '2\t2026-08-11 10:00:02\n3\t2026-08-11 10:00:03\n4\t2026-08-11 10:00:04',
    ]);
  });

  it('preserves FIFO order across a retry', async () => {
    vi.useFakeTimers();
    const firstInsert = deferred<ExecResult>();
    const insertedBodies: string[] = [];
    const successfulInsert = createSuccessfulExec(insertedBodies);
    const exec = vi
      .fn<Exec>()
      .mockImplementationOnce(() => firstInsert.promise)
      .mockImplementation((params) => successfulInsert(params));
    const service = createService(exec, {
      flushIntervalMs: 100,
      maxBatchSize: 1,
      maxRetryDelayMs: 100,
    });

    service.write([row(0)]);
    service.write([row(1), row(2)]);
    const firstFlush = service.flush();
    firstInsert.reject(new Error('offline'));
    await vi.advanceTimersByTimeAsync(0);
    service.write([row(3)]);

    await vi.advanceTimersByTimeAsync(99);
    expect(exec).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(insertedBodies).toEqual([
      '0\t2026-08-11 10:00:00',
      '1\t2026-08-11 10:00:01\n2\t2026-08-11 10:00:02',
      '3\t2026-08-11 10:00:03',
    ]);
    await firstFlush;
    await service.close();
  });

  it('encodes a failed batch once and replays the same body on every retry', async () => {
    vi.useFakeTimers();
    const attemptedBodies: string[] = [];
    const insert = vi
      .fn<Exec>(async ({ values }) => {
        attemptedBodies.push(await readBody(values));
        if (attemptedBodies.length <= 3) throw new Error('offline');
      });
    const rowEncoder = new ClickHouseTsvRowEncoder<EventRow>([
      'id',
      'timestamp',
    ]);
    const encode = vi.spyOn(rowEncoder, 'encode');
    const service = new ClickHouseBatchWriter<EventRow>({
      client: { insert } as unknown as ClickHouseClient,
      insert: {
        table: 'custom_events',
        columns: ['id', 'timestamp'],
      },
      rowEncoder,
      maxBatchSize: 8,
      flushIntervalMs: 100,
      maxRetryDelayMs: 100,
    });

    const rows = [row(0), row(1), row(2), row(3), row(4), row(5), row(6)];
    service.write(rows);
    const flushing = service.flush();
    await vi.advanceTimersByTimeAsync(0);
    rows[0].id = 'mutated-after-first-attempt';
    await vi.advanceTimersByTimeAsync(300);
    await flushing;
    await service.close();

    expect(encode).toHaveBeenCalledOnce();
    expect(attemptedBodies).toHaveLength(4);
    expect(new Set(attemptedBodies)).toEqual(
      new Set([
        '0\t2026-08-11 10:00:00\n1\t2026-08-11 10:00:01\n2\t2026-08-11 10:00:02\n3\t2026-08-11 10:00:03\n4\t2026-08-11 10:00:04\n5\t2026-08-11 10:00:05\n6\t2026-08-11 10:00:06',
      ]),
    );
  });
});

