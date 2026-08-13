import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type Exec,
  createService,
  createSuccessfulExec,
  row,
} from './fixtures.js';

describe('ClickHouseBatchWriter shutdown', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('waits for the active flush and drains the remaining buffer on shutdown', async () => {
    const insertedBodies: string[] = [];
    const exec = createSuccessfulExec(insertedBodies);
    const service = createService(exec, { maxBatchSize: 2 });

    service.write([row(0), row(1), row(2), row(3), row(4)]);
    await service.close();

    expect(insertedBodies).toEqual([
      '0\t2026-08-11 10:00:00\n1\t2026-08-11 10:00:01\n2\t2026-08-11 10:00:02\n3\t2026-08-11 10:00:03\n4\t2026-08-11 10:00:04',
    ]);
  });

  it('retries failed inserts during shutdown', async () => {
    vi.useFakeTimers();
    const exec = vi
      .fn<Exec>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined);
    const service = createService(exec, {
      flushIntervalMs: 100,
      shutdownTimeoutMs: 1_000,
    });

    service.write([row(1), row(2)]);
    const closing = service.close();
    await vi.advanceTimersByTimeAsync(100);
    await closing;

    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('rejects shutdown after its timeout and reports remaining rows', async () => {
    vi.useFakeTimers();
    const exec = vi.fn<Exec>().mockRejectedValue(new Error('offline'));
    const service = createService(exec, {
      flushIntervalMs: 100,
      maxBatchSize: 10,
      shutdownTimeoutMs: 250,
    });

    service.write([row(1), row(2)]);
    const closing = service.close();
    const rejection = expect(closing).rejects.toThrow(
      'Timed out flushing custom_events queue during shutdown; 2 rows remain',
    );
    await vi.advanceTimersByTimeAsync(250);

    await rejection;
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('aborts an active insert when the shutdown timeout expires', async () => {
    vi.useFakeTimers();
    const exec = vi.fn<Exec>(
      ({ abort_signal }) =>
        new Promise((_, reject) =>
          abort_signal?.addEventListener('abort', () => reject(abort_signal.reason)),
        ),
    );
    const service = createService(exec, { shutdownTimeoutMs: 250 });

    service.write([row(1)]);
    const closing = service.close();
    const rejection = expect(closing).rejects.toThrow(
      'Timed out flushing custom_events queue during shutdown; 1 rows remain',
    );
    await vi.advanceTimersByTimeAsync(250);

    await rejection;
    expect(exec.mock.calls[0][0].abort_signal?.aborted).toBe(true);
  });
});

