import { createClient } from '@clickhouse/client';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createGunzip, gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import {
  ClickHouseBatchWriter,
  TsvRowEncoder,
  CommaSeparatedJsonCompactEachRowEncoder,
  UnescapedTsvRowEncoder,
  escapeTsvString,
} from '../../src/index.js';
import { readBody } from './fixtures.js';

describe('ClickHouseBatchWriter with the real JS client and local HTTP server', () => {
  it.each([
    ['default TSV', false], ['default TSV', true],
    ['unescaped TSV', false], ['unescaped TSV', true],
    ['compact JSON', false], ['compact JSON', true],
  ] as const)('sends %s unchanged, retries HTTP errors, and respects compression=%s', async (kind, compressed) => {
    const requests: Array<{ url: URL; body: string; authorization?: string; encoding?: string }> = [];
    const server = createServer(async (request, response) => {
      const body = await readBody(request.headers['content-encoding'] === 'gzip'
        ? request.pipe(createGunzip()) : request);
      requests.push({
        url: new URL(request.url!, 'http://localhost'),
        body,
        authorization: request.headers.authorization,
        encoding: request.headers['content-encoding'],
      });
      // Fail the first attempt so the real client must report the HTTP error.
      response.statusCode = requests.length === 1 ? 500 : 200;
      if (compressed) response.setHeader('Content-Encoding', 'gzip');
      const reply = requests.length === 1 ? 'temporary failure' : 'complete';
      response.end(compressed ? gzipSync(reply) : reply);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const client = createClient({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      username: 'test-user',
      password: 'test-password',
      compression: { request: compressed, response: compressed },
    });
    type Row = { id: string; data: string };
    const columns = ['id', 'data'] as const;
    const rowEncoder = kind === 'compact JSON'
      ? new CommaSeparatedJsonCompactEachRowEncoder<Row>(columns)
      : kind === 'unescaped TSV' ? new UnescapedTsvRowEncoder<Row>(columns) : undefined;
    const data = 'Юникод 😀 "\\\t\n\r],[ {"json":true}';
    const rows = [
      { id: 'uuid-1', data: kind === 'unescaped TSV' ? escapeTsvString(data) : data },
      { id: 'uuid-2', data: '' },
    ];
    const expected = (rowEncoder ?? new TsvRowEncoder<Row>(columns)).encode(rows);
    const exec = vi.spyOn(client, 'exec');
    const insert = vi.spyOn(client, 'insert');
    const encode = rowEncoder ? vi.spyOn(rowEncoder, 'encode') : undefined;
    const writer = new ClickHouseBatchWriter<Row>({
      client,
      insert: { table: ' test_events ', columns, clickhouse_settings: { async_insert: 1, wait_for_async_insert: 1 } },
      rowEncoder,
      flushIntervalMs: 10,
      shutdownTimeoutMs: 1_000,
    });

    try {
      writer.write(rows);
      await writer.close();
      expect(insert).not.toHaveBeenCalled();
      expect(exec).toHaveBeenCalledTimes(2);
      if (encode) expect(encode).toHaveBeenCalledTimes(1);
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.body).toBe(expected);
        expect(request.url.searchParams.get('query')).toBe(
          `INSERT INTO test_events (id, data) FORMAT ${rowEncoder?.format ?? 'TabSeparated'}`,
        );
        expect(request.url.searchParams.get('async_insert')).toBe('1');
        expect(request.url.searchParams.get('wait_for_async_insert')).toBe('1');
        expect(request.authorization).toBe(`Basic ${Buffer.from('test-user:test-password').toString('base64')}`);
        expect(request.encoding).toBe(compressed ? 'gzip' : undefined);
      }
      expect(exec.mock.calls[0][0].abort_signal).toBeInstanceOf(AbortSignal);
      expect(exec.mock.calls[0][0]).toHaveProperty('values');
    } finally {
      await client.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
