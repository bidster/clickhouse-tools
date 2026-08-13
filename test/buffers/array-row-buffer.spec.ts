import { describe, expect, it, vi } from 'vitest';
import { ClickHouseArrayRowBuffer } from '../../src/buffers/array-row-buffer.js';

type Row = { id: number };

describe(ClickHouseArrayRowBuffer.name, () => {
  it('stores rows in insertion order and drains all of them', () => {
    const buffer = new ClickHouseArrayRowBuffer<Row>();

    buffer.add([{ id: 1 }, { id: 2 }]);
    buffer.add([{ id: 3 }]);

    expect(buffer.size).toBe(3);
    expect(buffer.drain()).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(buffer.size).toBe(0);
    expect(buffer.drain()).toEqual([]);
  });

  it('notifies subscribers after rows are added', () => {
    const buffer = new ClickHouseArrayRowBuffer<Row>();
    const listener = vi.fn();
    const unsubscribe = buffer.subscribe(listener);

    buffer.add([]);
    buffer.add([{ id: 1 }]);
    unsubscribe();
    buffer.add([{ id: 2 }]);

    expect(listener).toHaveBeenCalledOnce();
  });
});
