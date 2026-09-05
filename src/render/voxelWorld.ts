/**
 * Voxel renderer.
 *
 * One InstancedMesh per (texture, tint) pair — never one mesh per block.
 * A medium world is ~25k blocks across a handful of draw calls.
 *
 * Face shading: instead of per-face vertex colors (which instancing makes
 * awkward), each block gets a slight tint variation and the directional light
 * plus ambient does the Minecraft-ish shading.
 *
 * Against tiling: a block picks its texture *variant* from a hash of its own
 * position (`variantAt`), so a wall face is a mosaic of related tiles rather
 * than one image repeated. That multiplies batches by VARIANTS — still a
 * handful of draw calls, since the batch key is (texture, tint, variant), not
 * the block.
 */

import * as THREE from 'three';
import type { BlockingKind, Mechanism, Tile, World, Zone } from '../core/types.js';
import { CELL } from '../world/maze.js';
import { TILE } from '../core/types.js';
import { getTexture, VARIANTS } from './textures.js';
import {
  floorPatch,
  propAt,
  propMaterial,
  wallBand,
  wallIsAccent,
  wallRelief,
  weatheredTint,
  type PropKind,
} from './decor.js';

const WALL_HEIGHT = 3;

/** Shared by every bridge slab — never disposed per-slab. */
const BRIDGE_GEOMETRY = new THREE.BoxGeometry(1, 1, 1);

/** Blocking geometry look per mechanism target type. */
const BLOCK_STYLE: Record<BlockingKind, { tex: 'door' | 'rubble' | 'pedestal' | 'gate'; color: number }> = {
  door: { tex: 'door', color: 0x8a5a2b },
  rubble: { tex: 'rubble', color: 0x6b6b73 },
  pedestal: { tex: 'pedestal', color: 0xb0a68c },
  gate: { tex: 'gate', color: 0x7fc8d8 },
  gap: { tex: 'gate', color: 0x334455 },
};

interface PropPlacement {
  zone: Zone;
  /** zone-local tile */
  tile: Tile;
  prop: NonNullable<ReturnType<typeof propAt>>;
}

interface BatchKey {
  tex: string;
  color: number;
  variant: number;
}

/**
 * How many discrete brightness steps a block's tint can take.
 *
 * Quantized on purpose: the jitter must multiply the *batch* count by a small
 * constant, not by the number of blocks. 3 steps x VARIANTS variants is 12
 * meshes per (texture, tint) — still a handful of draw calls per biome.
 */
const TINT_STEPS = 3;

/** Slightly lighten or darken a packed RGB colour. */
function jitterTint(color: number, step: number): number {
  if (step === 0) return color;
  // Kept deliberately small: at 6% the per-block squares read as a
  // checkerboard on a flat floor, which is worse than the flat tint it
  // replaced. At 2.5% it only breaks the uniformity.
  const mul = 1 + (step === 1 ? 0.025 : -0.025);
  const r = Math.min(255, Math.round(((color >> 16) & 0xff) * mul));
  const g = Math.min(255, Math.round(((color >> 8) & 0xff) * mul));
  const b = Math.min(255, Math.round((color & 0xff) * mul));
  return (r << 16) | (g << 8) | b;
}

/**
 * Per-block hash driving both the texture variant and the tint jitter.
 *
 * A cheap integer hash rather than an Rng: it must be a pure function of the
 * position so the choice is stable across rebuilds (and identical for the same
 * seed) without threading a random stream through the renderer.
 */
function variantHash(x: number, y: number, z: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2f) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(z | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return h >>> 0;
}

/** Accumulates block placements, then bakes them into instanced meshes. */
class VoxelBatcher {
  private batches = new Map<string, { key: BatchKey; matrices: THREE.Matrix4[] }>();

