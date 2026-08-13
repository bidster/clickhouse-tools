import type { InjectionToken } from '@nestjs/common';

export const CLICKHOUSE_CLIENT = Symbol('CLICKHOUSE_CLIENT');

export function getClickHouseToken(name?: string): InjectionToken {
  return name === undefined
    ? CLICKHOUSE_CLIENT
    : `@bidster/clickhouse-tools:client:${name}`;
}
