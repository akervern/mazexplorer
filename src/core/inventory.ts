/** Inventory: counts per item id, with change notifications. */

import type { InventoryLike } from './types.js';

export class Inventory implements InventoryLike {
  counts: Record<string, number> = {};
  private listeners = new Set<() => void>();

  has(id: string, n = 1): boolean {
    return (this.counts[id] ?? 0) >= n;
  }

  add(id: string, n = 1): void {
    this.counts[id] = (this.counts[id] ?? 0) + n;
    this.emit();
  }

  remove(id: string, n = 1): void {
    const left = (this.counts[id] ?? 0) - n;
    if (left > 0) this.counts[id] = left;
    else delete this.counts[id];
    this.emit();
  }

  /** Item ids currently held, in insertion order. */
  ids(): string[] {
    return Object.keys(this.counts);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  toJSON(): Record<string, number> {
    return { ...this.counts };
  }

  static fromJSON(data: Record<string, number>): Inventory {
    const inv = new Inventory();
    inv.counts = { ...data };
    return inv;
  }
}