  add(tex: string, color: number, x: number, y: number, z: number, scale = 1): void {
    const h = variantHash(x, y, z);
    const variant = h % VARIANTS;
    // A flat plane of one tint reads as a single surface however good the
    // texture is; nudging brightness per block gives it grain at block scale.
    const tinted = jitterTint(color, Math.floor(h / VARIANTS) % TINT_STEPS);
    const id = `${tex}:${tinted}:${variant}`;
    let b = this.batches.get(id);
    if (!b) {
      b = { key: { tex, color: tinted, variant }, matrices: [] };
      this.batches.set(id, b);
    }
    const m = new THREE.Matrix4();
    // BoxGeometry is centred on its origin, so a unit cube placed at index i
    // would span [i-0.5, i+0.5]. Collision and tileToWorld both treat voxel i
    // as spanning [i, i+1), so shift by half a block to make the rendered
    // world line up with the grid everything else uses.
    m.compose(
      new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5),
      new THREE.Quaternion(),
      new THREE.Vector3(scale, scale, scale),
    );
    b.matrices.push(m);
  }

  bake(group: THREE.Group, geometry: THREE.BoxGeometry, castShadow: boolean): void {
    for (const { key, matrices } of this.batches.values()) {
      if (!matrices.length) continue;
      const material = new THREE.MeshLambertMaterial({
        map: getTexture(key.tex as never, key.color, key.variant),
      });
      const mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
      matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = castShadow;
      mesh.receiveShadow = true;
      mesh.frustumCulled = true;
      group.add(mesh);
    }
  }
}

export interface BuiltWorld {
  group: THREE.Group;
  /** Solid-block lookup for collision: key `x,y,z`. */
  solid: Set<string>;
  /** Blocking meshes per mechanism uid, so unlocking can remove them. */
  blockers: Map<string, THREE.Object3D[]>;
  dispose(): void;
}

const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
/** Zone-grid tile key (pre-TILE scaling), used to look up blocked tiles. */
const tileKey = (tx: number, tz: number) => `t${tx},${tz}`;

export function buildWorld(world: World, opts: { shadows: boolean }): BuiltWorld {
  const group = new THREE.Group();
  const solid = new Set<string>();
  const blockers = new Map<string, THREE.Object3D[]>();
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const batcher = new VoxelBatcher();

  // Tiles that a mechanism blocks — rendered separately so they can be removed.
  const blockedTiles = new Map<string, Mechanism>();
  for (const m of world.mechanisms) {
    const z = world.zones.find((zz) => zz.id === m.zoneId)!;
    // A chasm covers several tiles; everything else blocks a single one.
    for (const t of m.target.tiles ?? [m.target.tile]) {
      blockedTiles.set(tileKey(z.originX + t.x, z.originZ + t.y), m);
    }
  }

  const props: PropPlacement[] = [];
  for (const zone of world.zones) {
    buildZone(zone, batcher, solid, blockedTiles, props);
  }

  // Link tiles in the gutters between zones.
  for (const zone of world.zones) {
    const style = zone.style.blocks;
    const linkSet = new Set(zone.links.map((l) => `${l.x},${l.z}`));
    for (const l of zone.links) {
      const bx = l.x * TILE;
      const bz = l.z * TILE;
      for (let ox = 0; ox < TILE; ox++) {
        for (let oz = 0; oz < TILE; oz++) {
          batcher.add(style.floor.tex, style.floor.color, bx + ox, -1, bz + oz);
          solid.add(key(bx + ox, -1, bz + oz));
        }
      }
      // Kerb walls on the sides the link does not continue toward, so the
      // gutter reads as a passage rather than open ground.
      for (const dz of [-1, 1]) {
        if (linkSet.has(`${l.x},${l.z + dz}`)) continue;
        const wallZ = dz < 0 ? bz - 1 : bz + TILE;
        for (let ox = 0; ox < TILE; ox++) {
          for (let y = 0; y < WALL_HEIGHT; y++) {
            batcher.add(style.wall.tex, style.wall.color, bx + ox, y, wallZ);
            solid.add(key(bx + ox, y, wallZ));
          }
        }
      }
    }
  }

  batcher.bake(group, geometry, opts.shadows);
  buildProps(group, props, world, blockedTiles, opts.shadows);

  // Blocking geometry gets its own meshes (removable on unlock).
  for (const m of world.mechanisms) {
    const zone = world.zones.find((zz) => zz.id === m.zoneId)!;
    const objs = buildBlocker(m, zone, geometry, solid, opts.shadows);
    for (const o of objs) group.add(o);
    blockers.set(m.uid, objs);
  }

  return {
    group,
    solid,
    blockers,
    dispose() {
      group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((mm) => mm.dispose());
        else mat?.dispose();
      });
      group.clear();
    },
  };
}

