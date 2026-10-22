import type { DataFormat } from '@clickhouse/client';

export type ClickHouseTextInsertFormat = Exclude<DataFormat, 'Parquet'>

export interface ClickHouseRowEncoder<T extends object> {
  readonly format: ClickHouseTextInsertFormat;
  encode(rows: readonly T[]): string;
}
