/**
 * Procedural pixel-art textures, drawn on a 2D canvas.
 * No external assets: keeps the build tiny and mobile-packaging simple.
 *
 * Two things fight the "same tile a hundred times" look:
 *
 * 1. **Variants.** Each texture name is drawn `VARIANTS` times from different
 *    seeds. The voxel batcher hashes a block's position to pick one, so a wall
 *    face is a mosaic of related-but-distinct tiles instead of one repeat.
 *    Cost is bounded: variants share a material *per variant*, so a biome wall
 *    is VARIANTS draw calls, not one per block.
 * 2. **Depth inside the tile.** Patterns layer multi-octave value noise, a
 *    soft directional gradient and sparse "features" (cracks, blotches,
 *    pebbles) so a single tile already has structure at two scales.
 *
 * Everything is seeded from `tex:<name>:<variant>` — no Math.random(), so the
 * same texture always looks the same across runs.
 */

import * as THREE from 'three';
import type { TextureName } from '../core/types.js';
import { mulberry32, hashSeed } from '../core/rng.js';

const SIZE = 32;

/**
 * How many distinct tiles are drawn per texture name.
 *
 * 4 is the point where a wall stops reading as a repeat; 8 costs twice the
 * draw calls for a difference you have to hunt for.
 */
export const VARIANTS = 4;

const cache = new Map<string, THREE.Texture>();

type Pattern =
  | 'noise'
  | 'bricks'
  | 'planks'
  | 'crystal'
  | 'vines'
  | 'tiles'
  | 'sand'
  | 'organic';

interface TexSpec {
  /** base color multiplier applied over the block tint */
  shades: number[];
  pattern: Pattern;
  /** density of the darkest speckles */
  speckle?: number;
  /** amplitude of the low-frequency cloud layer (0 = flat) */
  mottle?: number;
  /** sparse surface features: cracks, blotches, pebbles, tufts */
  detail?: 'cracks' | 'blotches' | 'pebbles' | 'tufts' | 'flecks' | 'none';
  /** how strongly the detail layer reads against the base */
  detailStrength?: number;
}

const SPECS: Record<TextureName, TexSpec> = {
  grass: { shades: [1.0, 0.92, 1.08, 0.86], pattern: 'organic', speckle: 0.35, mottle: 0.1, detail: 'tufts', detailStrength: 0.18 },
  leaves: { shades: [1.0, 0.85, 1.12, 0.78], pattern: 'organic', speckle: 0.45, mottle: 0.14, detail: 'blotches', detailStrength: 0.2 },
  wood: { shades: [1.0, 0.88, 1.06], pattern: 'planks', mottle: 0.06 },
  sand: { shades: [1.0, 0.95, 1.05, 0.9], pattern: 'sand', speckle: 0.22, mottle: 0.13, detail: 'flecks', detailStrength: 0.12 },
  sandstone: { shades: [1.0, 0.93, 1.04], pattern: 'bricks', mottle: 0.07, detail: 'cracks', detailStrength: 0.1 },
  snow: { shades: [1.0, 0.94, 1.04, 0.97], pattern: 'organic', speckle: 0.3, mottle: 0.14, detail: 'pebbles', detailStrength: 0.09 },
  ice: { shades: [1.0, 0.9, 1.14], pattern: 'crystal', mottle: 0.09, detail: 'cracks', detailStrength: 0.16 },
  gravel: { shades: [1.0, 0.82, 1.1, 0.74], pattern: 'noise', speckle: 0.5, mottle: 0.12, detail: 'pebbles', detailStrength: 0.22 },
  stone: { shades: [1.0, 0.9, 1.07, 0.84], pattern: 'noise', speckle: 0.3, mottle: 0.13, detail: 'cracks', detailStrength: 0.15 },
  crystal: { shades: [1.0, 1.25, 0.85], pattern: 'crystal', mottle: 0.1, detail: 'flecks', detailStrength: 0.2 },
  mud: { shades: [1.0, 0.86, 1.05, 0.8], pattern: 'organic', speckle: 0.42, mottle: 0.15, detail: 'blotches', detailStrength: 0.18 },
  vines: { shades: [1.0, 0.84, 1.1], pattern: 'vines', mottle: 0.12, detail: 'tufts', detailStrength: 0.16 },
  tiles: { shades: [1.0, 0.92, 1.05], pattern: 'tiles', mottle: 0.08, detail: 'cracks', detailStrength: 0.13 },
  bricks: { shades: [1.0, 0.88, 1.06], pattern: 'bricks', mottle: 0.09, detail: 'cracks', detailStrength: 0.14 },
  gold: { shades: [1.0, 1.2, 0.85], pattern: 'noise', speckle: 0.25, mottle: 0.1, detail: 'flecks', detailStrength: 0.22 },
  door: { shades: [1.0, 0.85, 1.1], pattern: 'planks', mottle: 0.05 },
  rubble: { shades: [1.0, 0.8, 1.12, 0.72], pattern: 'noise', speckle: 0.55, mottle: 0.14, detail: 'pebbles', detailStrength: 0.24 },
  pedestal: { shades: [1.0, 0.9, 1.08], pattern: 'tiles', mottle: 0.06, detail: 'cracks', detailStrength: 0.1 },
  gate: { shades: [1.0, 1.15, 0.88], pattern: 'crystal', mottle: 0.08 },
};

