/**
 * Procedural pixel-art textures, drawn on a 2D canvas.
 * No external assets: keeps the build tiny and mobile-packaging simple.
 *
 * Each texture is a 16x16 tile drawn with a seeded noise pattern so the same
 * texture name always looks the same across runs.
 */

import * as THREE from 'three';
import type { TextureName } from '../core/types.js';
import { mulberry32, hashSeed } from '../core/rng.js';

const SIZE = 16;
const cache = new Map<string, THREE.Texture>();

interface TexSpec {
  /** base color multiplier applied over the block tint */
  shades: number[];
  /** 'noise' scatters shades; 'bricks'/'planks' draw structure */
  pattern: 'noise' | 'bricks' | 'planks' | 'crystal' | 'vines' | 'tiles' | 'sand';
  /** density of the darkest speckles */
  speckle?: number;
}

const SPECS: Record<TextureName, TexSpec> = {
  grass: { shades: [1.0, 0.92, 1.08, 0.86], pattern: 'noise', speckle: 0.35 },
  leaves: { shades: [1.0, 0.85, 1.12, 0.78], pattern: 'noise', speckle: 0.45 },
  wood: { shades: [1.0, 0.88, 1.06], pattern: 'planks' },
  sand: { shades: [1.0, 0.95, 1.05, 0.9], pattern: 'sand', speckle: 0.2 },
  sandstone: { shades: [1.0, 0.93, 1.04], pattern: 'bricks' },
  snow: { shades: [1.0, 0.96, 1.03], pattern: 'noise', speckle: 0.12 },
  ice: { shades: [1.0, 0.9, 1.14], pattern: 'crystal' },
  gravel: { shades: [1.0, 0.82, 1.1, 0.74], pattern: 'noise', speckle: 0.5 },
  stone: { shades: [1.0, 0.9, 1.07, 0.84], pattern: 'noise', speckle: 0.3 },
  crystal: { shades: [1.0, 1.25, 0.85], pattern: 'crystal' },
  mud: { shades: [1.0, 0.86, 1.05, 0.8], pattern: 'noise', speckle: 0.42 },
  vines: { shades: [1.0, 0.84, 1.1], pattern: 'vines' },
  tiles: { shades: [1.0, 0.92, 1.05], pattern: 'tiles' },
  bricks: { shades: [1.0, 0.88, 1.06], pattern: 'bricks' },
  gold: { shades: [1.0, 1.2, 0.85], pattern: 'noise', speckle: 0.25 },
  door: { shades: [1.0, 0.85, 1.1], pattern: 'planks' },
  rubble: { shades: [1.0, 0.8, 1.12, 0.72], pattern: 'noise', speckle: 0.55 },
  pedestal: { shades: [1.0, 0.9, 1.08], pattern: 'tiles' },
  gate: { shades: [1.0, 1.15, 0.88], pattern: 'crystal' },
};

function shadeHex(base: number, mul: number): string {
  const r = Math.min(255, Math.round(((base >> 16) & 0xff) * mul));
  const g = Math.min(255, Math.round(((base >> 8) & 0xff) * mul));
  const b = Math.min(255, Math.round((base & 0xff) * mul));
  return `rgb(${r},${g},${b})`;
}

function drawTexture(name: TextureName, color: number): HTMLCanvasElement {
  const spec = SPECS[name];
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;
  const rand = mulberry32(hashSeed(`tex:${name}`));

  // base fill
  ctx.fillStyle = shadeHex(color, spec.shades[0]);
  ctx.fillRect(0, 0, SIZE, SIZE);

  const px = (x: number, y: number, mul: number) => {
    ctx.fillStyle = shadeHex(color, mul);
    ctx.fillRect(x, y, 1, 1);
  };

  switch (spec.pattern) {
    case 'noise':
    case 'sand': {
      const density = spec.speckle ?? 0.3;
      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
          if (rand() < density) px(x, y, spec.shades[1 + Math.floor(rand() * (spec.shades.length - 1))]);
        }
      }
      break;
    }
    case 'bricks': {
      const rowH = 4;
      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
          const row = Math.floor(y / rowH);
          const offset = (row % 2) * 4;
          const isMortar = y % rowH === 0 || (x + offset) % 8 === 0;
          px(x, y, isMortar ? spec.shades[1] : spec.shades[0] * (0.97 + rand() * 0.06));
        }
      }
      break;
    }
    case 'planks': {
      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
          const seam = x % 8 === 0 || y % 16 === 0;
          const grain = rand() < 0.18;
          px(x, y, seam ? spec.shades[1] : grain ? spec.shades[2] ?? spec.shades[1] : spec.shades[0]);
        }
      }
      break;
    }
    case 'tiles': {
      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
          const seam = x % 8 === 0 || y % 8 === 0;
          px(x, y, seam ? spec.shades[1] : spec.shades[0] * (0.98 + rand() * 0.05));
        }
      }
      break;
    }
    case 'crystal': {
      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
          // diagonal facets
          const facet = ((x + y) % 8 < 4) !== ((x - y + SIZE) % 8 < 4);
          px(x, y, facet ? spec.shades[1] : spec.shades[2] ?? spec.shades[0]);
        }
      }
      break;
    }
    case 'vines': {
      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) px(x, y, spec.shades[0]);
      }
      for (let i = 0; i < 4; i++) {
        let x = Math.floor(rand() * SIZE);
        for (let y = 0; y < SIZE; y++) {
          px(x, y, spec.shades[1]);
          px((x + 1) % SIZE, y, spec.shades[2] ?? spec.shades[1]);
          if (rand() < 0.3) x = (x + (rand() < 0.5 ? 1 : SIZE - 1)) % SIZE;
        }
      }
      break;
    }
  }

  return canvas;
}

/** Cached three.js texture for a (name, tint) pair. */
export function getTexture(name: TextureName, color: number): THREE.Texture {
  const key = `${name}:${color}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const tex = new THREE.CanvasTexture(drawTexture(name, color));
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
