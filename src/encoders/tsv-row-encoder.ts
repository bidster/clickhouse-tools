import type { ClickHouseRowEncoder } from './row-encoder.interface.js';

export interface ClickHouseRawTsvValue {
  readonly raw: string;
}

export type ClickHouseTsvValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | ClickHouseRawTsvValue;

export function rawTsv(raw: string): ClickHouseRawTsvValue {
  return { raw };
}

export class ClickHouseTsvRowEncoder<T extends object>
  implements ClickHouseRowEncoder<T>
{
  readonly format = 'TabSeparated';

  constructor(private readonly columns: ReadonlyArray<keyof T & string>) {}

  encode(rows: readonly T[]): string {
    return rows
      .map((row) =>
        this.columns
          .map((column) => this.encodeValue(row[column]))
          .join('\t'),
      )
      .join('\n');
  }

  private encodeValue(value: unknown): string {
    if (value === null) return '\\N';
    if (typeof value === 'string') return this.escapeTsv(value);
    if (typeof value === 'boolean') return String(value);
    if (typeof value === 'bigint') return String(value);
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new TypeError(
          'Non-finite numbers must be formatted before ClickHouseBatchWriter.write()',
        );
      }
      return String(value);
    }
    if (
      value &&
      typeof value === 'object' &&
      'raw' in value &&
      typeof value.raw === 'string'
    ) {
      return value.raw;
    }

    const valueType =
      value === undefined
        ? 'undefined'
        : value && typeof value === 'object'
          ? value.constructor?.name ?? 'object'
          : typeof value;
    throw new TypeError(
      `${valueType} values must be formatted before ClickHouseBatchWriter.write()`,
    );
  }

  private escapeTsv(value: string): string {
    return value
      .replace(/\\/g, '\\\\')
      .replace(/\t/g, '\\t')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r');
  }
}
