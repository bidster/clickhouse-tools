import { PassThrough, Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type Exec,
  createLogger,
  createService,
  createSuccessfulExec,
  readBody,
  row,
} from './fixtures.js';

describe('ClickHouseBatchWriter response lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps the batch queued and blocks later batches until the response ends', async () => {
    vi.useFakeTimers();
    const response = new PassThrough();
    const batchInserted = vi.fn();
    const queueChanged = vi.fn();
    const exec = createSuccessfulExec().mockResolvedValueOnce({ stream: response });
    const service = createService(exec, {
      maxBatchSize: 1,
      metrics: {
        writerConfigured: vi.fn(), rowsAccepted: vi.fn(), insertAttempt: vi.fn(),
        insertFailed: vi.fn(), batchInserted, queueChanged,
      },
    });

    service.write([row(0)]);
    service.write([row(1)]);
    let flushed = false;
    const flushing = service.flush().then(() => { flushed = true; });
    response.write('partial response');
    await vi.advanceTimersByTimeAsync(0);

    expect(flushed).toBe(false);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(batchInserted).not.toHaveBeenCalled();
    expect(queueChanged).toHaveBeenLastCalledWith(2, 2);

    response.end('remaining response');
    await flushing;
    expect(response.readableEnded).toBe(true);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(batchInserted).toHaveBeenCalledTimes(2);
    expect(queueChanged).toHaveBeenLastCalledWith(0, 0);
    await service.close();
  });

  it('retries response read failures with a fresh request stream and the same body', async () => {
    vi.useFakeTimers();
    const response = new PassThrough();
    const bodies: string[] = [];
    const requests: Readable[] = [];
    const failure = new Error('response interrupted');
    const insertFailed = vi.fn();
    const batchInserted = vi.fn();
    const queueChanged = vi.fn();
    const logger = createLogger();
    const exec = vi.fn<Exec>(async ({ values }) => {
      requests.push(values);
      bodies.push(await readBody(values));
      return { stream: requests.length === 1 ? response : Readable.from(['done']) };
    });
    const service = createService(exec, {
      flushIntervalMs: 100,
      metrics: {
        writerConfigured: vi.fn(), rowsAccepted: vi.fn(), insertAttempt: vi.fn(),
        insertFailed, batchInserted, queueChanged,
      },
    }, logger);

    service.write([row(1)]);
    const flushing = service.flush();
    await vi.advanceTimersByTimeAsync(0);
    response.write('partial');
    response.destroy(failure);
    await vi.advanceTimersByTimeAsync(0);

    expect(insertFailed).toHaveBeenCalledTimes(1);
    expect(batchInserted).not.toHaveBeenCalled();
    expect(queueChanged).toHaveBeenLastCalledWith(1, 1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('attempt 1'), failure);
    await vi.advanceTimersByTimeAsync(100);
    await flushing;

    expect(bodies).toEqual(['1\t2026-08-11 10:00:01', '1\t2026-08-11 10:00:01']);
    expect(requests[0]).not.toBe(requests[1]);
    expect(requests.every((stream) => !stream.readableObjectMode)).toBe(true);
    expect(batchInserted).toHaveBeenCalledTimes(1);
    expect(queueChanged).toHaveBeenLastCalledWith(0, 0);
    await service.close();
  });

  it('aborts reading a response on shutdown timeout after exec has resolved', async () => {
    vi.useFakeTimers();
    const response = new PassThrough();
    const exec = vi.fn<Exec>().mockResolvedValue({ stream: response });
    const service = createService(exec, { shutdownTimeoutMs: 250 });
    service.write([row(1)]);

    const closing = service.close();
    const rejected = expect(closing).rejects.toThrow('1 rows remain');
    await vi.advanceTimersByTimeAsync(0);
    response.write('unfinished response');
    await vi.advanceTimersByTimeAsync(250);
    await rejected;

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][0].abort_signal?.aborted).toBe(true);
    expect(response.destroyed).toBe(true);
    expect(response.errored?.name).toBe('AbortError');
  });

  it('also aborts a response returned after the signal was already cancelled', async () => {
    vi.useFakeTimers();
    const response = new PassThrough();
    const exec = vi.fn<Exec>(({ abort_signal }) => new Promise((resolve) => {
      abort_signal!.addEventListener('abort', () => resolve({ stream: response }), { once: true });
    }));
    const service = createService(exec, { shutdownTimeoutMs: 250 });
    service.write([row(1)]);
    const closing = service.close();
    const rejected = expect(closing).rejects.toThrow('1 rows remain');

    await vi.advanceTimersByTimeAsync(250);
    await rejected;
    expect(response.destroyed).toBe(true);
    expect(response.errored?.name).toBe('AbortError');
  });
});
