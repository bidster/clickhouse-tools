import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommaSeparatedJsonCompactEachRowEncoder } from '../../src/index.js';
import { rawTsv } from '../../src/encoders/tsv-row-encoder.js';

describe(CommaSeparatedJsonCompactEachRowEncoder.name, () => {
  afterEach(() => vi.restoreAllMocks());

  it('encodes multiple rows in column order with commas between rows', () => {
    const encoder = new CommaSeparatedJsonCompactEachRowEncoder<{
      id: string;
      type: string;
      count: number;
    }>(['id', 'type', 'count']);

    expect(encoder.format).toBe('JSONCompactEachRow');
    expect(encoder.encode([
      { count: 1, type: 'session.start', id: 'uuid-1' },
      { count: 2, type: 'session.finish', id: 'uuid-2' },
    ])).toBe('["uuid-1","session.start",1],["uuid-2","session.finish",2]');
    expect(encoder.encode([])).toBe('');
  });

  it('supports all scalar types and preserves text including JSON-looking strings', () => {
    const encoder = new CommaSeparatedJsonCompactEachRowEncoder<{ value: unknown }>(['value']);
    const values = ['Привет 😀 "\\\t\n\r],[', '{"nested":[1,null]}', '', 0, -1.25, 1e100, true, false, null];
    const body = encoder.encode(values.map((value) => ({ value })));

    expect(JSON.parse(`[${body}]`)).toEqual(values.map((value) => [value]));
    expect(body).toContain(String.raw`\"\\\t\n\r],[`);
    expect(body).not.toContain('\n');
  });

  it('serializes the whole batch with exactly one JSON.stringify and no replacer', () => {
    const stringify = vi.spyOn(JSON, 'stringify');
    const encoder = new CommaSeparatedJsonCompactEachRowEncoder<{ value: unknown }>(['value']);

    const body = encoder.encode([{ value: 'first' }, { value: 2 }]);
    expect(stringify.mock.calls).toEqual([[[['first'], [2]]]]);
    expect(body).toBe('["first"],[2]');
  });

  it.each([
    ['undefined', undefined],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['bigint', 1n],
    ['object', {}],
    ['array', []],
    ['Date', new Date('2026-08-11T00:00:00Z')],
    ['function', () => 'value'],
    ['symbol', Symbol('value')],
    ['rawTsv', rawTsv('raw')],
    ['boxed string', new String('value')],
  ])('rejects %s before JSON serialization', (_, value) => {
    const stringify = vi.spyOn(JSON, 'stringify');
    const encoder = new CommaSeparatedJsonCompactEachRowEncoder<{ value: unknown }>(['value']);

    expect(() => encoder.encode([{ value: 'valid' }, { value }])).toThrow(TypeError);
    expect(stringify).not.toHaveBeenCalled();
  });

  it('never invokes toJSON on unsupported objects', () => {
    const toJSON = vi.fn(() => 'silently converted');
    const encoder = new CommaSeparatedJsonCompactEachRowEncoder<{ value: unknown }>(['value']);

    expect(() => encoder.encode([{ value: { toJSON } }])).toThrow(TypeError);
    expect(toJSON).not.toHaveBeenCalled();
  });
});