function buildZone(
  zone: Zone,
  batcher: VoxelBatcher,
  solid: Set<string>,
  blockedTiles: Map<string, Mechanism>,
  props: PropPlacement[],
): void {
  const { maze, originX, originZ } = zone;
  const { w, h, grid } = maze;
  const style = zone.style.blocks;
  const patchTint = weatheredTint(style.floor.color, style.accent.color);
  const buttressTint = weatheredTint(style.wall.color, style.accent.color);

  for (let ty = 0; ty < h; ty++) {
    for (let tx = 0; tx < w; tx++) {
      const isFloor = grid[ty * w + tx] === CELL.FLOOR;
      // One maze tile spans TILE x TILE voxel columns, so corridors are wide
      // enough to walk without scraping both walls.
      const bx = (originX + tx) * TILE;
      const bz = (originZ + ty) * TILE;

      if (isFloor) {
        // A gap mechanism swallows the floor here: the player must bridge it.
        const isGap = blockedTiles.get(tileKey(originX + tx, originZ + ty))?.target.type === 'gap';
        if (isGap) continue;
        for (let ox = 0; ox < TILE; ox++) {
          for (let oz = 0; oz < TILE; oz++) {
            // A minority of floor voxels take the accent material — puddles,
            // drifts, worn flagstones — so the ground is not one flat wash.
            const patch = floorPatch(bx + ox, bz + oz);
            // The accent's *texture* (a different pattern) with a tint pulled
            // back toward the floor: a highlight colour laid flat on the
            // ground reads as a bug, not as wear.
            const tex = patch ? style.accent.tex : style.floor.tex;
            const tint = patch ? patchTint : style.floor.color;
            batcher.add(tex, tint, bx + ox, -1, bz + oz);
            solid.add(key(bx + ox, -1, bz + oz));
          }
        }
        // Non-solid dressing on top of the floor.
        const prop = propAt(originX + tx, originZ + ty, zone.biomeId);
        if (prop) props.push({ zone, tile: { x: tx, y: ty }, prop });
      } else {
        // Relief is decided per *tile*, not per voxel: a wall column must stay
        // one block, or the silhouette turns into noise instead of massing.
        const relief = wallRelief(originX + tx, originZ + ty, zone.biomeId);
        const top = WALL_HEIGHT + relief;
        const allAccent = wallIsAccent(originX + tx, originZ + ty);
        const band = allAccent ? -1 : wallBand(originX + tx, originZ + ty, top);

        for (let ox = 0; ox < TILE; ox++) {
          for (let oz = 0; oz < TILE; oz++) {
            for (let y = 0; y < top; y++) {
              const isAccent = allAccent || y === band;
              batcher.add(
                isAccent ? style.accent.tex : style.wall.tex,
                isAccent ? buttressTint : style.wall.color,
                bx + ox,
                y,
                bz + oz,
              );
              solid.add(key(bx + ox, y, bz + oz));
            }
            // Cap the wall with an accent block for silhouette.
            batcher.add(style.accent.tex, style.accent.color, bx + ox, top, bz + oz);
            solid.add(key(bx + ox, top, bz + oz));
          }
        }
      }
    }
  }
}

// ------------------------------------------------------------------- props

/**
 * Ground clutter. Each prop is a handful of boxes merged into one instanced
 * draw per (kind, material), so the whole world's dressing costs a few calls.
 *
 * Props are decoration only: they are never added to `solid`, so they cannot
 * wall a corridor in and cannot break the generator's connectivity guarantees.
 */
