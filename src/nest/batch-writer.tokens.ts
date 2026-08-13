import type { InjectionToken } from '@nestjs/common';

export function getClickHouseBatchWriterToken(
  name: string,
): InjectionToken {
  return `@bidster/clickhouse-tools:batch-writer:${name}`;
}
