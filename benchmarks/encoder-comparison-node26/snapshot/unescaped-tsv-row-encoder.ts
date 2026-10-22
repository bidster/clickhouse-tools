import type { ClickHouseRowEncoder } from './row-encoder.interface.js';

/** Strings must already be prepared for TSV; this encoder never escapes them. */
export class UnescapedTsvRowEncoder<T extends object>
  implements ClickHouseRowEncoder<T>
{
  readonly format = 'TabSeparated';

  constructor(private readonly columns: ReadonlyArray<keyof T & string>) {}

  encode(rows: readonly T[]): string {
    return rows
      .map((row) =>
        this.columns
          .map((column) => {
            const value = row[column];
            if (value === null) return '\\N';
            if (typeof value === 'string') return value;
            if (
              typeof value === 'boolean' ||
              typeof value === 'bigint' ||
              (typeof value === 'number' && Number.isFinite(value))
            ) {
              return String(value);
            }
            throw new TypeError(
              `Unsupported value for column ${column}: TabSeparated requires strings, finite numbers, bigints, booleans, or null`,
            );
          })
          .join('\t'),
      )
      .join('\n');
  }
}
