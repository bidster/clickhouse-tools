import { escapeTsvString } from './escape-tsv-string.js';
export function rawTsv(raw) {
    return { raw };
}
export class ClickHouseTsvRowEncoder {
    columns;
    format = 'TabSeparated';
    constructor(columns) {
        this.columns = columns;
    }
    encode(rows) {
        return rows
            .map((row) => this.columns
            .map((column) => this.encodeValue(row[column]))
            .join('\t'))
            .join('\n');
    }
    encodeValue(value) {
        if (value === null)
            return '\\N';
        if (typeof value === 'string')
            return escapeTsvString(value);
        if (typeof value === 'boolean')
            return String(value);
        if (typeof value === 'bigint')
            return String(value);
        if (typeof value === 'number') {
            if (!Number.isFinite(value)) {
                throw new TypeError('Non-finite numbers must be formatted before ClickHouseBatchWriter.write()');
            }
            return String(value);
        }
        if (value &&
            typeof value === 'object' &&
            'raw' in value &&
            typeof value.raw === 'string') {
            return value.raw;
        }
        const valueType = value === undefined
            ? 'undefined'
            : value && typeof value === 'object'
                ? value.constructor?.name ?? 'object'
                : typeof value;
        throw new TypeError(`${valueType} values must be formatted before ClickHouseBatchWriter.write()`);
    }
}
