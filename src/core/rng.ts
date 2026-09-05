/**
 * Seedable PRNG (mulberry32) + hashing helpers.
 * No Math.random() anywhere in generation: same seed => same world.
 */

/** Turn an arbitrary string into a 32-bit unsigned integer seed. */
export function hashSeed(input: string | number): number {
  const str = String(input);
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/** mulberry32 — small, fast, good enough for level generation. */
export function mulberry32(a: number): () => number {
  let t = a >>> 0;
  return function next(): number {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), 1 | x);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A random source with convenience helpers.
 * `fork(tag)` gives an independent stream derived from this seed + tag, so
 * adding a generation step in one place cannot shift results elsewhere.
 */
export class Rng {
  readonly seed: number;
  private readonly _next: () => number;

  constructor(seed: string | number) {
    this.seed = typeof seed === 'number' ? seed >>> 0 : hashSeed(seed);
    this._next = mulberry32(this.seed);
  }

  /** float in [0,1) */
  next(): number {
    return this._next();
  }

  /** integer in [min, max] inclusive */
  int(min: number, max: number): number {
    return min + Math.floor(this._next() * (max - min + 1));
  }

  /** float in [min, max) */
  float(min: number, max: number): number {
    return min + this._next() * (max - min);
  }

  bool(p = 0.5): boolean {
    return this._next() < p;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this._next() * arr.length)];
  }

  /** Fisher-Yates, returns a new array. */
  shuffle<T>(arr: readonly T[]): T[] {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this._next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  /** Pick `n` distinct entries (or all of them if n >= length). */
  sample<T>(arr: readonly T[], n: number): T[] {
    return this.shuffle(arr).slice(0, Math.max(0, Math.min(n, arr.length)));
  }

  /** Independent derived stream. */
  fork(tag: string): Rng {
    return new Rng(hashSeed(`${this.seed}:${tag}`));
  }
}

const SEED_WORDS = [
  'lumen', 'givre', 'ombre', 'racine', 'ambre', 'silex', 'brume', 'cendre',
  'vasque', 'orage', 'dune', 'mousse', 'quartz', 'ravin', 'sylve', 'obsid',
] as const;

/** Human-readable random seed for the menu button (UI only, not generation). */
export function randomSeedString(): string {
  const r = mulberry32((Date.now() ^ (performance.now() * 1000)) >>> 0);
  const w1 = SEED_WORDS[Math.floor(r() * SEED_WORDS.length)];
  const w2 = SEED_WORDS[Math.floor(r() * SEED_WORDS.length)];
  const n = Math.floor(r() * 9000) + 1000;
  return `${w1}-${w2}-${n}`;
}
