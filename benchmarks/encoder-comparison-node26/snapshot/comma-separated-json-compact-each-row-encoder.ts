import type { ClickHouseRowEncoder } from './row-encoder.interface.js';

export class CommaSeparatedJsonCompactEachRowEncoder<T extends object>
  implements ClickHouseRowEncoder<T>
{
  readonly format = 'JSONCompactEachRow';

  constructor(private readonly columns: ReadonlyArray<keyof T & string>) {}

  encode(rows: readonly T[]): string {
    const values = rows.map((row) =>
      this.columns.map((column) => {
        const value = row[column];
        if (
          value === null ||
          typeof value === 'string' ||
          typeof value === 'boolean' ||
          (typeof value === 'number' && Number.isFinite(value))
        ) {
          return value;
        }
        throw new TypeError(
          `Unsupported value for column ${column}: JSONCompactEachRow requires strings, finite numbers, booleans, or null`,
        );
      }),
    );
    return JSON.stringify(values).slice(1, -1);
  }
}