function shadeHex(base: number, mul: number): string {
  const r = Math.min(255, Math.round(((base >> 16) & 0xff) * mul));
  const g = Math.min(255, Math.round(((base >> 8) & 0xff) * mul));
  const b = Math.min(255, Math.round((base & 0xff) * mul));
  return `rgb(${r},${g},${b})`;
}

// ------------------------------------------------------------------ noise

/**
 * Tileable value noise on a `period x period` lattice.
 *
 * Wrapping the lattice indices is what keeps the texture seamless when it
 * repeats across a face — a plain hash noise would show a visible grid seam.
 */
function valueNoise(seed: number, period: number): (x: number, y: number) => number {
  const lattice = new Float32Array(period * period);
  const rand = mulberry32(seed);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rand();

  const at = (ix: number, iy: number) =>
    lattice[(((iy % period) + period) % period) * period + (((ix % period) + period) % period)];

  return (x: number, y: number) => {
    const gx = (x / SIZE) * period;
    const gy = (y / SIZE) * period;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const fx = gx - x0;
    const fy = gy - y0;
    // smoothstep keeps the interpolation from looking like a diamond grid
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const top = at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx;
    const bot = at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx;
    return top * (1 - sy) + bot * sy;
  };
}

/** Two octaves of tileable noise, centred on 0. */
function fbm(seed: number): (x: number, y: number) => number {
  const coarse = valueNoise(seed, 4);
  const fine = valueNoise(seed ^ 0x9e3779b9, 8);
  return (x, y) => coarse(x, y) * 0.66 + fine(x, y) * 0.34 - 0.5;
}

// ------------------------------------------------------------------ drawing

/** Per-pixel shade multipliers for one tile, drawn by the pattern functions. */
type Field = Float32Array;

function drawTexture(name: TextureName, color: number, variant: number): HTMLCanvasElement {
  const spec = SPECS[name];
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const seed = hashSeed(`tex:${name}:${variant}`);
  const rand = mulberry32(seed);

  const field: Field = new Float32Array(SIZE * SIZE).fill(spec.shades[0]);
  const set = (x: number, y: number, mul: number) => {
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
    field[y * SIZE + x] = mul;
  };
  const mulAt = (x: number, y: number, f: number) => {
    const i = (((y % SIZE) + SIZE) % SIZE) * SIZE + (((x % SIZE) + SIZE) % SIZE);
    field[i] *= f;
  };

  drawPattern(spec, field, set, rand, seed);

  // Low-frequency cloud layer: the single biggest win against tiling, because
  // it varies at a scale larger than the speckle the eye locks onto.
  if (spec.mottle) {
    const noise = fbm(seed ^ 0x51ed270b);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) field[y * SIZE + x] *= 1 + noise(x, y) * spec.mottle * 2;
    }
  }

  if (spec.detail && spec.detail !== 'none') {
    drawDetail(spec.detail, spec.detailStrength ?? 0.15, mulAt, rand);
  }

  // Soft directional gradient: gives the tile a light side, so adjacent copies
  // read as separate surfaces rather than one flat wash.
  const tiltX = rand() < 0.5 ? 1 : -1;
  const tiltY = rand() < 0.5 ? 1 : -1;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const g = ((x / SIZE) * tiltX + (y / SIZE) * tiltY) * 0.035;
      field[y * SIZE + x] *= 1 + g;
    }
  }

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      ctx.fillStyle = shadeHex(color, field[y * SIZE + x]);
      ctx.fillRect(x, y, 1, 1);
    }
  }
  return canvas;
}

