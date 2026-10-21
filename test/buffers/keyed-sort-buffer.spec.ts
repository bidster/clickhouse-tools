import { describe, expect, it, vi } from 'vitest';
import { KeyedSortBuffer } from '../../src/buffers/keyed-sort-buffer.js';

type EventRow = {
  tenantId: string;
  createdAt: number;
  value: string;
};

describe(KeyedSortBuffer.name, () => {
  it('rejects an empty or duplicate sorting key list', () => {
    expect(
      () =>
        new KeyedSortBuffer<EventRow, ['tenantId']>({
          keys: [] as unknown as ['tenantId'],
        }),
    ).toThrow('at least one sorting key');
    expect(
      () =>
        new KeyedSortBuffer<
          EventRow,
          ['tenantId', 'tenantId']
        >({
          keys: ['tenantId', 'tenantId'],
        }),
    ).toThrow('keys must be unique');
  });

  it('sorts key levels and preserves insertion order within a leaf', () => {
    const buffer = new KeyedSortBuffer<
      EventRow,
      ['tenantId', 'createdAt']
    >({
      keys: ['tenantId', 'createdAt'],
    });

    buffer.addKeyed(['b', 2], { value: 'b2' });
    buffer.addKeyed(['a', 2], { value: 'a2-first' });
    buffer.addKeyed(['a', 1], { value: 'a1' });
    buffer.addKeyed(['a', 2], { value: 'a2-second' });

    expect(buffer.size).toBe(4);
    expect(buffer.drain()).toEqual([
      { tenantId: 'a', createdAt: 1, value: 'a1' },
      { tenantId: 'a', createdAt: 2, value: 'a2-first' },
      { tenantId: 'a', createdAt: 2, value: 'a2-second' },
      { tenantId: 'b', createdAt: 2, value: 'b2' },
    ]);
    expect(buffer.size).toBe(0);
  });

  it('accepts complete rows through the common buffer interface', () => {
    const buffer = new KeyedSortBuffer<EventRow, ['tenantId', 'createdAt']>({
      keys: ['tenantId', 'createdAt'],
    });

    buffer.add([
      { tenantId: 'b', createdAt: 1, value: 'b1' },
      { tenantId: 'a', createdAt: 2, value: 'a2' },
    ]);

    expect(buffer.drain()).toEqual([
      { tenantId: 'a', createdAt: 2, value: 'a2' },
      { tenantId: 'b', createdAt: 1, value: 'b1' },
    ]);
  });

  it('retains complete row references and sorts campaign groups stably', () => {
    type BidderRow = { campaign_id: string; value: number };
    const buffer = new KeyedSortBuffer<BidderRow, ['campaign_id']>({
      keys: ['campaign_id'],
    });
    const b = Object.freeze({ campaign_id: 'b', value: 1 });
    const aFirst = Object.freeze({ campaign_id: 'a', value: 2 });
    const aSecond = Object.freeze({ campaign_id: 'a', value: 3 });

    buffer.add([b, aFirst]);
    buffer.add([aSecond, b]);

    const rows = buffer.drain();
    expect(rows).toHaveLength(4);
    expect(rows[0]).toBe(aFirst);
    expect(rows[1]).toBe(aSecond);
    expect(rows[2]).toBe(b);
    expect(rows[3]).toBe(b);
    expect(buffer.size).toBe(0);
    expect(buffer.drain()).toEqual([]);

    buffer.add([aFirst]);
    expect(buffer.drain()[0]).toBe(aFirst);
  });

  it('preserves identity and insertion order when complete rows and keyed tails are mixed', () => {
    const buffer = new KeyedSortBuffer<EventRow, ['tenantId', 'createdAt']>({
      keys: ['tenantId', 'createdAt'],
    });
    const b = { tenantId: 'b', createdAt: 1, value: 'b' };
    const a = { tenantId: 'a', createdAt: 2, value: 'a' };
    const tail = { value: 'initial' };
    buffer.add([b, a]);
    buffer.addKeyed(['a', 1], { value: 'earlier' });
    buffer.addKeyed(['a', 2], tail);
    buffer.add([a]);
    tail.value = 'updated';

    const rows = buffer.drain();
    expect(rows).toEqual([
      { tenantId: 'a', createdAt: 1, value: 'earlier' },
      a,
      { tenantId: 'a', createdAt: 2, value: 'updated' },
      a,
      b,
    ]);
    expect(rows[1]).toBe(a);
    expect(rows[3]).toBe(a);
    expect(rows[4]).toBe(b);
    expect(tail).toEqual({ value: 'updated' });
  });

  it('supports a comparator for a non-scalar key', () => {
    type DateRow = { occurredAt: Date; value: string };
    const buffer = new KeyedSortBuffer<DateRow, ['occurredAt']>({
      keys: ['occurredAt'],
      comparators: [
        (left, right) => left.getTime() - right.getTime(),
      ],
    });
    const later = new Date('2026-08-12T11:00:00.000Z');
    const earlier = new Date('2026-08-12T10:00:00.000Z');

    buffer.addKeyed([later], { value: 'later' });
    buffer.addKeyed([earlier], { value: 'earlier' });

    expect(buffer.drain()).toEqual([
      { occurredAt: earlier, value: 'earlier' },
      { occurredAt: later, value: 'later' },
    ]);
  });

  it.each(['throw', 'NaN', 'Infinity'])(
    'retains all rows when a comparator fails with %s after visiting another branch',
    (failure) => {
      let shouldFail = true;
      const buffer = new KeyedSortBuffer<EventRow, ['tenantId', 'createdAt']>({
        keys: ['tenantId', 'createdAt'],
        comparators: [undefined, (left, right) => {
          if (shouldFail) {
            if (failure === 'throw') throw new Error('comparator failed');
            return Number(failure);
          }
          return left - right;
        }],
      });
      const first = { tenantId: 'a', createdAt: 0, value: 'first branch' };
      const last = { tenantId: 'b', createdAt: 2, value: 'last' };
      buffer.add([first, last]);
      buffer.addKeyed(['b', 1], { value: 'middle' });

      expect(() => buffer.drain()).toThrow(
        failure === 'throw' ? 'comparator failed' : 'must return a finite number',
      );
      expect(buffer.size).toBe(3);
      expect(() => buffer.drain()).toThrow();
      expect(buffer.size).toBe(3);

      shouldFail = false;
      const rows = buffer.drain();
      expect(rows).toEqual([
        first,
        { tenantId: 'b', createdAt: 1, value: 'middle' },
        last,
      ]);
      expect(rows[0]).toBe(first);
      expect(rows[2]).toBe(last);
      expect(buffer.size).toBe(0);
      expect(buffer.drain()).toEqual([]);
      buffer.add([first]);
      expect(buffer.drain()).toEqual([first]);
    },
  );

  it('retains rows when materializing a keyed tail throws', () => {
    const buffer = new KeyedSortBuffer<EventRow, ['tenantId', 'createdAt']>({
      keys: ['tenantId', 'createdAt'],
    });
    let shouldFail = true;
    buffer.addKeyed(['a', 1], {
      get value() {
        if (shouldFail) throw new Error('tail unavailable');
        return 'recovered';
      },
    });

    expect(() => buffer.drain()).toThrow('tail unavailable');
    expect(buffer.size).toBe(1);
    shouldFail = false;
    expect(buffer.drain()).toEqual([
      { tenantId: 'a', createdAt: 1, value: 'recovered' },
    ]);
    expect(buffer.size).toBe(0);
  });

  it('rejects unsupported default keys before storing the tail', () => {
    type ObjectKeyRow = { key: { id: number }; value: string };
    const buffer = new KeyedSortBuffer<ObjectKeyRow, ['key']>({
      keys: ['key'],
    });

    expect(() => buffer.addKeyed([{ id: 1 }], { value: 'one' })).toThrow(
      'Sorting key key requires a comparator for object values',
    );
    expect(buffer.size).toBe(0);
  });

  it('notifies subscribers once for each public addition', () => {
    const buffer = new KeyedSortBuffer<EventRow, ['tenantId']>({
      keys: ['tenantId'],
    });
    const listener = vi.fn();
    buffer.subscribe(listener);

    buffer.add([
      { tenantId: 'a', createdAt: 1, value: 'one' },
      { tenantId: 'b', createdAt: 2, value: 'two' },
    ]);
    buffer.addKeyed(['c'], { createdAt: 3, value: 'three' });

    expect(listener).toHaveBeenCalledTimes(2);
  });
});
