export class CommaSeparatedJsonCompactEachRowEncoder {
    columns;
    format = 'JSONCompactEachRow';
    constructor(columns) {
        this.columns = columns;
    }
    encode(rows) {
        const values = rows.map((row) => this.columns.map((column) => {
            const value = row[column];
            if (value === null ||
                typeof value === 'string' ||
                typeof value === 'boolean' ||
                (typeof value === 'number' && Number.isFinite(value))) {
                return value;
            }
            throw new TypeError(`Unsupported value for column ${column}: JSONCompactEachRow requires strings, finite numbers, booleans, or null`);
        }));
        return JSON.stringify(values).slice(1, -1);
    }
}
