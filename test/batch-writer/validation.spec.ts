import type { ClickHouseClient } from '@clickhouse/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClickHouseBatchWriter } from '../../src/batch-writer.js';
import { ClickHouseArrayRowBuffer } from '../../src/buffers/array-row-buffer.js';
import { rawTsv } from '../../src/encoders/tsv-row-encoder.js';
import {
  type EventRow,
  type VerboseRow,
  createService,
  createSuccessfulExec,
  row,
} from './fixtures.js';

describe('ClickHouseBatchWriter validation', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does nothing for an empty request, empty flush, or request after shutdown', async () => {
    vi.useFakeTimers();
    const exec = createSuccessfulExec();
    const service = createService(exec);

    service.write([]);
    await service.flush();
    await service.close();
    service.write([row(1)]);
    await service.flush();
    await vi.runAllTimersAsync();

    expect(exec).not.toHaveBeenCalled();
  });

  it('leaves rows added directly to an external buffer after shutdown', async () => {
    const buffer = new ClickHouseArrayRowBuffer<EventRow>();
    const exec = createSuccessfulExec();
    const service = createService(exec, { buffer });

    await service.close();
    buffer.add([row(1)]);
    await service.flush();

    expect(buffer.size).toBe(1);
    expect(exec).not.toHaveBeenCalled();
  });

  it('supports timer handles without unref', () => {
    const setTimeoutSpy = vi
      .spyOn(global, 'setTimeout')
      .mockReturnValue({} as NodeJS.Timeout);
    const service = createService(createSuccessfulExec());

    expect(() => service.open()).not.toThrow();
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1_000);
  });

  it.each([
    ['maxBatchSize', 0],
    ['maxBatchSize', 1.5],
    ['flushIntervalMs', 0],
    ['maxRetryDelayMs', Number.NaN],
    ['shutdownTimeoutMs', 2_147_483_648],
  ] as const)('rejects invalid %s value %s', (name, value) => {
    expect(() =>
      createService(createSuccessfulExec(), { [name]: value }),
    ).toThrow(name);
  });

  it('rejects an empty column list', () => {
    expect(
      () =>
        new ClickHouseBatchWriter<EventRow>({
          client: {
            insert: createSuccessfulExec(),
          } as unknown as ClickHouseClient,
          insert: {
            table: 'custom_events',
            columns: [],
          },
        }),
    ).toThrow('At least one ClickHouse insert column is required');
  });

  it('encodes scalar values and inserts preformatted complex values', async () => {
    const insertedBodies: string[] = [];
    const exec = createSuccessfulExec(insertedBodies);
    const service = new ClickHouseBatchWriter<VerboseRow>({
      client: { insert: exec } as unknown as ClickHouseClient,
      insert: {
        table: 'verbose_logs',
        columns: [
          'relation_key',
          'timestamp',
          'campaign_id',
          'placement_id',
          'request',
          'response',
          'error',
        ],
      },
    });
    const runtimeRow: VerboseRow = {
      relation_key: 'a\\b\tc\nd\r',
      timestamp: '2026-08-11 10:00:00.000',
      campaign_id: null,
      placement_id: null,
      request: rawTsv(String.raw`{'key':'value','nil':NULL}`),
      response: rawTsv(String.raw`{'alpha':'x\'y','nil':NULL}`),
      error: true,
    };

    service.write([runtimeRow]);
    await service.close();

    expect(insertedBodies).toEqual([
      [
        String.raw`a\\b\tc\nd\r`,
        '2026-08-11 10:00:00.000',
        String.raw`\N`,
        String.raw`\N`,
        String.raw`{'key':'value','nil':NULL}`,
        String.raw`{'alpha':'x\'y','nil':NULL}`,
        'true',
      ].join('\t'),
    ]);
  });

  it('rejects flush when pending rows cannot be encoded', async () => {
    const exec = createSuccessfulExec();
    const buffer = new ClickHouseArrayRowBuffer<EventRow>();
    const service = createService(exec, { buffer });
    const invalidRow = {
      ...row(0),
      timestamp: new Date(),
    } as unknown as EventRow;

    service.write([invalidRow]);
    await expect(service.flush()).rejects.toThrow(
      'Date values must be formatted before ClickHouseBatchWriter.write()',
    );
    expect(buffer.size).toBe(0);
    await expect(service.flush()).resolves.toBeUndefined();
    expect(exec).not.toHaveBeenCalled();
  });
});

