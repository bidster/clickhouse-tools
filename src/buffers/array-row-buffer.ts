import type { ClickHouseRowBuffer } from './row-buffer.interface.js';

/** Stores rows in insertion order in an array. */
export class ClickHouseArrayRowBuffer<T extends object>
  implements ClickHouseRowBuffer<T>
{
  private readonly rows: T[] = [];
  private readonly listeners = new Set<() => void>();

  get size(): number {
    return this.rows.length;
  }

  add(rows: readonly T[]): void {
    if (rows.length === 0) return;

    this.rows.push(...rows);
    for (const listener of this.listeners) listener();
  }

  drain(): T[] {
    return this.rows.splice(0);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