function buildProps(
  group: THREE.Group,
  props: PropPlacement[],
  world: World,
  blockedTiles: Map<string, Mechanism>,
  shadows: boolean,
): void {
  // Keep the floor clear where the player has something to walk up to.
  const reserved = new Set<string>();
  const reserve = (zoneId: string, t: Tile) => {
    const z = world.zones.find((zz) => zz.id === zoneId);
    if (z) reserved.add(tileKey(z.originX + t.x, z.originZ + t.y));
  };
  for (const p of world.pickups) reserve(p.zoneId, p.tile);
  for (const s of world.signposts) reserve(s.zoneId, s.tile);
  for (const t of world.teleporters) reserve(t.zoneId, t.tile);
  for (const z of world.zones) {
    reserve(z.id, z.entry);
    reserve(z.id, z.exit);
  }

  // (kind, tint) -> the matrices of every instance of it.
  const batches = new Map<
    string,
    { parts: PropPart[]; tex: string; color: number; glow?: number; matrices: THREE.Matrix4[] }
  >();

  for (const { zone, tile, prop } of props) {
    const gk = tileKey(zone.originX + tile.x, zone.originZ + tile.y);
    if (reserved.has(gk) || blockedTiles.has(gk)) continue;

    const mat = propMaterial(zone, prop.spec);
    const id = `${prop.spec.kind}:${mat.tex}:${mat.color}:${prop.spec.glow ?? 0}`;
    let b = batches.get(id);
    if (!b) {
      b = {
        parts: PROP_SHAPES[prop.spec.kind],
        tex: mat.tex,
        color: mat.color,
        glow: prop.spec.glow,
        matrices: [],
      };
      batches.set(id, b);
    }

    // tileOrigin is the low corner of the tile in world units; the prop's
    // offset is a fraction of the tile, so it scales with TILE for free.
    const ox = (zone.originX + tile.x) * TILE + prop.ox * TILE;
    const oz = (zone.originZ + tile.y) * TILE + prop.oz * TILE;
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(ox, 0, oz),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), prop.spin),
      new THREE.Vector3(prop.scale, prop.scale, prop.scale),
    );
    b.matrices.push(m);
  }

  for (const b of batches.values()) {
    if (!b.matrices.length) continue;
    const material = new THREE.MeshLambertMaterial({
      map: getTexture(b.tex as never, b.color, 0),
      ...(b.glow ? { emissive: new THREE.Color(b.glow), emissiveIntensity: 0.9 } : {}),
    });
    // One instanced mesh per box of the shape: a prop of 3 boxes across 200
    // placements is 3 draw calls, not 600 meshes.
    for (const part of b.parts) {
      const geo = new THREE.BoxGeometry(part.w, part.h, part.d);
      const mesh = new THREE.InstancedMesh(geo, material, b.matrices.length);
      const local = new THREE.Matrix4().makeTranslation(part.x, part.y + part.h / 2, part.z);
      const out = new THREE.Matrix4();
      b.matrices.forEach((m, i) => mesh.setMatrixAt(i, out.multiplyMatrices(m, local)));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = shadows;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }
}

/** One box of a prop, positioned relative to the prop's base (y = 0 = floor). */
interface PropPart {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
}

/**
 * Prop shapes, in world units. Deliberately chunky and low — they read as
 * silhouette from walking height and never block a sightline down a corridor.
 */
const PROP_SHAPES: Record<PropKind, PropPart[]> = {
  pebble: [
    { x: 0, y: 0, z: 0, w: 0.6, h: 0.34, d: 0.52 },
    { x: 0.38, y: 0, z: 0.24, w: 0.34, h: 0.22, d: 0.3 },
  ],
  tuft: [
    { x: 0, y: 0, z: 0, w: 0.16, h: 0.8, d: 0.16 },
    { x: 0.24, y: 0, z: 0.1, w: 0.13, h: 0.56, d: 0.13 },
    { x: -0.2, y: 0, z: 0.17, w: 0.13, h: 0.64, d: 0.13 },
  ],
  mushroom: [
    { x: 0, y: 0, z: 0, w: 0.16, h: 0.44, d: 0.16 },
    { x: 0, y: 0.44, z: 0, w: 0.52, h: 0.2, d: 0.52 },
  ],
  shard: [
    { x: 0, y: 0, z: 0, w: 0.26, h: 1.05, d: 0.26 },
    { x: 0.27, y: 0, z: 0.17, w: 0.18, h: 0.6, d: 0.18 },
  ],
  stalagmite: [
    { x: 0, y: 0, z: 0, w: 0.56, h: 0.5, d: 0.56 },
    { x: 0, y: 0.5, z: 0, w: 0.34, h: 0.56, d: 0.34 },
    { x: 0, y: 1.06, z: 0, w: 0.15, h: 0.4, d: 0.15 },
  ],
  root: [
    { x: 0, y: 0, z: 0, w: 1.0, h: 0.24, d: 0.27 },
    { x: 0.3, y: 0.24, z: 0, w: 0.4, h: 0.24, d: 0.24 },
    { x: -0.34, y: 0, z: 0.3, w: 0.27, h: 0.4, d: 0.27 },
  ],
  shrub: [
    { x: 0, y: 0, z: 0, w: 0.2, h: 0.4, d: 0.2 },
    { x: 0, y: 0.38, z: 0, w: 0.78, h: 0.54, d: 0.74 },
  ],
  bones: [
    { x: 0, y: 0, z: 0, w: 0.85, h: 0.15, d: 0.15 },
    { x: 0.2, y: 0, z: 0.27, w: 0.58, h: 0.15, d: 0.15 },
    { x: -0.27, y: 0, z: -0.17, w: 0.24, h: 0.24, d: 0.24 },
  ],
  urn: [
    { x: 0, y: 0, z: 0, w: 0.44, h: 0.24, d: 0.44 },
    { x: 0, y: 0.24, z: 0, w: 0.58, h: 0.44, d: 0.58 },
    { x: 0, y: 0.68, z: 0, w: 0.34, h: 0.17, d: 0.34 },
  ],
};

