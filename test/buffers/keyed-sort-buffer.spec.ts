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
