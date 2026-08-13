import type { ClickHouseClient } from '@clickhouse/client';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClickHouseBatchWriter } from '../../src/batch-writer.js';
import { ClickHouseArrayRowBuffer } from '../../src/buffers/array-row-buffer.js';
import { KeyedSortBuffer } from '../../src/buffers/keyed-sort-buffer.js';
import {
  type EventRow,
  type Exec,
  type ExecResult,
  createService,
  createSuccessfulExec,
  deferred,
  row,
} from './fixtures.js';

describe('ClickHouseBatchWriter batching', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps the periodic flush alive after an empty tick', async () => {
    vi.useFakeTimers();
    const insertedBodies: string[] = [];
    const exec = createSuccessfulExec(insertedBodies);
    const service = createService(exec, {
      flushIntervalMs: 100,
      maxBatchSize: 10,
    });

    service.open();
    await vi.advanceTimersByTimeAsync(100);
    expect(exec).not.toHaveBeenCalled();

    service.write([row(1)]);
    await vi.advanceTimersByTimeAsync(99);
    expect(exec).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await service.flush();

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        table: 'custom_events',
        columns: ['id', 'timestamp'],
        format: 'TabSeparated',
      }),
    );
    expect(insertedBodies).toEqual(['1\t2026-08-11 10:00:01']);

    await service.close();
  });

  it('shares one insert between concurrent flush calls', async () => {
    const pendingExec = deferred<ExecResult>();
    const exec = vi.fn<Exec>((params) => {
      expect(params.values).toBeInstanceOf(Readable);
      return pendingExec.promise;
    });
    const service = createService(exec, { maxBatchSize: 10 });

    service.write([row(1)]);
    const firstFlush = service.flush();
    const secondFlush = service.flush();

    expect(exec).toHaveBeenCalledTimes(1);
    pendingExec.resolve(undefined);
    await Promise.all([firstFlush, secondFlush]);

    expect(exec).toHaveBeenCalledTimes(1);
    await service.close();
  });

  it('restarts the flush interval after a full batch', async () => {
    vi.useFakeTimers();
    const insertedBodies: string[] = [];
    const exec = createSuccessfulExec(insertedBodies);
    const service = createService(exec, {
      flushIntervalMs: 100,
      maxBatchSize: 2,
    });

    service.open();
    await vi.advanceTimersByTimeAsync(40);
    service.write([row(0), row(1)]);
    service.write([row(2)]);
    await vi.advanceTimersByTimeAsync(99);

    expect(exec).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);

    expect(exec).toHaveBeenCalledTimes(2);
    expect(insertedBodies).toEqual([
      '0\t2026-08-11 10:00:00\n1\t2026-08-11 10:00:01',
      '2\t2026-08-11 10:00:02',
    ]);
    await service.close();
  });

  it('writes rows added directly to the configured buffer', async () => {
    vi.useFakeTimers();
    const insertedBodies: string[] = [];
    const buffer = new ClickHouseArrayRowBuffer<EventRow>();
    const service = createService(createSuccessfulExec(insertedBodies), {
      buffer,
      flushIntervalMs: 100,
      maxBatchSize: 2,
    });

    service.open();
    buffer.add([row(0), row(1)]);
    await service.flush();

    expect(insertedBodies).toEqual([
      '0\t2026-08-11 10:00:00\n1\t2026-08-11 10:00:01',
    ]);

    buffer.add([row(2)]);
    await vi.advanceTimersByTimeAsync(100);

    expect(insertedBodies).toEqual([
      '0\t2026-08-11 10:00:00\n1\t2026-08-11 10:00:01',
      '2\t2026-08-11 10:00:02',
    ]);
    await service.close();
  });

  it('drains the entire buffer when the flush threshold is reached', async () => {
    const insertedBodies: string[] = [];
    const service = createService(createSuccessfulExec(insertedBodies), {
      maxBatchSize: 2,
    });

    service.write([row(0), row(1), row(2)]);
    await service.flush();

    expect(insertedBodies).toEqual([
      '0\t2026-08-11 10:00:00\n1\t2026-08-11 10:00:01\n2\t2026-08-11 10:00:02',
    ]);
    await service.close();
  });

  it('writes rows added through the keyed buffer API in key order', async () => {
    const insertedBodies: string[] = [];
    const buffer = new KeyedSortBuffer<EventRow, ['id']>({ keys: ['id'] });
    const service = createService(createSuccessfulExec(insertedBodies), {
      buffer,
      maxBatchSize: 3,
    });

    buffer.addKeyed(['2'], { timestamp: 'second' });
    buffer.addKeyed(['0'], { timestamp: 'zero' });
    buffer.addKeyed(['1'], { timestamp: 'first' });
    await service.flush();

    expect(insertedBodies).toEqual(['0\tzero\n1\tfirst\n2\tsecond']);
    await service.close();
  });

  it('flushes a full queued batch immediately after the active insert', async () => {
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
      maxBatchSize: 2,
    });

    service.write([row(0), row(1)]);
    service.write([row(2), row(3)]);
    firstInsert.resolve(undefined);
    await vi.advanceTimersByTimeAsync(0);

    expect(exec).toHaveBeenCalledTimes(2);
    expect(insertedBodies).toEqual([
      '2\t2026-08-11 10:00:02\n3\t2026-08-11 10:00:03',
    ]);
    await service.close();
  });

  it('uses the configured row encoder and ClickHouse settings', async () => {
    const insertedBodies: string[] = [];
    const exec = createSuccessfulExec(insertedBodies);
    const encode = vi.fn(() => 'custom encoded body');
    const service = new ClickHouseBatchWriter<EventRow>({
      client: { insert: exec } as unknown as ClickHouseClient,
      insert: {
        table: 'custom_events',
        columns: ['id', 'timestamp'],
        clickhouse_settings: {
          async_insert: 1,
          wait_for_async_insert: 1,
        },
      },
      rowEncoder: { format: 'CSV', encode },
    });

    const event = row(1);
    service.write([event]);
    await service.close();

    expect(encode).toHaveBeenCalledWith([event]);
    expect(exec.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        table: 'custom_events',
        columns: ['id', 'timestamp'],
        format: 'CSV',
        clickhouse_settings: {
          async_insert: 1,
          wait_for_async_insert: 1,
        },
      }),
    );
    expect(insertedBodies).toEqual(['custom encoded body']);
  });
});

