import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('ClickHouseBatchWriter metrics', () => {
  const metrics = {
    writerConfigured: vi.fn(),
    rowsAccepted: vi.fn(),
    insertAttempt: vi.fn(),
    insertFailed: vi.fn(),
    batchInserted: vi.fn(),
    queueChanged: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    ['array', () => new ClickHouseArrayRowBuffer<EventRow>()],
    ['keyed', () => new KeyedSortBuffer<EventRow, ['id']>({ keys: ['id'] })],
  ] as const)('counts direct and writer additions once with a %s buffer', async (_, createBuffer) => {
    const buffer = createBuffer();
    const exec = createSuccessfulExec();
    const service = createService(exec, { buffer, metrics, maxBatchSize: 3 });

    buffer.add([row(0), row(1)]);
    expect(metrics.rowsAccepted.mock.calls).toEqual([[2]]);
    expect(metrics.queueChanged).toHaveBeenLastCalledWith(2, 1);
    expect(exec).not.toHaveBeenCalled();

    service.write([row(2)]);
    expect(metrics.rowsAccepted.mock.calls).toEqual([[2], [1]]);
    expect(metrics.queueChanged).toHaveBeenLastCalledWith(3, 1);
    await service.flush();
    expect(metrics.queueChanged).toHaveBeenLastCalledWith(0, 0);

    buffer.add([row(3)]);
    service.write([]);
    buffer.add([]);
    await service.close();
    service.write([row(4)]);
    buffer.add([row(5)]);
    expect(metrics.rowsAccepted.mock.calls).toEqual([[2], [1], [1]]);
    expect(metrics.batchInserted.mock.calls.map(([count]) => count)).toEqual([3, 1]);
    expect(metrics.queueChanged).toHaveBeenLastCalledWith(0, 0);
  });

  it('counts keyed tails before automatic delivery and preserves the oldest acceptance time', async () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
    const buffer = new KeyedSortBuffer<EventRow, ['id']>({ keys: ['id'] });
    const exec = createSuccessfulExec();
    const service = createService(exec, { buffer, metrics, maxBatchSize: 3 });

    buffer.addKeyed(['0'], { timestamp: 'zero' });
    now.mockReturnValue(2_000);
    service.write([row(1)]);
    now.mockReturnValue(3_000);
    buffer.addKeyed(['2'], { timestamp: 'two' });
    expect(metrics.rowsAccepted.mock.calls).toEqual([[1], [1], [1]]);
    expect(metrics.rowsAccepted.mock.invocationCallOrder[2]).toBeLessThan(
      exec.mock.invocationCallOrder[0]!,
    );

    now.mockReturnValue(4_000);
    await service.flush();
    expect(metrics.batchInserted).toHaveBeenLastCalledWith(3, 1, 3);
    expect(metrics.queueChanged).toHaveBeenLastCalledWith(0, 0);

    now.mockReturnValue(5_000);
    buffer.addKeyed(['3'], { timestamp: 'three' });
    now.mockReturnValue(7_000);
    await service.close();
    expect(metrics.rowsAccepted).toHaveBeenCalledTimes(4);
    expect(metrics.batchInserted).toHaveBeenLastCalledWith(1, 0, 2);
  });

  it('counts rows already buffered when the writer takes ownership', async () => {
    const buffer = new ClickHouseArrayRowBuffer<EventRow>();
    buffer.add([row(0), row(1)]);
    const service = createService(createSuccessfulExec(), { buffer, metrics });
    expect(metrics.rowsAccepted.mock.calls).toEqual([[2]]);
    expect(metrics.queueChanged).toHaveBeenLastCalledWith(2, 1);

    buffer.add([row(2)]);
    await service.close();
    expect(metrics.rowsAccepted.mock.calls).toEqual([[2], [1]]);
    expect(metrics.batchInserted).toHaveBeenCalledWith(3, expect.any(Number), expect.any(Number));
    expect(metrics.queueChanged).toHaveBeenLastCalledWith(0, 0);
  });

  it('keeps queued and in-flight rows counted through a retry and decrements on each acknowledgement', async () => {
    const firstInsert = deferred<ExecResult>();
    const retryInsert = deferred<ExecResult>();
    const secondInsert = deferred<ExecResult>();
    const exec = vi.fn<Exec>()
      .mockImplementationOnce(() => firstInsert.promise)
      .mockImplementationOnce(() => retryInsert.promise)
      .mockImplementationOnce(() => secondInsert.promise)
      .mockImplementation(async () => ({ stream: Readable.from([]) }));
    const service = createService(exec, { metrics, maxBatchSize: 2, flushIntervalMs: 100 });

    service.write([row(0), row(1)]);
    service.write([row(2), row(3), row(4)]);
    service.write([row(5)]);
    expect(metrics.queueChanged).toHaveBeenLastCalledWith(6, 3);
    expect(exec).toHaveBeenCalledTimes(1);

    firstInsert.reject(new Error('offline'));
    await vi.advanceTimersByTimeAsync(0);
    expect(metrics.queueChanged).toHaveBeenLastCalledWith(6, 3);
    await vi.advanceTimersByTimeAsync(100);
    expect(metrics.insertAttempt).toHaveBeenLastCalledWith(true);
    expect(metrics.queueChanged).toHaveBeenLastCalledWith(6, 3);

    retryInsert.resolve({ stream: Readable.from([]) });
    await vi.advanceTimersByTimeAsync(0);
    expect(exec).toHaveBeenCalledTimes(3);
    expect(metrics.queueChanged).toHaveBeenLastCalledWith(4, 2);

    secondInsert.resolve({ stream: Readable.from([]) });
    await service.flush();
    expect(metrics.queueChanged).toHaveBeenCalledWith(1, 1);
    expect(metrics.queueChanged).toHaveBeenLastCalledWith(0, 0);
    expect(metrics.batchInserted.mock.calls.map(([count]) => count)).toEqual([2, 3, 1]);
    await service.close();
  });

  it('does not leave discarded encoding failures in the queue count', async () => {
    const service = createService(createSuccessfulExec(), { metrics });
    service.write([{ ...row(0), timestamp: new Date() } as unknown as EventRow]);
    await expect(service.flush()).rejects.toThrow('Date values must be formatted');
    expect(metrics.queueChanged).toHaveBeenLastCalledWith(0, 0);

    service.write([row(1)]);
    expect(metrics.rowsAccepted.mock.calls).toEqual([[1], [1]]);
    expect(metrics.queueChanged).toHaveBeenLastCalledWith(1, 1);
    await service.close();
    expect(metrics.batchInserted).toHaveBeenCalledTimes(1);
    expect(metrics.queueChanged).toHaveBeenLastCalledWith(0, 0);
  });

  it('preserves queue metrics and acceptance time when sorting fails and flush is retried', async () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
    let shouldFail = true;
    const buffer = new KeyedSortBuffer<EventRow, ['id']>({
      keys: ['id'],
      comparators: [(left, right) => {
        if (shouldFail) throw new Error('sort failed');
        return left.localeCompare(right);
      }],
    });
    const service = createService(createSuccessfulExec(), { buffer, metrics });
    service.write([row(1), row(0)]);
    await expect(service.flush()).rejects.toThrow('sort failed');
    expect(buffer.size).toBe(2);
    expect(metrics.queueChanged).toHaveBeenLastCalledWith(2, 1);

    now.mockReturnValue(3_000);
    buffer.addKeyed(['2'], { timestamp: 'two' });
    expect(metrics.rowsAccepted.mock.calls).toEqual([[2], [1]]);
    expect(metrics.queueChanged).toHaveBeenLastCalledWith(3, 1);
    shouldFail = false;
    await service.close();
    expect(metrics.batchInserted).toHaveBeenLastCalledWith(3, 0, 2);
    expect(metrics.queueChanged).toHaveBeenLastCalledWith(0, 0);
  });
});
