/**
 * World generation: biome graph -> per-biome mazes -> mechanisms, items,
 * signposts, teleporters. Everything derives from the seed via forked rngs so
 * that adding a step in one area does not reshuffle another.
 *
 * Layout: each zone (biome or corridor) is its own maze grid in local
 * coordinates. Zones sit side by side along the global X axis with a gutter,
 * giving the voxel builder and the minimap one shared coordinate space.
 */

import { Rng } from '../core/rng.js';
import { TILE } from '../core/types.js';
import type {
  GameConfig,
  Mechanism,
  MechanismTypeId,
  SizeKey,
  Tile,
  Vec2,
  World,
  Zone,
} from '../core/types.js';
import { BIOMES, BIOME_POOL, CORRIDOR_STYLE, ENTRY_BIOME } from './biomes.js';
import { ITEMS } from './items.js';
import type { ItemRole, MechanismPlan, PlanContext } from './unlockMechanisms.js';
import { MECHANISM_TYPES, mechanismHint, pickMechanismType } from './unlockMechanisms.js';
import { CELL, bfsDistances, findDeadEnds, findPath, generateMaze, walkableTiles } from './maze.js';

export interface SizePreset {
  label: string;
  biomes: number;
  cells: number;
  corridor: number;
  minutes: string;
}

/** Size presets: biome count and maze dimensions. Tuned for ~20-30 min at medium. */
export const SIZE_PRESETS: Record<SizeKey, SizePreset> = {
  small: { label: 'Petit', biomes: 3, cells: 7, corridor: 9, minutes: '10-15' },
  medium: { label: 'Moyen', biomes: 5, cells: 10, corridor: 13, minutes: '20-30' },
  large: { label: 'Grand', biomes: 6, cells: 13, corridor: 17, minutes: '35-50' },
};

const ZONE_GUTTER = 6;

/** Item pools by role, drawn from without repetition inside a run. */
const ITEM_ROLES: Record<ItemRole, string[]> = {
  key: ['ice_key', 'sun_key', 'root_key', 'bone_key'],
  offering: ['amber_orb', 'jade_idol', 'ash_urn'],
  fragment: ['seal_shard', 'tablet_piece'],
  tool: ['pickaxe', 'torch', 'axe'],
  trigger: ['gear', 'lever_handle'],
};

export function generateWorld(config: GameConfig): World {
  const preset = SIZE_PRESETS[config.size] ?? SIZE_PRESETS.medium;
  const biomeCount = Math.max(2, Math.min(6, config.biomeCount ?? preset.biomes));
  const root = new Rng(config.seed);

  // --- 1. Biome order -------------------------------------------------
  const graphRng = root.fork('graph');
  const pool = graphRng.shuffle(BIOME_POOL).slice(0, biomeCount - 1);
  const biomeOrder = [ENTRY_BIOME, ...pool];

  // --- 2. Zones (biomes interleaved with corridors) --------------------
  const zones: Zone[] = [];
  let cursorX = 0;

  biomeOrder.forEach((biomeId, i) => {
    if (i > 0) {
      const corridor = buildCorridorZone(root.fork(`corridor:${i}`), i, preset, cursorX);
      zones.push(corridor);
      cursorX += corridor.w + ZONE_GUTTER;
    }
    const zone = buildBiomeZone(root.fork(`biome:${biomeId}:${i}`), biomeId, i, preset, cursorX);
    zones.push(zone);
    cursorX += zone.w + ZONE_GUTTER;
  });

  // Punch each zone's exit through to the next zone's entry, carving the
  // gutter between them so the world is one continuous walkable space.
  linkZones(zones);

  const biomeZones = zones.filter((z) => z.kind === 'biome');
  const last = zones[zones.length - 1];

  const world: World = {
    seed: config.seed,
    size: config.size,
    biomeCount,
    zones,
    biomeZones,
    mechanisms: [],
    pickups: [],
    signposts: [],
    teleporters: [],
    grantedByZone: new Map(),
    width: cursorX,
    start: biomeZones[0].entry,
    startZoneId: biomeZones[0].id,
    exit: { zoneId: last.id, tile: last.exit },
  };

  planProgression(world, root);
  // Tiles already claimed by an entity, so signposts, teleporters and pickups
  // never stack on the same spot. Keyed per zone: `zoneId:x,y`.
  const taken = new Set<string>();
  for (const p of world.pickups) taken.add(`${p.zoneId}:${p.tile.x},${p.tile.y}`);
  placeSignposts(world, root, taken);
  placeTeleporters(world, root, taken);

  return world;
}

