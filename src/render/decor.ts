/**
 * Environmental dressing: what makes one corridor look unlike the next.
 *
 * This lives in `render/` on purpose. It is purely cosmetic — it never touches
 * walkability, the collider or the generation streams — so it can be tuned
 * freely without shifting any seed's world, and `world/` stays headless.
 *
 * Everything here is a pure function of a tile's *global* grid coordinate, via
 * `hash2`. That keeps it deterministic (same seed ⇒ same dressing) without
 * threading an Rng through the renderer, and makes neighbouring tiles decide
 * independently, so patterns never march in step.
 */

import type { BlockStyle, Zone } from '../core/types.js';

/** Deterministic [0,1) from two integers plus a salt string. */
export function hash2(x: number, y: number, salt: number): number {
  let h = Math.imul(x | 0, 0x1b873593) ^ Math.imul(y | 0, 0xcc9e2d51) ^ Math.imul(salt, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 16), 0x2545f491);
  h ^= h >>> 15;
  h = Math.imul(h, 0x27d4eb2f);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Salts, kept distinct so two decisions on the same tile never correlate. */
export const SALT = {
  wallHeight: 0x101,
  wallBand: 0x102,
  wallSkin: 0x103,
  prop: 0x201,
  propKind: 0x202,
  propOffset: 0x203,
  floorPatch: 0x301,
  ceiling: 0x401,
} as const;

// --------------------------------------------------------------- wall relief

/**
 * How tall this wall tile stands, in blocks above the base height.
 *
 * A flat skyline is the other half of the repetition problem: with every wall
 * exactly WALL_HEIGHT, corridors read as an extruded floorplan. A minority of
 * tiles stepping up by one or two breaks the horizon without ever lowering a
 * wall (which would let the player see over it and spoil the maze).
 */
export function wallRelief(gx: number, gz: number, biomeId: string): number {
  const r = hash2(gx, gz, SALT.wallHeight + biomeId.length);
  if (r < 0.1) return 2;
  if (r < 0.3) return 1;
  return 0;
}

/**
 * Whether a wall tile wears an accent band partway up (a seam of ore, a course
 * of brick, a vein of ice) and at which height.
 * Returns -1 for no band.
 */
export function wallBand(gx: number, gz: number, wallHeight: number): number {
  const r = hash2(gx, gz, SALT.wallBand);
  if (r > 0.22) return -1;
  return Math.floor((r / 0.22) * wallHeight);
}

/**
 * Some wall tiles are built out of the accent material entirely — a buttress,
 * an outcrop — so a long run of wall has punctuation.
 */
export function wallIsAccent(gx: number, gz: number): boolean {
  return hash2(gx, gz, SALT.wallSkin) < 0.08;
}

// ------------------------------------------------------------------- colour

/**
 * Blend two packed RGB colours. Used to derive dressing tints from the biome
 * palette rather than reusing a palette entry raw.
 */
export function mixColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

/**
 * The tint a *surface* variation uses.
 *
 * Deliberately not the raw accent: an accent is chosen to be a highlight (the
 * ruins' gold, the cave's crystal), and a whole wall or a floor patch of it
 * reads as a rendering bug rather than as weathering. Pulling it most of the
 * way back toward the surface it sits on keeps the hue shift and drops the
 * shout.
 */
export function weatheredTint(base: number, accent: number): number {
  return mixColor(base, accent, 0.3);
}

// --------------------------------------------------------------- floor patch

/**
 * Occasionally swap a floor voxel's material for the biome accent: puddles in
 * the swamp, sand drifts in the desert, packed ice on snow. Voxel-level (not
 * tile-level) so the patches have ragged edges.
 */
export function floorPatch(gx: number, gz: number): boolean {
  return hash2(gx, gz, SALT.floorPatch) < 0.07;
}

// -------------------------------------------------------------------- props

export type PropKind =
  | 'pebble'
  | 'tuft'
  | 'mushroom'
  | 'shard'
  | 'stalagmite'
  | 'root'
  | 'shrub'
  | 'bones'
  | 'urn';

export interface PropSpec {
  kind: PropKind;
  /** block palette entries the prop is built from */
  material: 'floor' | 'wall' | 'accent';
  /** emissive tint, for props that should glow in dark biomes */
  glow?: number;
}

/**
 * The props each biome scatters on its floor, with weights. Small, cheap
 * shapes: the point is silhouette variety underfoot, not detail.
 */
