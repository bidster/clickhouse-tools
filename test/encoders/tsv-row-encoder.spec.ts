import { describe, expect, it } from 'vitest';
import {
  ClickHouseTsvRowEncoder,
  rawTsv,
  type ClickHouseRawTsvValue,
} from '../../src/encoders/tsv-row-encoder.js';

type Row = {
  scalar: string;
  nullable: null;
  integer: number;
  largeInteger: bigint;
  flag: boolean;
  raw: ClickHouseRawTsvValue;
};

describe(ClickHouseTsvRowEncoder.name, () => {
  it('encodes columns in their declared order', () => {
    const encoder = new ClickHouseTsvRowEncoder<Pick<Row, 'scalar' | 'nullable'>>([
      'nullable',
      'scalar',
    ]);

    expect(encoder.encode([{ scalar: 'value', nullable: null }])).toBe(
      '\\N\tvalue',
    );
  });

  it('encodes scalar values and passes raw TSV through unchanged', () => {
    const encoder = new ClickHouseTsvRowEncoder<Row>([
      'scalar',
      'nullable',
      'integer',
      'largeInteger',
      'flag',
      'raw',
    ]);

    expect(
      encoder.encode([
        {
          scalar: 'a\\b\tc\nd\r',
          nullable: null,
          integer: 42,
          largeInteger: 9_007_199_254_740_993n,
          flag: true,
          raw: rawTsv(String.raw`{'alpha':'x\'y','nil':NULL}`),
        },
      ]),
    ).toBe(
      [
        String.raw`a\\b\tc\nd\r`,
        String.raw`\N`,
        '42',
        '9007199254740993',
        'true',
        String.raw`{'alpha':'x\'y','nil':NULL}`,
      ].join('\t'),
    );
  });

  it.each([
    ['undefined', undefined],
    ['Date', new Date('2026-08-11T07:00:00.000Z')],
    ['Map', new Map()],
    ['Array', []],
    ['Object', { value: 'nested' }],
  ])('rejects %s values that require external formatting', (name, value) => {
    const encoder = new ClickHouseTsvRowEncoder<{ value: unknown }>(['value']);

    expect(() => encoder.encode([{ value }])).toThrow(
      `${name} values must be formatted before ClickHouseBatchWriter.write()`,
    );
  });

  it.each([NaN, Infinity, -Infinity])(
    'rejects the non-finite number %s',
    (value) => {
      const encoder = new ClickHouseTsvRowEncoder<{ value: number }>(['value']);

      expect(() => encoder.encode([{ value }])).toThrow(
        'Non-finite numbers must be formatted before ClickHouseBatchWriter.write()',
      );
    },
  );

  it('encodes an empty batch as an empty body', () => {
    const encoder = new ClickHouseTsvRowEncoder<Row>(['scalar']);

    expect(encoder.encode([])).toBe('');
  });
});