function drawPattern(
  spec: TexSpec,
  field: Field,
  set: (x: number, y: number, mul: number) => void,
  rand: () => number,
  seed: number,
): void {
  const shade = (i: number) => spec.shades[i] ?? spec.shades[spec.shades.length - 1];

  switch (spec.pattern) {
    case 'noise':
    case 'sand': {
      const density = spec.speckle ?? 0.3;
      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
          if (rand() < density) set(x, y, shade(1 + Math.floor(rand() * (spec.shades.length - 1))));
        }
      }
      break;
    }

    // Grass, leaves, mud: speckle whose *density* follows a noise field, so
    // the tile grows patches instead of an even dusting.
    case 'organic': {
      const patch = fbm(seed ^ 0x2545f491);
      const density = spec.speckle ?? 0.35;
      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
          const local = density * (1 + patch(x, y) * 1.6);
          if (rand() < local) set(x, y, shade(1 + Math.floor(rand() * (spec.shades.length - 1))));
        }
      }
      break;
    }

    case 'bricks': {
      // Courses are staggered and the row height alternates, so a wall does
      // not resolve into one repeating band.
      const rowH = 8;
      const jitter = fbm(seed ^ 0x27d4eb2f);
      for (let y = 0; y < SIZE; y++) {
        const row = Math.floor(y / rowH);
        const offset = (row % 2) * 8;
        for (let x = 0; x < SIZE; x++) {
          const isMortar = y % rowH === 0 || (x + offset) % 16 === 0;
          set(x, y, isMortar ? shade(1) : shade(0) * (1 + jitter(x, y) * 0.12 + rand() * 0.04));
        }
      }
      break;
    }

    case 'planks': {
      const grainNoise = fbm(seed ^ 0x165667b1);
      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
          const seam = x % 16 === 0 || y % 32 === 0;
          // Grain follows the plank's long axis rather than scattering.
          const grain = grainNoise(x * 0.4, y * 3) > 0.12;
          set(x, y, seam ? shade(1) : grain ? shade(2) : shade(0) * (1 + rand() * 0.04));
        }
      }
      break;
    }

    case 'tiles': {
      const wear = fbm(seed ^ 0x85ebca6b);
      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
          const seam = x % 16 === 0 || y % 16 === 0;
          set(x, y, seam ? shade(1) : shade(0) * (1 + wear(x, y) * 0.16 + rand() * 0.03));
        }
      }
      break;
    }

    case 'crystal': {
      // Irregular facets, not a diagonal grid. The regular version resolved
      // into a checkerboard that read as a moiré pattern across a whole wall;
      // warping the facet coordinate by noise gives slabs of varying size and
      // angle instead, which is what ice and cut crystal actually look like.
      const warpA = valueNoise(seed ^ 0xc2b2ae35, 3);
      const warpB = valueNoise(seed ^ 0x1b873593, 3);
      const shimmer = fbm(seed ^ 0x27d4eb2f);
      const scale = 0.16 + rand() * 0.1;
      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
          const u = (x + warpA(x, y) * 14) * scale;
          const v = (y + warpB(x, y) * 14) * scale;
          // Two out-of-phase bands make wedges rather than squares.
          const f = Math.floor(u + v) + Math.floor(u - v * 0.6);
          const level = ((f % 3) + 3) % 3;
          const mul = level === 0 ? shade(0) : level === 1 ? shade(1) : shade(2);
          set(x, y, mul * (1 + shimmer(x, y) * 0.16));
        }
      }
      // A few bright cleavage lines along the facet boundaries.
      for (let i = 0; i < 3; i++) {
        let x = rand() * SIZE;
        let y = rand() * SIZE;
        const dx = rand() - 0.5;
        const dy = rand() - 0.5;
        for (let s = 0; s < SIZE; s++) {
          set(Math.floor(x) % SIZE, Math.floor(y) % SIZE, shade(0) * 1.16);
          x = (x + dx + SIZE) % SIZE;
          y = (y + dy + SIZE) % SIZE;
        }
      }
      break;
    }

    case 'vines': {
      const wash = fbm(seed ^ 0x7feb352d);
      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) set(x, y, shade(0) * (1 + wash(x, y) * 0.14));
      }
      const strands = 5 + Math.floor(rand() * 4);
      for (let i = 0; i < strands; i++) {
        let x = Math.floor(rand() * SIZE);
        const thick = rand() < 0.4 ? 2 : 1;
        for (let y = 0; y < SIZE; y++) {
          for (let t = 0; t <= thick; t++) set((x + t) % SIZE, y, shade(t === 0 ? 1 : 2));
          // Leaf nodes: a couple of pixels budding off the strand.
          if (rand() < 0.12) {
            const side = rand() < 0.5 ? -2 : thick + 2;
            set((x + side + SIZE) % SIZE, y, shade(2));
          }
          if (rand() < 0.3) x = (x + (rand() < 0.5 ? 1 : SIZE - 1)) % SIZE;
        }
      }
      break;
    }
  }
  void field;
}

