import type { ClickHouseRowBuffer } from './row-buffer.interface.js';

type KeyName<T extends object> = keyof T & string;
type KeyNames<T extends object> = readonly [
  KeyName<T>,
  ...KeyName<T>[],
];

export type KeyedSortBufferKeyValues<
  T extends object,
  K extends KeyNames<T>,
> = Readonly<{
  [Index in keyof K]: K[Index] extends keyof T ? T[K[Index]] : never;
}>;

export type KeyedSortBufferTail<
  T extends object,
  K extends KeyNames<T>,
> = Omit<T, K[number]>;

type KeyComparator<Value> = (left: Value, right: Value) => number;

export type KeyedSortBufferComparators<
  T extends object,
  K extends KeyNames<T>,
> = {
  readonly [Index in keyof K]?: K[Index] extends keyof T
    ? KeyComparator<T[K[Index]]>
    : never;
};

export interface KeyedSortBufferOptions<
  T extends object,
  K extends KeyNames<T>,
> {
  keys: K;
  comparators?: KeyedSortBufferComparators<T, K>;
}

type BufferNode<Tail extends object> = Map<
  unknown,
  BufferNode<Tail> | Tail[]
>;

class KeyedTail<Tail extends object> {
  constructor(readonly tail: Tail) {}
}

type BufferedRow<T extends object, K extends KeyNames<T>> =
  | T
  | KeyedTail<KeyedSortBufferTail<T, K>>;

type DefaultKeyType = 'string' | 'number' | 'bigint' | 'boolean';

/** Groups rows by sorting keys, retaining complete rows by reference. */
export class KeyedSortBuffer<
  T extends object,
  const K extends KeyNames<T>,
> implements ClickHouseRowBuffer<T>
{
  private readonly keys: K;
  private readonly comparators: ReadonlyArray<
    KeyComparator<unknown> | undefined
  >;
  private root: BufferNode<BufferedRow<T, K>> = new Map();
  private defaultKeyTypes: Array<DefaultKeyType | undefined>;
  private readonly listeners = new Set<() => void>();
  private rowCount = 0;

  constructor(options: KeyedSortBufferOptions<T, K>) {
    if (options.keys.length === 0) {
      throw new Error('KeyedSortBuffer requires at least one sorting key');
    }
    if (new Set(options.keys).size !== options.keys.length) {
      throw new Error('KeyedSortBuffer keys must be unique');
    }

    this.keys = [...options.keys] as unknown as K;
    this.comparators = options.comparators
      ? [...options.comparators] as ReadonlyArray<
          KeyComparator<unknown> | undefined
        >
      : [];
    this.defaultKeyTypes = new Array(this.keys.length);
  }

  get size(): number {
    return this.rowCount;
  }

  add(rows: readonly T[]): void {
    if (rows.length === 0) return;

    for (const row of rows) {
      const keys = this.keys.map((key) => row[key]);
      this.store(keys, row);
    }

    for (const listener of this.listeners) listener();
  }

  addKeyed(
    keys: KeyedSortBufferKeyValues<T, K>,
    tail: KeyedSortBufferTail<T, K>,
  ): void {
    this.store(keys, new KeyedTail(tail));
    for (const listener of this.listeners) listener();
  }

  drain(): T[] {
    if (this.rowCount === 0) return [];

    const root = this.root;
    const rowCount = this.rowCount;
    const rows: T[] = [];
    const keys: unknown[] = new Array(this.keys.length);
    this.drainNode(root, 0, keys, rows);

    if (rows.length !== rowCount) {
      throw new Error('KeyedSortBuffer internal row count mismatch');
    }
    this.root = new Map();
    this.defaultKeyTypes = new Array(this.keys.length);
    this.rowCount = 0;
    return rows;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private store(
    keys: readonly unknown[],
    row: BufferedRow<T, K>,
  ): void {
    if (keys.length !== this.keys.length) {
      throw new RangeError(
        `Expected ${this.keys.length} sorting keys, received ${keys.length}`,
      );
    }

    let node = this.root;
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (!this.comparators[index]) {
        const keyType = typeof key;
        if (
          keyType !== 'string' &&
          keyType !== 'number' &&
          keyType !== 'bigint' &&
          keyType !== 'boolean'
        ) {
          throw new TypeError(
            `Sorting key ${this.keys[index]} requires a comparator for ${keyType} values`,
          );
        }
        if (keyType === 'number' && !Number.isFinite(key)) {
          throw new TypeError(
            `Sorting key ${this.keys[index]} must contain finite numbers`,
          );
        }
        if (
          this.defaultKeyTypes[index] &&
          this.defaultKeyTypes[index] !== keyType
        ) {
          throw new TypeError(
            `Sorting key ${this.keys[index]} cannot mix ${this.defaultKeyTypes[index]} and ${keyType} values`,
          );
        }
        this.defaultKeyTypes[index] = keyType;
      }

      const child = node.get(key);
      if (index === keys.length - 1) {
        if (child) {
          if (!Array.isArray(child)) {
            throw new Error('KeyedSortBuffer contains an invalid leaf');
          }
          child.push(row);
        } else {
          node.set(key, [row]);
        }
        continue;
      }

      if (child) {
        if (Array.isArray(child)) {
          throw new Error('KeyedSortBuffer contains an invalid branch');
        }
        node = child;
      } else {
        const branch: BufferNode<BufferedRow<T, K>> = new Map();
        node.set(key, branch);
        node = branch;
      }
    }

    this.rowCount += 1;
  }

  private drainNode(
    node: BufferNode<BufferedRow<T, K>>,
    depth: number,
    keys: unknown[],
    rows: T[],
  ): void {
    const entries = [...node.entries()].sort(([left], [right]) =>
      this.compareKeys(left, right, depth),
    );

    for (const [key, child] of entries) {
      keys[depth] = key;
      if (Array.isArray(child)) {
        for (const entry of child) {
          if (entry instanceof KeyedTail) {
            const row = { ...entry.tail } as Record<string, unknown>;
            for (let index = 0; index < this.keys.length; index += 1) {
              row[this.keys[index]!] = keys[index];
            }
            rows.push(row as T);
          } else {
            rows.push(entry);
          }
        }
      } else {
        this.drainNode(child, depth + 1, keys, rows);
      }
    }
  }

  private compareKeys(left: unknown, right: unknown, depth: number): number {
    const comparator = this.comparators[depth];
    if (comparator) {
      const result = comparator(left, right);
      if (!Number.isFinite(result)) {
        throw new TypeError(
          `Comparator for sorting key ${this.keys[depth]} must return a finite number`,
        );
      }
      return result;
    }

    if (left === right) return 0;
    if (typeof left === 'boolean' && typeof right === 'boolean') {
      return left ? 1 : -1;
    }
    if (
      (typeof left === 'string' && typeof right === 'string') ||
      (typeof left === 'number' && typeof right === 'number') ||
      (typeof left === 'bigint' && typeof right === 'bigint')
    ) {
      return left < right ? -1 : 1;
    }

    throw new TypeError(
      `Sorting key ${this.keys[depth]} contains incomparable values`,
    );
  }
}