/** Build the removable geometry that physically blocks a mechanism's tile. */
function buildBlocker(
  m: Mechanism,
  zone: Zone,
  geometry: THREE.BoxGeometry,
  solid: Set<string>,
  shadows: boolean,
): THREE.Object3D[] {
  const spec = BLOCK_STYLE[m.target.type];
  const bx = (zone.originX + m.target.tile.x) * TILE;
  const bz = (zone.originZ + m.target.tile.y) * TILE;
  const out: THREE.Object3D[] = [];

  if (m.target.type === 'gap') {
    // A gap is an absence: nothing to render, but the floor slabs are missing
    // so the player cannot cross. Void every voxel of every covered tile.
    for (const t of m.target.tiles ?? [m.target.tile]) {
      const tx = (zone.originX + t.x) * TILE;
      const tz = (zone.originZ + t.y) * TILE;
      for (let ox = 0; ox < TILE; ox++) {
        for (let oz = 0; oz < TILE; oz++) solid.delete(key(tx + ox, -1, tz + oz));
      }
    }
    return out;
  }

  const material = new THREE.MeshLambertMaterial({ map: getTexture(spec.tex, spec.color) });
  // A pedestal stays waist-high so it reads as an altar; the rest fills the
  // passage. Both span the full tile width now that a tile is TILE voxels.
  const height = m.target.type === 'pedestal' ? 1 : WALL_HEIGHT;

  for (let ox = 0; ox < TILE; ox++) {
    for (let oz = 0; oz < TILE; oz++) {
      for (let y = 0; y < height; y++) {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(bx + ox + 0.5, y + 0.5, bz + oz + 0.5);
        mesh.castShadow = shadows;
        mesh.receiveShadow = true;
        out.push(mesh);
        solid.add(key(bx + ox, y, bz + oz));
      }
    }
  }
  return out;
}

/**
 * Remove a mechanism's blocking geometry from the scene and the collider.
 * The box geometry is shared by every block in the world, so it is detached
 * here but never disposed — only the per-blocker material is.
 */
export function clearBlocker(built: BuiltWorld, m: Mechanism, zone: Zone): void {
  const objs = built.blockers.get(m.uid) ?? [];
  const materials = new Set<THREE.Material>();
  for (const o of objs) {
    o.removeFromParent();
    const mat = (o as THREE.Mesh).material as THREE.Material | undefined;
    if (mat) materials.add(mat);
  }
  for (const mat of materials) mat.dispose(); // one material shared per column
  built.blockers.set(m.uid, []);

  const bx = (zone.originX + m.target.tile.x) * TILE;
  const bz = (zone.originZ + m.target.tile.y) * TILE;
  // Clear the columns the blocker occupied, but leave the floor slabs at y=-1
  // intact so the player has something to walk on.
  for (let ox = 0; ox < TILE; ox++) {
    for (let oz = 0; oz < TILE; oz++) {
      for (let y = 0; y <= WALL_HEIGHT; y++) built.solid.delete(key(bx + ox, y, bz + oz));
    }
  }
}

/** Lay a floor slab across a gap (the bridge mechanism). */
export function placeBridgeTile(
  built: BuiltWorld,
  zone: Zone,
  tile: Tile,
  shadows: boolean,
): THREE.Object3D {
  const bx = (zone.originX + tile.x) * TILE;
  const bz = (zone.originZ + tile.y) * TILE;
  const style = zone.style.blocks;
  const material = new THREE.MeshLambertMaterial({
    map: getTexture(style.accent.tex, style.accent.color),
  });
  // One slab per voxel of the tile, grouped so the caller gets a single object.
  const group = new THREE.Group();
  for (let ox = 0; ox < TILE; ox++) {
    for (let oz = 0; oz < TILE; oz++) {
      const mesh = new THREE.Mesh(BRIDGE_GEOMETRY, material);
      mesh.position.set(bx + ox + 0.5, -1 + 0.5, bz + oz + 0.5);
      mesh.castShadow = shadows;
      mesh.receiveShadow = true;
      group.add(mesh);
      built.solid.add(key(bx + ox, -1, bz + oz));
    }
  }
  built.group.add(group);
  return group;
}

export { WALL_HEIGHT, key as blockKey };