/**
 * Sparse surface features drawn *over* the pattern as multipliers, so they
 * darken or lift whatever is underneath instead of flattening it.
 */
function drawDetail(
  kind: NonNullable<TexSpec['detail']>,
  strength: number,
  mulAt: (x: number, y: number, f: number) => void,
  rand: () => number,
): void {
  const dark = 1 - strength;
  const light = 1 + strength * 0.7;

  switch (kind) {
    case 'cracks': {
      // A crack is a short drunk walk; a couple per tile is enough to read.
      const count = 1 + Math.floor(rand() * 3);
      for (let i = 0; i < count; i++) {
        let x = Math.floor(rand() * SIZE);
        let y = Math.floor(rand() * SIZE);
        const len = 5 + Math.floor(rand() * 14);
        let dx = rand() < 0.5 ? 1 : -1;
        let dy = rand() < 0.5 ? 1 : -1;
        for (let s = 0; s < len; s++) {
          mulAt(x, y, dark);
          if (rand() < 0.25) mulAt(x + 1, y, dark + strength * 0.5);
          if (rand() < 0.3) dy = -dy;
          if (rand() < 0.2) dx = -dx;
          x += rand() < 0.7 ? dx : 0;
          y += rand() < 0.7 ? dy : 0;
        }
      }
      break;
    }

    case 'blotches': {
      const count = 2 + Math.floor(rand() * 4);
      for (let i = 0; i < count; i++) {
        const cx = rand() * SIZE;
        const cy = rand() * SIZE;
        const r = 2 + rand() * 4;
        const f = rand() < 0.5 ? dark : light;
        for (let y = Math.floor(cy - r); y <= cy + r; y++) {
          for (let x = Math.floor(cx - r); x <= cx + r; x++) {
            const d = Math.hypot(x - cx, y - cy);
            if (d <= r && rand() < 1 - d / r + 0.25) mulAt(x, y, f);
          }
        }
      }
      break;
    }

    case 'pebbles': {
      const count = 4 + Math.floor(rand() * 6);
      for (let i = 0; i < count; i++) {
        const cx = Math.floor(rand() * SIZE);
        const cy = Math.floor(rand() * SIZE);
        const w = 2 + Math.floor(rand() * 3);
        const h = 2 + Math.floor(rand() * 3);
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            // Lit top edge, shadowed bottom: gives the blob a fake volume.
            mulAt(cx + x, cy + y, y === 0 ? light : y === h - 1 ? dark : 1 + strength * 0.2);
          }
        }
      }
      break;
    }

    case 'tufts': {
      const count = 5 + Math.floor(rand() * 7);
      for (let i = 0; i < count; i++) {
        const cx = Math.floor(rand() * SIZE);
        const cy = Math.floor(rand() * SIZE);
        const h = 2 + Math.floor(rand() * 3);
        const lean = rand() < 0.5 ? 0 : rand() < 0.5 ? 1 : -1;
        for (let s = 0; s < h; s++) {
          mulAt(cx + Math.round(lean * (s / h)), cy - s, s === h - 1 ? light : dark);
        }
      }
      break;
    }

    case 'flecks': {
      const count = 6 + Math.floor(rand() * 10);
      for (let i = 0; i < count; i++) {
        mulAt(Math.floor(rand() * SIZE), Math.floor(rand() * SIZE), rand() < 0.5 ? light : dark);
      }
      break;
    }
  }
}

/**
 * Cached three.js texture for a (name, tint, variant) triple.
 * `variant` is taken modulo VARIANTS, so callers can pass any hash.
 */
export function getTexture(name: TextureName, color: number, variant = 0): THREE.Texture {
  const v = ((variant % VARIANTS) + VARIANTS) % VARIANTS;
  const key = `${name}:${color}:${v}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const tex = new THREE.CanvasTexture(drawTexture(name, color, v));
  tex.magFilter = THREE.NearestFilter; // crisp pixels, Minecraft style
  tex.minFilter = THREE.NearestMipmapLinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  cache.set(key, tex);
  return tex;
}

/** Small emoji/text sprite used for item pickups and signposts. */
export function makeLabelTexture(text: string, bg = 'rgba(20,22,30,0.85)'): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 128, 128);
  ctx.font = '84px system-ui, "Apple Color Emoji", "Noto Color Emoji", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 64, 70);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function disposeTextures(): void {
  for (const t of cache.values()) t.dispose();
  cache.clear();
}
