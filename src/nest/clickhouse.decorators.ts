import { Inject } from '@nestjs/common';
import { getClickHouseToken } from './clickhouse.tokens.js';

export function InjectClickHouse(
  name?: string,
): ReturnType<typeof Inject> {
  return Inject(getClickHouseToken(name));
}