function buildBiomeZone(
  rng: Rng,
  biomeId: string,
  index: number,
  preset: SizePreset,
  originX: number,
): Zone {
  const biome = BIOMES[biomeId];
  const cells = Math.max(4, Math.round(preset.cells * (biome.mazeScale ?? 1)));
  const maze = generateMaze(rng.fork('maze'), cells, cells, { braid: 0.08, loop: 0.15 });
  const tiles = walkableTiles(maze);

  return {
    id: `biome-${index}-${biomeId}`,
    kind: 'biome',
    index,
    biomeId,
    style: biome,
    maze,
    w: maze.w,
    h: maze.h,
    originX,
    originZ: 0,
    // Entry west, exit east: the player must cross the whole maze.
    entry: pickEdgeTile(tiles, maze.h, 'west'),
    exit: pickEdgeTile(tiles, maze.h, 'east'),
    tiles,
    deadEnds: findDeadEnds(maze.grid, maze.w, maze.h),
    links: [],
  };
}

function buildCorridorZone(rng: Rng, index: number, preset: SizePreset, originX: number): Zone {
  // A corridor is a long, mostly-straight tunnel with a few seeded alcoves.
  const len = preset.corridor;
  const w = len * 2 + 1;
  const h = 5;
  const grid = new Uint8Array(w * h);
  const midY = 2;
  for (let x = 1; x < w - 1; x++) grid[midY * w + x] = CELL.FLOOR;

  const alcoves = rng.sample(
    Array.from({ length: len - 2 }, (_, i) => i + 1),
    Math.max(1, Math.floor(len / 5)),
  );
  for (const a of alcoves) {
    const dy = rng.bool() ? -1 : 1;
    grid[(midY + dy) * w + (a * 2 + 1)] = CELL.FLOOR;
  }

  const maze = { w, h, grid, cols: len, rows: 1 };
  return {
    id: `corridor-${index}`,
    kind: 'corridor',
    index,
    biomeId: 'corridor',
    style: CORRIDOR_STYLE,
    maze,
    w,
    h,
    originX,
    originZ: 0,
    entry: { x: 1, y: midY },
    exit: { x: w - 2, y: midY },
    tiles: walkableTiles(maze),
    deadEnds: [],
    links: [],
  };
}

/**
 * Connect consecutive zones. Each zone's exit is carved out to the east edge
 * of its own grid, the next zone's entry out to its west edge, and the gutter
 * between them is filled with world-space link tiles.
 */
function linkZones(zones: Zone[]): void {
  for (let i = 0; i < zones.length - 1; i++) {
    const a = zones[i];
    const b = zones[i + 1];

    // Carve a straight run from each side's tile to its grid boundary.
    carveToEdge(a, a.exit, 'east');
    carveToEdge(b, b.entry, 'west');

    // Fill the gutter as an L: run east at a's row, turn once, then finish at
    // b's row. A straight interpolation would leave diagonal (non-walkable)
    // gaps, so the turn is made explicitly on a single column.
    const startX = a.originX + a.w - 1; // last carved column inside a
    const endX = b.originX; // first carved column inside b
    const z0 = a.originZ + a.exit.y;
    const z1 = b.originZ + b.entry.y;
    const turnX = Math.floor((startX + endX) / 2);

    for (let x = startX; x <= turnX; x++) a.links.push({ x, z: z0 });
    for (let zz = Math.min(z0, z1); zz <= Math.max(z0, z1); zz++) {
      a.links.push({ x: turnX, z: zz });
    }
    for (let x = turnX; x <= endX; x++) a.links.push({ x, z: z1 });
  }
}

/** Open a straight corridor from `tile` to the given edge of the zone grid. */
function carveToEdge(zone: Zone, tile: Tile, side: 'east' | 'west'): void {
  const { w, grid } = zone.maze;
  if (side === 'east') {
    for (let x = tile.x; x < w; x++) grid[tile.y * w + x] = CELL.FLOOR;
  } else {
    for (let x = tile.x; x >= 0; x--) grid[tile.y * w + x] = CELL.FLOOR;
  }
  zone.tiles = walkableTiles(zone.maze);
}

