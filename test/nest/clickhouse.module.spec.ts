import type { ClickHouseClient } from '@clickhouse/client';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { ClickHouseModule } from '../../src/nest/clickhouse.module.js';
import { getClickHouseToken } from '../../src/nest/clickhouse.tokens.js';

describe(ClickHouseModule.name, () => {
  it('registers default and named clients under generated tokens', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ClickHouseModule.forRoot({
          url: 'http://localhost:8123',
          global: false,
        }),
        ClickHouseModule.forRootAsync({
          name: 'analytics',
          global: false,
          useFactory: () => ({ url: 'http://localhost:8123' }),
        }),
      ],
    }).compile();
    const defaultClient = moduleRef.get<ClickHouseClient>(
      getClickHouseToken(),
    );
    const namedClient = moduleRef.get<ClickHouseClient>(
      getClickHouseToken('analytics'),
    );

    expect(defaultClient).toBeDefined();
    expect(namedClient).toBeDefined();
    expect(namedClient).not.toBe(defaultClient);

    await moduleRef.close();
  });
});
