import type { RawDataFormat } from '@clickhouse/client';

export type ClickHouseTextInsertFormat = Exclude<RawDataFormat, 'Parquet'>;

export interface ClickHouseRowEncoder<T extends object> {
  readonly format: ClickHouseTextInsertFormat;
  encode(rows: readonly T[]): string;
}
