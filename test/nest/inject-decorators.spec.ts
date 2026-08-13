import type { ClickHouseClient } from '@clickhouse/client';
import { Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import type { ClickHouseBatchWriter } from '../../src/batch-writer.js';
import { InjectClickHouseBatchWriter } from '../../src/nest/batch-writer.decorators.js';
import { getClickHouseBatchWriterToken } from '../../src/nest/batch-writer.tokens.js';
import { InjectClickHouse } from '../../src/nest/clickhouse.decorators.js';
import {
  CLICKHOUSE_CLIENT,
  getClickHouseToken,
} from '../../src/nest/clickhouse.tokens.js';

const TEST_CLIENT_NAME = 'test';
const TEST_WRITER_NAME = 'events';
const defaultClient = {} as ClickHouseClient;
const customClient = {} as ClickHouseClient;
const writer = {} as ClickHouseBatchWriter<{ id: string }>;

@Injectable()
class Consumer {
  constructor(
    @InjectClickHouse()
    readonly defaultClient: ClickHouseClient,
    @InjectClickHouse(TEST_CLIENT_NAME)
    readonly customClient: ClickHouseClient,
    @InjectClickHouseBatchWriter(TEST_WRITER_NAME)
    readonly writer: ClickHouseBatchWriter<{ id: string }>,
  ) {}
}

@Module({
  providers: [
    Consumer,
    { provide: CLICKHOUSE_CLIENT, useValue: defaultClient },
    { provide: getClickHouseToken(TEST_CLIENT_NAME), useValue: customClient },
    {
      provide: getClickHouseBatchWriterToken(TEST_WRITER_NAME),
      useValue: writer,
    },
  ],
})
class TestModule {}

describe('Nest inject decorators', () => {
  it('injects a ClickHouse client and batch writer by their tokens', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TestModule],
    }).compile();
    const consumer = moduleRef.get(Consumer);

    expect(consumer.defaultClient).toBe(defaultClient);
    expect(consumer.customClient).toBe(customClient);
    expect(consumer.writer).toBe(writer);

    await moduleRef.close();
  });
});
