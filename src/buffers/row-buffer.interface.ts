export interface ClickHouseRowBuffer<T extends object> {
  readonly size: number;

  add(rows: readonly T[]): void;
  /** Removes and returns every row currently stored in the buffer. */
  drain(): T[];
  /** Registers a listener that is called synchronously after rows are added. */
  subscribe(listener: () => void): () => void;
}
