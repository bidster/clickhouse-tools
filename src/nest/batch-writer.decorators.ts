import { Inject } from '@nestjs/common';
import { getClickHouseBatchWriterToken } from './batch-writer.tokens.js';

export function InjectClickHouseBatchWriter(
  name: string,
): ReturnType<typeof Inject> {
  return Inject(getClickHouseBatchWriterToken(name));
}