const BIOME_PROPS: Record<string, { spec: PropSpec; weight: number }[]> = {
  forest: [
    { spec: { kind: 'tuft', material: 'floor' }, weight: 4 },
    { spec: { kind: 'shrub', material: 'wall' }, weight: 3 },
    { spec: { kind: 'mushroom', material: 'accent' }, weight: 2 },
    { spec: { kind: 'pebble', material: 'accent' }, weight: 1 },
  ],
  desert: [
    { spec: { kind: 'pebble', material: 'wall' }, weight: 4 },
    { spec: { kind: 'bones', material: 'floor' }, weight: 2 },
    { spec: { kind: 'urn', material: 'accent' }, weight: 1 },
  ],
  snow: [
    { spec: { kind: 'shard', material: 'accent' }, weight: 4 },
    { spec: { kind: 'pebble', material: 'wall' }, weight: 2 },
    { spec: { kind: 'stalagmite', material: 'accent' }, weight: 1 },
  ],
  cave: [
    { spec: { kind: 'stalagmite', material: 'wall' }, weight: 4 },
    { spec: { kind: 'shard', material: 'accent', glow: 0x2fa8b0 }, weight: 3 },
    { spec: { kind: 'pebble', material: 'floor' }, weight: 3 },
    { spec: { kind: 'mushroom', material: 'accent', glow: 0x1f7f88 }, weight: 2 },
  ],
  swamp: [
    { spec: { kind: 'root', material: 'accent' }, weight: 4 },
    { spec: { kind: 'tuft', material: 'wall' }, weight: 3 },
    { spec: { kind: 'mushroom', material: 'wall' }, weight: 2 },
    { spec: { kind: 'bones', material: 'floor' }, weight: 1 },
  ],
  ruins: [
    { spec: { kind: 'urn', material: 'accent' }, weight: 3 },
    { spec: { kind: 'pebble', material: 'wall' }, weight: 3 },
    { spec: { kind: 'bones', material: 'floor' }, weight: 2 },
    { spec: { kind: 'shrub', material: 'accent' }, weight: 1 },
  ],
};

const DEFAULT_PROPS: { spec: PropSpec; weight: number }[] = [
  { spec: { kind: 'pebble', material: 'wall' }, weight: 1 },
];

/** Roughly one floor tile in three carries something. */
const PROP_DENSITY = 0.34;

/**
 * What (if anything) stands on this floor tile, and where within it.
 *
 * The offset is deliberately kept inside the middle of the tile: a prop is
 * decorative and non-solid, so one hugging a wall would clip through it.
 */
export function propAt(
  gx: number,
  gz: number,
  biomeId: string,
): { spec: PropSpec; ox: number; oz: number; scale: number; spin: number } | null {
  if (hash2(gx, gz, SALT.prop) >= PROP_DENSITY) return null;

  const table = BIOME_PROPS[biomeId] ?? DEFAULT_PROPS;
  const total = table.reduce((s, e) => s + e.weight, 0);
  let pick = hash2(gx, gz, SALT.propKind) * total;
  let spec = table[table.length - 1].spec;
  for (const e of table) {
    pick -= e.weight;
    if (pick <= 0) {
      spec = e.spec;
      break;
    }
  }

  const r = hash2(gx, gz, SALT.propOffset);
  const r2 = hash2(gz, gx, SALT.propOffset);
  return {
    spec,
    ox: 0.3 + r * 0.4,
    oz: 0.3 + r2 * 0.4,
    scale: 0.55 + r2 * 0.45,
    spin: r * Math.PI * 2,
  };
}

/**
 * The material a prop is drawn with.
 *
 * Not the raw palette entry: a forest tuft built from the grass tint is a
 * green shape on a green floor and simply disappears. Every prop is darkened
 * toward the biome's wall colour so it separates from the ground it stands on,
 * which is also how a real shadowed object reads.
 */
export function propMaterial(zone: Zone, spec: PropSpec): BlockStyle {
  const base = zone.style.blocks[spec.material];
  const floor = zone.style.blocks.floor.color;
  // Push away from the floor colour: darker if the prop would otherwise match
  // it, so the silhouette survives whatever the biome palette is.
  const contrasted = mixColor(base.color, luminance(floor) > 0.45 ? 0x201a14 : 0xd8d2c4, 0.28);
  return { tex: base.tex, color: contrasted };
}

/** Perceptual-ish brightness of a packed RGB colour, 0..1. */
function luminance(c: number): number {
  const r = ((c >> 16) & 0xff) / 255;
  const g = ((c >> 8) & 0xff) / 255;
  const b = (c & 0xff) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
