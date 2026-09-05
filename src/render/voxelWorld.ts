/**
 * Voxel renderer.
 *
 * One InstancedMesh per (texture, tint) pair — never one mesh per block.
 * A medium world is ~25k blocks across a handful of draw calls.
 *
 * Face shading: instead of per-face vertex colors (which instancing makes
 * awkward), each block gets a slight tint variation and the directional light
 * plus ambient does the Minecraft-ish shading.
 */

import * as THREE from 'three';
import type { BlockingKind, Mechanism, Tile, World, Zone } from '../core/types.js';
import { CELL } from '../world/maze.js';
import { TILE } from '../core/types.js';
import { getTexture } from './textures.js';

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

interface BatchKey {
  tex: string;
  color: number;
}

/** Accumulates block placements, then bakes them into instanced meshes. */
class VoxelBatcher {
  private batches = new Map<string, { key: BatchKey; matrices: THREE.Matrix4[] }>();

  add(tex: string, color: number, x: number, y: number, z: number, scale = 1): void {
    const id = `${tex}:${color}`;
    let b = this.batches.get(id);
    if (!b) {
      b = { key: { tex, color }, matrices: [] };
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
        map: getTexture(key.tex as never, key.color),
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

  for (const zone of world.zones) {
    buildZone(zone, batcher, solid, blockedTiles);
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
): void {
  const { maze, originX, originZ } = zone;
  const { w, h, grid } = maze;
  const style = zone.style.blocks;

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
            batcher.add(style.floor.tex, style.floor.color, bx + ox, -1, bz + oz);
            solid.add(key(bx + ox, -1, bz + oz));
          }
        }
      } else {
        for (let ox = 0; ox < TILE; ox++) {
          for (let oz = 0; oz < TILE; oz++) {
            for (let y = 0; y < WALL_HEIGHT; y++) {
              batcher.add(style.wall.tex, style.wall.color, bx + ox, y, bz + oz);
              solid.add(key(bx + ox, y, bz + oz));
            }
            // Cap the wall with an accent block for silhouette.
            batcher.add(style.accent.tex, style.accent.color, bx + ox, WALL_HEIGHT, bz + oz);
            solid.add(key(bx + ox, WALL_HEIGHT, bz + oz));
          }
        }
      }
    }
  }
}

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