/** Walkable tile nearest the given edge, tie-broken toward the vertical centre. */
function pickEdgeTile(tiles: Tile[], mazeH: number, side: 'west' | 'east'): Tile {
  let best = tiles[0];
  let bestScore = -Infinity;
  for (const t of tiles) {
    const edge = side === 'west' ? -t.x : t.x;
    const score = edge * 1000 - Math.abs(t.y - Math.floor(mazeH / 2));
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

/**
 * Decide, per biome, which mechanism gates its exit and where the loot goes.
 * Balance follows the brief: 1/2/4 dominate, 3/6 appear once or twice,
 * 7 is reserved for one key transition.
 */
function planProgression(world: World, root: Rng): void {
  const rng = root.fork('progression');
  // Tiles already holding a pickup, so two items never spawn on top of each
  // other (cross-biome tools are placed in a separate pass and used to clash).
  const usedTiles = new Set<string>();
  const claim = (zoneId: string, t: Tile) => usedTiles.add(`${zoneId}:${t.x},${t.y}`);
  const isFree = (zoneId: string, t: Tile) => !usedTiles.has(`${zoneId}:${t.x},${t.y}`);
  const usedItems = new Set<string>();
  const granted = world.grantedByZone;
  const grant = (zoneId: string, itemId: string) => {
    granted.set(zoneId, [...(granted.get(zoneId) ?? []), itemId]);
  };

  const indices = world.biomeZones.map((_, i) => i);
  // Biomes that reward exhaustive exploration.
  const deepIdx = new Set(
    rng.sample(
      indices.filter((i) => i > 0),
      Math.min(2, Math.max(1, Math.floor(world.biomeZones.length / 3))),
    ),
  );
  // One transition using a tool fetched from an earlier biome.
  const crossIdx = new Set(
    rng.sample(
      indices.filter((i) => i >= 2 && !deepIdx.has(i)),
      world.biomeZones.length >= 4 ? 1 : 0,
    ),
  );

  world.biomeZones.forEach((zone, i) => {
    const zoneRng = rng.fork(`zone:${zone.id}`);

    let allowed: MechanismTypeId[];
    if (crossIdx.has(i)) allowed = ['cross_biome_tool'];
    else if (deepIdx.has(i)) allowed = ['fragment_set', 'light_threshold'];
    else allowed = ['key_door', 'pedestal_offering', 'break_obstacle', 'activate_bridge'];

    const typeId = pickMechanismType(zoneRng, allowed);

    const ctx: PlanContext = {
      rng: zoneRng,
      zone,
      pickItem(role) {
        const free = ITEM_ROLES[role].filter((id) => !usedItems.has(id));
        const chosen = zoneRng.pick(free.length ? free : ITEM_ROLES[role]);
        usedItems.add(chosen);
        return chosen;
      },
      pickCrossBiomeItem() {
        if (i < 1) return null;
        const free = ITEM_ROLES.tool.filter((id) => !usedItems.has(id));
        if (!free.length) return null;
        const chosen = zoneRng.pick(free);
        usedItems.add(chosen);
        return chosen;
      },
    };

    let plan: MechanismPlan | null = MECHANISM_TYPES[typeId].plan(ctx);
    let resolvedType = typeId;
    if (!plan) {
      // A mechanism declined (e.g. cross-biome with nothing to draw on).
      resolvedType = 'key_door';
      plan = MECHANISM_TYPES.key_door.plan(ctx)!;
    }

    const gateTile = placeBlockingTile(zone);
    const inst: Mechanism = {
      uid: `mech-${zone.id}`,
      type: resolvedType,
      zoneId: zone.id,
      requires: plan.requires,
      consumesItem: plan.consumesItem,
      target: { type: plan.target.type, tile: gateTile, zoneId: zone.id },
      data: plan.data ?? {},
      unlocked: false,
      isFinal: i === world.biomeZones.length - 1,
    };
    // A chasm spans several tiles so the bridge has something to cross; the
    // extra tiles follow the corridor away from the entry.
    if (inst.target.type === 'gap') {
      inst.target.tiles = gapTiles(zone, gateTile);
    }
    world.mechanisms.push(inst);

    // Scatter the items this mechanism needs, inside this zone.
    const needed = plan.items.reduce((n, e) => n + e.count, 0);
    // Loot for this gate must be reachable *without* passing it, or the player
    // would be locked away from their own key.
    const reachable = tilesBeforeGate(zone, inst.target.tile);
    const spots = pickLootSpots(zone, zoneRng, needed, inst.target.tile, reachable);
    let si = 0;
    for (const entry of plan.items) {
      for (let n = 0; n < entry.count; n++) {
        // Walk past spots another item already claimed.
        let tile = spots[si++];
        while (tile && !isFree(zone.id, tile)) tile = spots[si++];
        tile ??= reachable.find((t) => isFree(zone.id, t)) ?? zoneRng.pick(zone.tiles);
        claim(zone.id, tile);
        world.pickups.push({
          uid: `pickup-${zone.id}-${entry.id}-${n}`,
          itemId: entry.id,
          zoneId: zone.id,
          tile,
          taken: false,
          forMechanism: inst.uid,
        });
      }
      grant(zone.id, entry.id);
    }

    // Cross-biome mechanisms plant their tool in an earlier biome instead.
    if (inst.data.crossBiome) {
      const sourceZone = world.biomeZones[zoneRng.int(0, i - 1)];
      const sourceGate = world.mechanisms.find((m) => m.zoneId === sourceZone.id)?.target.tile;
      const sourceReachable = sourceGate
        ? tilesBeforeGate(sourceZone, sourceGate)
        : sourceZone.tiles;
      const crossRng = rng.fork(`cross:${zone.id}`);
      const crossSpots = pickLootSpots(sourceZone, crossRng, 4, sourceZone.exit, sourceReachable);
      const tile =
        crossSpots.find((t) => isFree(sourceZone.id, t)) ??
        sourceReachable.find((t) => isFree(sourceZone.id, t)) ??
        crossSpots[0];
      claim(sourceZone.id, tile);
      world.pickups.push({
        uid: `pickup-cross-${zone.id}`,
        itemId: inst.requires[0],
        zoneId: sourceZone.id,
        tile,
        taken: false,
        forMechanism: inst.uid,
      });
      inst.data.sourceZoneId = sourceZone.id;
      grant(sourceZone.id, inst.requires[0]);
    }
  });

  // The magic compass: early, in the first biome, a few steps from the entry.
  const first = world.biomeZones[0];
  const compassRng = root.fork('compass');
  const compassTile = pickNearTile(first, compassRng, first.entry, 3, 8, isFree);
  claim(first.id, compassTile);
  world.pickups.push({
    uid: 'pickup-compass',
    itemId: 'compass',
    zoneId: first.id,
    tile: compassTile,
    taken: false,
    forMechanism: null,
  });
  grant(first.id, 'compass');
}

/**
 * The blocking tile must be a genuine chokepoint: removing it has to cut the
 * exit off from the entry, otherwise the player just walks around the gate.
 *
 * We walk the entry->exit path backwards from the exit and take the first tile
 * that is a true cut vertex, leaving as much of the maze as possible on the
 * player's side (so there is room to hide the loot).
 */
function placeBlockingTile(zone: Zone): Tile {
  const path = findPath(zone.maze, zone.entry, zone.exit) ?? [zone.exit];

  // Walk from the exit back toward the entry; prefer the chokepoint nearest
  // the exit so the bulk of the maze stays explorable before it.
  for (let i = path.length - 1; i > 0; i--) {
    const t = path[i];
    if (t.x === zone.entry.x && t.y === zone.entry.y) continue;
    if (isCutVertex(zone, t)) return t;
  }
  // Perfect mazes always have one; braided ones might not near the exit.
  return path[Math.max(0, path.length - 2)];
}

/** Does blocking `tile` disconnect the zone exit from its entry? */
function isCutVertex(zone: Zone, tile: Tile): boolean {
  const { w, grid } = zone.maze;
  const idx = tile.y * w + tile.x;
  if (grid[idx] !== CELL.FLOOR) return false;

  const probe = Uint8Array.from(grid);
  probe[idx] = CELL.WALL;
  const dist = bfsDistances({ ...zone.maze, grid: probe }, zone.entry);
  return dist[zone.exit.y * w + zone.exit.x] < 0;
}

/**
 * The tiles a chasm covers: the gate tile plus up to two more following the
 * passage away from the entry, so the bridge is worth watching being built.
 */
function gapTiles(zone: Zone, gate: Tile): Tile[] {
  const { w, grid } = zone.maze;
  const dist = bfsDistances(zone.maze, zone.entry);
  const out: Tile[] = [gate];
  let cur = gate;
  for (let i = 0; i < 2; i++) {
    const d = dist[cur.y * w + cur.x];
    // Continue in the direction that leads further from the entry.
    const next = neighbours(cur).find(
      (p) =>
        p.x > 0 && p.y > 0 && p.x < w - 1 && p.y < zone.maze.h - 1 &&
        grid[p.y * w + p.x] === CELL.FLOOR &&
        dist[p.y * w + p.x] === d + 1 &&
        !out.some((o) => o.x === p.x && o.y === p.y),
    );
    if (!next) break;
    out.push(next);
    cur = next;
  }
  return out;
}

/** Tiles reachable from the entry without crossing the mechanism's gate. */
function tilesBeforeGate(zone: Zone, gate: Tile): Tile[] {
  const { w, grid } = zone.maze;
  const probe = Uint8Array.from(grid);
  probe[gate.y * w + gate.x] = CELL.WALL;
  const dist = bfsDistances({ ...zone.maze, grid: probe }, zone.entry);
  return zone.tiles.filter((t) => dist[t.y * w + t.x] >= 0);
}

/**
 * Loot spots: far from the entry, biased toward dead ends so items feel hidden
 * rather than dropped on the main path, and spread out across the ranking.
 */
function pickLootSpots(zone: Zone, rng: Rng, n: number, awayFrom: Tile, from?: Tile[]): Tile[] {
  if (n <= 0) return [];
  const dist = bfsDistances(zone.maze, zone.entry);
  const { w } = zone.maze;
  const deadEnds = new Set(zone.deadEnds.map((e) => `${e.x},${e.y}`));

  const scored = (from ?? zone.tiles)
    .filter((t) => !(t.x === awayFrom.x && t.y === awayFrom.y))
    .map((t) => {
      const d = dist[t.y * w + t.x];
      return {
        t,
        score: (d < 0 ? 0 : d) + (deadEnds.has(`${t.x},${t.y}`) ? 14 : 0) + rng.float(0, 6),
      };
    })
    .sort((a, b) => b.score - a.score);

  const out: Tile[] = [];
  const stride = Math.max(1, Math.floor(scored.length / (n * 2)));
  for (let i = 0; i < n && i * stride < scored.length; i++) out.push(scored[i * stride].t);
  while (out.length < n && scored.length) out.push(rng.pick(scored).t);
  return out;
}

/** A tile roughly `min..max` steps from a reference tile. */
function pickNearTile(
  zone: Zone,
  rng: Rng,
  from: Tile,
  min: number,
  max: number,
  isFree?: (zoneId: string, t: Tile) => boolean,
): Tile {
  const dist = bfsDistances(zone.maze, from);
  const { w } = zone.maze;
  const inBand = zone.tiles.filter((t) => {
    const d = dist[t.y * w + t.x];
    return d >= min && d <= max;
  });
  const free = isFree ? inBand.filter((t) => isFree(zone.id, t)) : inBand;
  return rng.pick(free.length ? free : inBand.length ? inBand : zone.tiles);
}

/**
 * Signposts: at every zone entry, plus at each blocked passage. Text derives
 * from the mechanism registry, so a new mechanism gets hints for free.
 *
 * Biome names never appear here: a signpost describes the place through its
 * blurb and points the way, but naming the biome — this one or the next —
 * would announce what the player is meant to walk into and discover.
 */
function placeSignposts(world: World, root: Rng, taken: Set<string>): void {
  const rng = root.fork('signposts');

  world.zones.forEach((zone, zi) => {
    const mech = world.mechanisms.find((m) => m.zoneId === zone.id);
    const nextZone = world.zones[zi + 1];
    const lines: string[] = [];

    if (zone.kind === 'biome') {
      if (zone.style.blurb) lines.push(zone.style.blurb);
    } else {
      lines.push(nextZone ? 'Un corridor. Il mène ailleurs.' : 'Un corridor vers la sortie.');
    }

    lines.push(
      nextZone
        ? 'Direction : plein est.'
        : 'Direction : plein est, vers la sortie finale.',
    );

    if (mech) lines.push(mechanismHint(mech));

    const loot = [...new Set(world.grantedByZone.get(zone.id) ?? [])];
    if (loot.length) {
      lines.push(`On trouve ici : ${loot.map((id) => ITEMS[id]?.name ?? id).join(', ')}.`);
    }

    world.signposts.push({
      uid: `sign-${zone.id}-entry`,
      zoneId: zone.id,
      tile: neighbourOf(zone, zone.entry, rng, taken),
      title: zone.kind === 'biome' ? 'Panneau' : 'Corridor',
      lines,
    });

    if (mech) {
      world.signposts.push({
        uid: `sign-${zone.id}-gate`,
        zoneId: zone.id,
        tile: neighbourOf(zone, mech.target.tile, rng, taken),
        title: 'Passage bloqué',
        lines: [mechanismHint(mech)],
        mechanismUid: mech.uid,
      });
    }
  });
}

function neighbours(t: Tile): Tile[] {
  return [
    { x: t.x, y: t.y - 1 },
    { x: t.x + 1, y: t.y },
    { x: t.x, y: t.y + 1 },
    { x: t.x - 1, y: t.y },
  ];
}

/**
 * A walkable tile adjacent to `tile`, avoiding anything already taken.
 * Signposts and teleporters both sit near a zone entry, so without the
 * exclusion set they can land on the same tile and visually overlap.
 */
function neighbourOf(zone: Zone, tile: Tile, rng: Rng, taken?: Set<string>): Tile {
  const { w, grid } = zone.maze;
  const inBounds = (p: Tile) =>
    p.x >= 0 && p.y >= 0 && p.x < w && p.y < zone.maze.h && grid[p.y * w + p.x] === CELL.FLOOR;

  const key = (p: Tile) => `${zone.id}:${p.x},${p.y}`;
  const free = neighbours(tile).filter(inBounds);
  const unused = taken ? free.filter((p) => !taken.has(key(p))) : free;

  let pick: Tile;
  if (unused.length) {
    pick = rng.pick(unused);
  } else {
    // Dead-end entries have a single neighbour; widen to the next ring rather
    // than stacking two entities on the same tile.
    const ring2 = free
      .flatMap((p) => neighbours(p))
      .filter((p) => inBounds(p) && !taken?.has(key(p)) && !(p.x === tile.x && p.y === tile.y));
    pick = ring2.length ? rng.pick(ring2) : free.length ? rng.pick(free) : tile;
  }
  taken?.add(key(pick));
  return pick;
}

/**
 * One teleporter at each biome entry; unlocked as the player arrives.
 *
 * Labels are positional ("Secteur 2"), never the biome name: naming the biome
 * would spoil what is ahead, and the number matches the west-to-east order the
 * player actually walks, so it stays a usable landmark.
 */
function placeTeleporters(world: World, root: Rng, taken: Set<string>): void {
  const rng = root.fork('teleporters');
  let n = 0;
  for (const zone of world.zones) {
    if (zone.kind !== 'biome') continue;
    n++;
    world.teleporters.push({
      uid: `tp-${zone.id}`,
      zoneId: zone.id,
      tile: neighbourOf(zone, zone.entry, rng, taken),
      label: `Secteur ${n}`,
      discovered: false,
    });
  }
}

/**
 * World coordinates of the CENTRE of a zone tile.
 * Every tile -> world conversion must go through here (or `tileOrigin`), so the
 * TILE scale stays a single knob rather than 36 scattered `+ 0.5` sites.
 */
export function tileToWorld(zone: Zone, tile: Tile): Vec2 {
  return {
    x: (zone.originX + tile.x) * TILE + TILE / 2,
    z: (zone.originZ + tile.y) * TILE + TILE / 2,
  };
}

/** World coordinates of a tile's low corner (for placing voxels). */
export function tileOrigin(zone: Zone, tile: Tile): Vec2 {
  return { x: (zone.originX + tile.x) * TILE, z: (zone.originZ + tile.y) * TILE };
}

/** Scale a world-space link tile (already in zone-grid units). */
export function linkToWorld(l: Vec2): Vec2 {
  return { x: l.x * TILE, z: l.z * TILE };
}

export function zoneById(world: World, id: string): Zone | undefined {
  return world.zones.find((z) => z.id === id);
}

/** Which zone contains a world-space X coordinate (for ambience switching). */
export function zoneAtWorldX(world: World, worldX: number): Zone {
  const x = worldX / TILE; // back into zone-grid units
  let best = world.zones[0];
  for (const z of world.zones) {
    if (x >= z.originX - ZONE_GUTTER / 2 && x < z.originX + z.w + ZONE_GUTTER / 2) return z;
    if (x >= z.originX) best = z;
  }
  return best;
}
