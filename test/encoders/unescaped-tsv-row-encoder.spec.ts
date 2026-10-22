import { describe, expect, it } from 'vitest';
import {
  TsvRowEncoder,
  UnescapedTsvRowEncoder,
  escapeTsvString,
  rawTsv,
} from '../../src/index.js';

describe(UnescapedTsvRowEncoder.name, () => {
  it('encodes rows in column order with TAB and LF separators', () => {
    const encoder = new UnescapedTsvRowEncoder<{ id: number; text: string }>(['text', 'id']);

    expect(encoder.format).toBe('TabSeparated');
    expect(encoder.encode([{ id: 1, text: 'one' }, { id: 2, text: 'two' }])).toBe('one\t1\ntwo\t2');
    expect(encoder.encode([])).toBe('');
  });

  it('preserves strings exactly, including unsafe TSV characters', () => {
    const encoder = new UnescapedTsvRowEncoder<{ value: string }>(['value']);
    const value = 'Привет 😀 "\\\t\n\r],[\\N';

    expect(encoder.encode([{ value }])).toBe(value);
  });

  it('supports finite numbers, bigints, booleans, null and empty strings', () => {
    const encoder = new UnescapedTsvRowEncoder<{ value: unknown }>(['value']);
    const values = ['', 0, -1.25, 1e100, 9007199254740993n, -42n, true, false, null];

    expect(encoder.encode(values.map((value) => ({ value })))).toBe(
      '\n0\n-1.25\n1e+100\n9007199254740993\n-42\ntrue\nfalse\n\\N',
    );
  });

  it.each([
    ['undefined', undefined],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['object', {}],
    ['array', []],
    ['Date', new Date('2026-08-11T00:00:00Z')],
    ['function', () => 'value'],
    ['symbol', Symbol('value')],
    ['rawTsv', rawTsv('raw')],
  ])('rejects %s', (_, value) => {
    const encoder = new UnescapedTsvRowEncoder<{ value: unknown }>(['value']);
    expect(() => encoder.encode([{ value }])).toThrow(TypeError);
  });
});

describe(escapeTsvString.name, () => {
  it.each([
    ['', ''],
    ['Привет 😀 "],[', 'Привет 😀 "],['],
    ['\\', String.raw`\\`],
    ['\t', String.raw`\t`],
    ['\n', String.raw`\n`],
    ['\r', String.raw`\r`],
    [String.raw`\N`, String.raw`\\N`],
    ['a\\b\tc\nd\r', String.raw`a\\b\tc\nd\r`],
  ])('escapes %j like the universal TSV encoder', (value, expected) => {
    expect(escapeTsvString(value)).toBe(expected);
    expect(new TsvRowEncoder<{ value: string }>(['value']).encode([{ value }])).toBe(expected);
    expect(new UnescapedTsvRowEncoder<{ value: string }>(['value']).encode([
      { value: escapeTsvString(value) },
    ])).toBe(expected);
  });

  it('is not idempotent and universal TSV escapes prepared strings again', () => {
    const prepared = escapeTsvString('\t');
    expect(prepared).toBe(String.raw`\t`);
    expect(escapeTsvString(prepared)).toBe(String.raw`\\t`);
    expect(new TsvRowEncoder<{ value: string }>(['value']).encode([
      { value: prepared },
    ])).toBe(String.raw`\\t`);
  });

  it.each([0, 1, 127, 128, 129, 1024])(
    'preserves clean Unicode strings of %i UTF-16 code units',
    (length) => {
      const value = '😀'.repeat(Math.floor(length / 2)) + 'я'.repeat(length % 2);
      expect(value.length).toBe(length);
      expect(escapeTsvString(value)).toBe(value);
    },
  );

  it.each([127, 128, 129, 1024])(
    'escapes special characters at the start, middle and end of a length-%i string',
    (length) => {
      const universal = new TsvRowEncoder<{ value: string }>(['value']);
      const unescaped = new UnescapedTsvRowEncoder<{ value: string }>(['value']);
      for (const [raw, escaped] of [
        ['\\', String.raw`\\`],
        ['\t', String.raw`\t`],
        ['\n', String.raw`\n`],
        ['\r', String.raw`\r`],
        [String.raw`\N`, String.raw`\\N`],
        [String.raw`\t\n\r`, String.raw`\\t\\n\\r`],
        ['\\\t\n\r', String.raw`\\\t\n\r`],
      ]) {
        for (const offset of [0, Math.floor((length - raw.length) / 2), length - raw.length]) {
          const prefix = 'я'.repeat(offset);
          const suffix = 'я'.repeat(length - raw.length - offset);
          const value = prefix + raw + suffix;
          const expected = prefix + escaped + suffix;
          expect(value.length).toBe(length);
          expect(escapeTsvString(value)).toBe(expected);
          expect(universal.encode([{ value }])).toBe(expected);
          expect(unescaped.encode([{ value: escapeTsvString(value) }])).toBe(expected);
        }
      }
    },
  );

  it.each([127, 128, 129, 1024])(
    'escapes dense special characters without re-escaping replacements at length %i',
    (length) => {
      const repetitions = Math.floor(length / 4);
      const suffix = 'x'.repeat(length % 4);
      const value = '\\\t\n\r'.repeat(repetitions) + suffix;
      const expected = String.raw`\\\t\n\r`.repeat(repetitions) + suffix;

      expect(value.length).toBe(length);
      expect(escapeTsvString(value)).toBe(expected);
    },
  );
});
