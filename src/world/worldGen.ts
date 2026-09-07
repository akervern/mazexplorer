/**
 * World generation: biome graph -> per-biome mazes -> mechanisms, items,
 * signposts, teleporters. Everything derives from the seed via forked rngs so
 * that adding a step in one area does not reshuffle another.
 *
 * The biome graph is a DAG, not a chain: a zone may open onto two or more
 * neighbours, the branches reconverge before the final zone, and some branches
 * are dead ends holding loot. Zones are placed freely in 2D (X grows with
 * graph depth, Z spreads siblings apart), each keeps its own maze grid in
 * local coordinates, and `originX`/`originZ` put them all in one global grid
 * that the voxel builder and the minimap share.
 */

import { Rng } from '../core/rng.js';
import { TILE } from '../core/types.js';
import type {
  GameConfig,
  Mechanism,
  MechanismTypeId,
  Side,
  SizeKey,
  Tile,
  Vec2,
  World,
  Zone,
  ZoneGate,
} from '../core/types.js';
import { BIOMES, BIOME_POOL } from './biomes.js';
import { ITEMS } from './items.js';
import type { ItemRole, MechanismPlan, PlanContext } from './unlockMechanisms.js';
import { MECHANISM_TYPES, mechanismHint, pickMechanismType } from './unlockMechanisms.js';
import { CELL, bfsDistances, findDeadEnds, findPath, generateMaze, walkableTiles } from './maze.js';

export interface SizePreset {
  label: string;
  biomes: number;
  cells: number;
  minutes: string;
}

/** Size presets: biome count and maze dimensions. Tuned for ~20-30 min at medium. */
export const SIZE_PRESETS: Record<SizeKey, SizePreset> = {
  small: { label: 'Petit', biomes: 3, cells: 7, minutes: '10-15' },
  medium: { label: 'Moyen', biomes: 5, cells: 10, minutes: '20-30' },
  large: { label: 'Grand', biomes: 6, cells: 13, minutes: '35-50' },
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

/**
 * A node of the biome DAG, before any geometry exists.
 *
 * `children` are the zones this one opens onto. The graph is built rank by
 * rank: every rank feeds the next, so no edge ever points backwards and the
 * whole thing stays a DAG — which is what lets the gating stay provable (a
 * cycle would let the player walk around a gate through the back door).
 */
interface GraphNode {
  index: number;
  rank: number;
  children: number[];
  /** Nothing on the critical path depends on this node: it holds loot only. */
  optional: boolean;
}

/**
 * Build the biome graph: a spine of ranks from the start zone to the final
 * one, widened so some ranks hold two zones side by side, plus a few dead-end
 * branches hanging off it.
 *
 * A rank of two zones is what makes the world non-linear: the zone before it
 * gets two gates, the player picks a side, and the two routes rejoin at the
 * next rank. Both sides are always walkable to the end — the choice is which
 * biome you cross, never whether you can finish.
 */
function buildBiomeGraph(rng: Rng, depth: number): GraphNode[] {
  const nodes: GraphNode[] = [];
  const add = (rank: number, optional: boolean): number => {
    nodes.push({ index: nodes.length, rank, children: [], optional });
    return nodes.length - 1;
  };

  // The start and the final zone are always alone on their rank: the run has
  // one opening and one ending.
  const start = add(0, false);
  let prevRank = [start];

  // `depth` counts the biomes on a single route, not the zones in the world:
  // widening a rank adds a zone without making the run longer, so the two must
  // not share a budget — otherwise every fork shortens the game to pay for
  // itself, which is how the first version ended up never forking at medium.
  const middleRanks = Math.max(1, depth - 2);
  // Wide ranks — where the world actually forks. At least one whenever there
  // is more than a single middle rank, so a run always offers a real choice.
  const wideCount = middleRanks >= 2 ? rng.int(1, Math.min(2, middleRanks - 1)) : 0;
  const wideRanks = new Set(
    rng.sample(
      Array.from({ length: middleRanks }, (_, i) => i),
      wideCount,
    ),
  );

  for (let i = 0; i < middleRanks; i++) {
    const width = wideRanks.has(i) ? 2 : 1;
    const cur: number[] = [];
    for (let k = 0; k < width; k++) cur.push(add(i + 1, false));
    // Every zone of the previous rank opens onto every zone of this one, so a
    // widening rank hands the player a real choice and a narrowing one
    // reconverges whichever side they took — both routes always reach the end.
    for (const p of prevRank) nodes[p].children.push(...cur);
    prevRank = cur;
  }

  const final = add(middleRanks + 1, false);
  for (const p of prevRank) nodes[p].children.push(final);

  // Dead-end branches: extra passages off a mid-graph zone, leading nowhere but
  // to their own loot. Never off the start (the player would take one for the
  // way on) and never off the final zone.
  const hosts = nodes.filter((n) => !n.optional && n.rank > 0 && n.index !== final);
  // Always at least one, so even the smallest world has somewhere optional to
  // go — a run with a single route through it is the linear world this graph
  // replaced.
  const branchCount = Math.min(2, Math.max(1, Math.floor(middleRanks / 2)));
  for (const host of rng.sample(hosts, branchCount)) {
    const leaf = add(host.rank + 1, true);
    host.children.push(leaf);
  }

  return nodes;
}

export function generateWorld(config: GameConfig): World {
  const preset = SIZE_PRESETS[config.size] ?? SIZE_PRESETS.medium;
  // How many biomes one route crosses. The world holds more zones than this —
  // the alternative routes and the dead-end branches sit beside them.
  const depth = Math.max(2, Math.min(6, config.biomeCount ?? preset.biomes));
  const root = new Rng(config.seed);

  // --- 1. Biome graph ---------------------------------------------------
  // Its own fork: the graph decides how many zones exist, so drawing it from
  // an existing stream would shift every later step of every seed.
  const graph = buildBiomeGraph(root.fork('biome-graph'), depth);

  // --- 2. Biome styles --------------------------------------------------
  // Every biome is drawn by the seed, the starting one included: nothing is
  // pinned to the front, so two seeds rarely open on the same mood. The graph
  // holds more zones than the pool has biomes, so the shuffled pool is dealt
  // out cyclically — two zones may share a mood, never a maze.
  const orderRng = root.fork('biome-order');
  const pool = orderRng.shuffle(BIOME_POOL);
  const biomeOf = (i: number) => pool[i % pool.length];

  // --- 3. Zones (one maze per node, placed in 2D) -----------------------
  const zones: Zone[] = graph.map((node) =>
    buildBiomeZone(root.fork(`biome:${biomeOf(node.index)}:${node.index}`), biomeOf(node.index), node, preset),
  );
  layoutZones(zones, graph);

  // --- 4. Passages ------------------------------------------------------
  // Carve one gate per graph edge and fill the gutters, so the world is one
  // continuous walkable space with several routes through it.
  linkZones(zones, graph, root.fork('gates'));

  const last = zones[zones.length - 1];
  const finalZone = zones.find((z) => z.gates.length === 0 && !z.optional) ?? last;
  const bounds = zoneBounds(zones);

  const world: World = {
    seed: config.seed,
    size: config.size,
    biomeCount: zones.length,
    zones,
    mechanisms: [],
    pickups: [],
    signposts: [],
    teleporters: [],
    grantedByZone: new Map(),
    width: bounds.maxX - bounds.minX,
    start: zones[0].entry,
    startZoneId: zones[0].id,
    exit: { zoneId: finalZone.id, tile: finalZone.exit },
  };

  planProgression(world, root, config.forceMechanism);
  // Tiles already claimed by an entity, so signposts, teleporters and pickups
  // never stack on the same spot. Keyed per zone: `zoneId:x,y`.
  const taken = new Set<string>();
  for (const p of world.pickups) taken.add(`${p.zoneId}:${p.tile.x},${p.tile.y}`);
  placeSignposts(world, root, taken);
  placeTeleporters(world, root, taken);

  return world;
}

function buildBiomeZone(rng: Rng, biomeId: string, node: GraphNode, preset: SizePreset): Zone {
  const biome = BIOMES[biomeId];
  const cells = Math.max(4, Math.round(preset.cells * (biome.mazeScale ?? 1)));
  const maze = generateMaze(rng.fork('maze'), cells, cells, { braid: 0.08, loop: 0.15 });
  const tiles = walkableTiles(maze);

  return {
    id: `biome-${node.index}-${biomeId}`,
    index: node.index,
    biomeId,
    style: biome,
    maze,
    w: maze.w,
    h: maze.h,
    // Filled in by layoutZones once every maze size is known.
    originX: 0,
    originZ: 0,
    rank: node.rank,
    // Placeholders: linkZones carves the real portals per graph edge.
    entry: pickEdgeTile(tiles, maze.h, 'west'),
    exit: pickEdgeTile(tiles, maze.h, 'east'),
    gates: [],
    optional: node.optional,
    tiles,
    deadEnds: findDeadEnds(maze.grid, maze.w, maze.h),
    links: [],
  };
}

/**
 * Place the zones in the global grid: X follows graph depth (so the run still
 * reads west to east and "Secteur N" keeps its meaning), Z spreads the zones
 * of a rank apart.
 *
 * Mazes differ in size, so a rank's column is as wide as its widest zone and
 * each rank starts past the previous one — no two zones can overlap, which
 * would merge two mazes into one unwalkable soup of grids.
 */
function layoutZones(zones: Zone[], graph: GraphNode[]): void {
  const byIndex = new Map(zones.map((z) => [z.index, z]));

  // Optional branches are laid out beside their host, not in their rank's
  // stack. They hang off one zone rather than continuing the spine, and a
  // branch parked in the stack ends up dozens of tiles away from the zone it
  // is attached to — a gutter that long cannot reach it without crossing a
  // maze on the way.
  const hostOf = new Map<number, number>();
  for (const node of graph) {
    for (const child of node.children) {
      if (byIndex.get(child)!.optional) hostOf.set(child, node.index);
    }
  }

  const ranks = new Map<number, Zone[]>();
  for (const z of zones) {
    if (hostOf.has(z.index)) continue;
    const list = ranks.get(z.rank) ?? [];
    list.push(z);
    ranks.set(z.rank, list);
  }

  let cursorX = 0;
  for (const rank of [...ranks.keys()].sort((a, b) => a - b)) {
    const list = ranks.get(rank)!;
    const colWidth = Math.max(...list.map((z) => z.w));

    // Stack the rank's zones on Z around 0, so the spine stays centred and a
    // fork reads as two routes above and below the axis.
    const totalH = list.reduce((n, z) => n + z.h, 0) + ZONE_GUTTER * (list.length - 1);
    let cursorZ = -Math.floor(totalH / 2);
    for (const z of list) {
      // Left-align inside the rank's column: a centred narrow maze pushes its
      // own east edge inward and lengthens the gutter leaving it.
      z.originX = cursorX;
      z.originZ = cursorZ;
      cursorZ += z.h + ZONE_GUTTER;
    }
    cursorX += colWidth + ZONE_GUTTER;
  }

  // Now hang each branch directly north or south of its host, in the host's
  // own column, so its gutter is a short straight run on X.
  for (const [childIndex, hostIndex] of hostOf) {
    const child = byIndex.get(childIndex)!;
    const host = byIndex.get(hostIndex)!;
    child.originX = host.originX;
    // Below the host by default, above it when that would collide.
    const below = host.originZ + host.h + ZONE_GUTTER;
    const above = host.originZ - child.h - ZONE_GUTTER;
    child.originZ = below;
    if (collides(child, zones)) {
      child.originZ = above;
      // Both sides taken: step further out below until it is clear.
      for (let n = 1; n <= 8 && collides(child, zones); n++) {
        child.originZ = below + n * (child.h + ZONE_GUTTER);
      }
    }
  }
}

/** Does `zone` overlap any other zone's box, gutter included? */
function collides(zone: Zone, zones: Zone[]): boolean {
  return zones.some(
    (o) =>
      o !== zone &&
      zone.originX < o.originX + o.w + ZONE_GUTTER &&
      o.originX < zone.originX + zone.w + ZONE_GUTTER &&
      zone.originZ < o.originZ + o.h + ZONE_GUTTER &&
      o.originZ < zone.originZ + zone.h + ZONE_GUTTER,
  );
}

function zoneBounds(zones: Zone[]): { minX: number; maxX: number; minZ: number; maxZ: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const z of zones) {
    minX = Math.min(minX, z.originX);
    maxX = Math.max(maxX, z.originX + z.w);
    minZ = Math.min(minZ, z.originZ);
    maxZ = Math.max(maxZ, z.originZ + z.h);
  }
  return { minX, maxX, minZ, maxZ };
}

const OPPOSITE: Record<Side, Side> = {
  north: 'south',
  east: 'west',
  south: 'north',
  west: 'east',
};

/**
 * Carve one passage per graph edge and fill the gutter between the two zones.
 *
 * Each edge picks the side of the source zone that faces its destination, so a
 * zone with two children opens on two different sides and the two routes are
 * visibly distinct from inside the maze. A zone reached by several parents
 * keeps ONE entry tile: `entry` is where progression starts from, and every
 * gate on it must be a chokepoint against that single tile.
 */
function linkZones(zones: Zone[], graph: GraphNode[], rng: Rng): void {
  const byIndex = new Map(zones.map((z) => [z.index, z]));

  // Entry side of each zone, decided by the first parent that reaches it.
  const entrySide = new Map<number, Side>();

  for (const node of graph) {
    const a = byIndex.get(node.index)!;
    // Sides already spoken for in this zone, so two gates never share one.
    const usedSides = new Set<Side>();
    const aEntry = entrySide.get(node.index);
    if (aEntry) usedSides.add(aEntry);
    // Tiles each new portal must stay clear of: the entry, then every portal
    // already carved here.
    const spread: Tile[] = aEntry || node.index === 0 ? [a.entry] : [];

    for (const childIndex of node.children) {
      const b = byIndex.get(childIndex)!;
      const side = pickSide(a, b, usedSides, rng);
      usedSides.add(side);

      // Keep the portal clear of the entry and of its siblings: see carveToSide.
      const from = carveToSide(a, side, rng, spread);
      spread.push(from);
      // The destination is entered from the opposite side, once: later parents
      // route their gutter to that same tile rather than punching a second
      // entry, so the zone keeps one entry for progression to reason about.
      let to: Tile;
      if (entrySide.has(childIndex)) {
        to = b.entry;
      } else {
        const toSide = OPPOSITE[side];
        // Aim the entry at the source portal's own line, so the gutter is a
        // straight run rather than an L that has to dodge two mazes.
        const facing = side === 'east' || side === 'west'
          ? a.originZ + from.y
          : a.originX + from.x;
        to = carveToSide(b, toSide, rng, [], facing);
        b.entry = to;
        entrySide.set(childIndex, toSide);
      }

      a.gates.push({
        toZoneId: b.id,
        tile: from,
        side,
        toTile: to,
        optional: byIndex.get(childIndex)!.optional,
      });
      carveGutter(a, from, side, b, to, zones);
    }
  }

  // A gutter leg may clip the corner of a zone's grid — the portals are on the
  // zone edges and the L between them is not always able to stay outside both
  // boxes. Where that happens the link tile sits on top of a wall: the
  // renderer draws floor there and the player walks through, but the wall is
  // still in the maze, so the corridor reads as a trench cut across the biome.
  // Open those tiles in the maze itself, so geometry and grid agree.
  openLinkTiles(zones);

  // Independent approaches for zones that branch. Spacing the portals apart is
  // not enough on its own: in a maze this lightly looped, two portals on
  // opposite sides can still be reached only through one shared corridor near
  // the entry, and then one gate always locks the other away.
  for (const z of zones) {
    if (z.gates.length > 1) ensureIndependentApproaches(z);
  }

  // A zone with no outgoing edge ends on its entry side's far corner: the
  // final zone's `exit` is the end of the run, a dead-end branch's is unused
  // but still marked so the dev map can show it.
  for (const z of zones) {
    if (z.gates.length) {
      // `exit` is only meaningful on a leaf; on a branching zone point it at
      // the first gate so anything reading it still lands on a real passage.
      z.exit = z.gates[0].tile;
    } else {
      z.exit = farthestTile(z, z.entry);
    }
  }
}

/**
 * Make sure each of a branching zone's portals can be gated on its own.
 *
 * `placeBlockingTiles` needs, for every portal, a cut vertex that isolates it
 * without isolating the others. When the portals share their whole approach no
 * such tile exists, and the two "alternative" routes become a forced order —
 * open one gate to reach the other.
 *
 * Rather than give up and hang the gates at the portals' mouths, knock out a
 * wall to open a second approach. Kruskal already leaves plenty of walls
 * between connected cells, so this is the same operation as the `loop` knob,
 * applied where the topology demands it instead of at random.
 */
function ensureIndependentApproaches(zone: Zone): void {
  const portals = zone.gates.map((g) => g.tile);
  if (placeBlockingTiles(zone, portals, true)) return;

  const { w, h, grid } = zone.maze;
  // Candidate walls: interior walls between two cells, nearest the portals
  // first so the new passage joins the branches that need separating.
  const walls: Tile[] = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (grid[y * w + x] !== CELL.WALL) continue;
      // Only walls with walkable neighbours on opposite sides: knocking out a
      // corner would open a diagonal the player cannot walk through anyway.
      const hOpen = grid[y * w + x - 1] === CELL.FLOOR && grid[y * w + x + 1] === CELL.FLOOR;
      const vOpen = grid[(y - 1) * w + x] === CELL.FLOOR && grid[(y + 1) * w + x] === CELL.FLOOR;
      if (hOpen || vOpen) walls.push({ x, y });
    }
  }

  // Try them in a deterministic order — nearest the portals' midpoint first,
  // so the shortcut lands between the two branches rather than across the map.
  const mid = {
    x: portals.reduce((n, p) => n + p.x, 0) / portals.length,
    y: portals.reduce((n, p) => n + p.y, 0) / portals.length,
  };
  walls.sort(
    (a, b) =>
      (a.x - mid.x) ** 2 + (a.y - mid.y) ** 2 - ((b.x - mid.x) ** 2 + (b.y - mid.y) ** 2),
  );

  for (const wall of walls) {
    grid[wall.y * w + wall.x] = CELL.FLOOR;
    if (placeBlockingTiles(zone, portals, true)) {
      zone.tiles = walkableTiles(zone.maze);
      zone.deadEnds = findDeadEnds(grid, w, h);
      return;
    }
    grid[wall.y * w + wall.x] = CELL.WALL; // undo and try the next
  }
}

/**
 * Make the maze agree with the gutters that cross it.
 *
 * A link tile inside a zone's grid must be floor there too, or the voxel
 * builder lays a corridor over tiles the maze still calls wall — and the two
 * disagree about what is solid.
 */
function openLinkTiles(zones: Zone[]): void {
  let touched = false;
  for (const owner of zones) {
    for (const l of owner.links) {
      for (const z of zones) {
        if (l.x < z.originX || l.x >= z.originX + z.w) continue;
        if (l.z < z.originZ || l.z >= z.originZ + z.h) continue;
        const lx = l.x - z.originX;
        const lz = l.z - z.originZ;
        const idx = lz * z.maze.w + lx;
        if (z.maze.grid[idx] === CELL.FLOOR) continue;
        z.maze.grid[idx] = CELL.FLOOR;
        touched = true;
      }
    }
  }
  if (!touched) return;
  for (const z of zones) {
    z.tiles = walkableTiles(z.maze);
    z.deadEnds = findDeadEnds(z.maze.grid, z.maze.w, z.maze.h);
  }
}

/** The walkable tile of `zone` furthest from `from` — where a leaf zone ends. */
function farthestTile(zone: Zone, from: Tile): Tile {
  const dist = bfsDistances(zone.maze, from);
  const { w } = zone.maze;
  let best = from;
  let bestD = -1;
  for (const t of zone.tiles) {
    const d = dist[t.y * w + t.x];
    if (d > bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

/**
 * Which side of `a` faces `b`. The dominant axis of the offset between the two
 * zone centres wins, so a branch placed above its host opens north rather than
 * east; a side already used by another passage falls back to the next best.
 */
function pickSide(a: Zone, b: Zone, used: Set<Side>, rng: Rng): Side {
  const dx = b.originX + b.w / 2 - (a.originX + a.w / 2);
  const dz = b.originZ + b.h / 2 - (a.originZ + a.h / 2);

  const horizontal: Side = dx >= 0 ? 'east' : 'west';
  const vertical: Side = dz >= 0 ? 'south' : 'north';
  const order: Side[] =
    Math.abs(dx) >= Math.abs(dz)
      ? [horizontal, vertical, OPPOSITE[vertical], OPPOSITE[horizontal]]
      : [vertical, horizontal, OPPOSITE[horizontal], OPPOSITE[vertical]];

  return order.find((s) => !used.has(s)) ?? rng.pick(order);
}

/**
 * Open a corridor from a walkable tile out to `side`, and return that tile.
 *
 * The tile is drawn from those already nearest that edge so the carve is short
 * — a long straight run punched across the maze would erase the corridors it
 * crosses and flatten the whole side of the zone.
 *
 * `avoid` holds the tiles the portal must keep its distance from: the zone's
 * entry, and every portal already carved into it. A portal opened right beside
 * one of those shares its corridor, and then no tile can gate that passage
 * without also sealing the other off — the two routes stop being independent
 * alternatives and become a forced order. Candidates too close are dropped.
 */
function carveToSide(zone: Zone, side: Side, rng: Rng, avoid: Tile[] = [], facing?: number): Tile {
  let pool = zone.tiles;
  if (avoid.length) {
    const { w } = zone.maze;
    // Far enough that each portal's approach is its own branch of the maze. A
    // quarter of the span is enough in practice and still leaves candidates
    // along every side.
    const minDist = Math.floor(Math.max(zone.w, zone.h) / 4);
    const far = zone.tiles.filter((t) =>
      avoid.every((a) => {
        const dist = bfsDistances(zone.maze, a);
        return dist[t.y * w + t.x] >= minDist;
      }),
    );
    if (far.length) pool = far;
  }
  // `facing` is a global-grid line the portal should sit on if it can: the
  // source portal's own row (or column). Facing portals let the gutter run
  // almost straight, and a straight gutter cannot re-enter either maze. Without
  // it the two portals are picked independently and the L between them often
  // has no route that stays outside both boxes.
  if (facing !== undefined) {
    const local = side === 'north' || side === 'south'
      ? facing - zone.originX
      : facing - zone.originZ;
    const aligned = pool.filter((t) => (side === 'north' || side === 'south' ? t.x : t.y) === local);
    if (aligned.length) pool = aligned;
  }
  const tile = pickEdgeTile(pool, side === 'north' || side === 'south' ? zone.w : zone.h, side, rng);
  const { w, h, grid } = zone.maze;

  if (side === 'east') for (let x = tile.x; x < w; x++) grid[tile.y * w + x] = CELL.FLOOR;
  else if (side === 'west') for (let x = tile.x; x >= 0; x--) grid[tile.y * w + x] = CELL.FLOOR;
  else if (side === 'south') for (let y = tile.y; y < h; y++) grid[y * w + tile.x] = CELL.FLOOR;
  else for (let y = tile.y; y >= 0; y--) grid[y * w + tile.x] = CELL.FLOOR;

  zone.tiles = walkableTiles(zone.maze);
  zone.deadEnds = findDeadEnds(grid, w, h);
  return tile;
}

/**
 * Fill the gutter between two portals as an L: run along the portal's own axis
 * first, turn once, then finish along the other. A straight interpolation
 * would leave diagonal, non-walkable gaps.
 */
function carveGutter(a: Zone, from: Tile, side: Side, b: Zone, to: Tile, zones: Zone[]): void {
  const p0 = exitPoint(a, from, side);
  const p1 = exitPoint(b, to, OPPOSITE[side]);

  const push = (x: number, z: number) => a.links.push({ x, z });
  const run = (lo: number, hi: number, fn: (v: number) => void) => {
    for (let v = Math.min(lo, hi); v <= Math.max(lo, hi); v++) fn(v);
  };

  /**
   * Does (x, z) fall inside any zone's grid?
   *
   * Every zone counts, the two being joined included: `p0` and `p1` sit on
   * their own zone's edge and are floor already, but the corridor between them
   * must stay in the gutter. A leg that re-enters either maze is carved
   * through its walls — walkable, so no invariant catches it, but on screen it
   * is a trench straight across the biome.
   */
  const insideZone = (x: number, z: number): boolean =>
    zones.some(
      (zz) =>
        x >= zz.originX &&
        x < zz.originX + zz.w &&
        z >= zz.originZ &&
        z < zz.originZ + zz.h,
    );

  // The L has one free parameter: where it turns. Zones sit in 2D now, so the
  // midpoint that served the old west-to-east chain routinely puts a leg
  // through a maze. Try every turn line and keep one whose legs stay outside
  // every zone, ignoring the two endpoints (which are edge tiles by
  // construction).
  const horizontal = side === 'east' || side === 'west';
  const [t0, t1] = horizontal ? [p0.x, p1.x] : [p0.z, p1.z];

  const clearRun = (lo: number, hi: number, at: (v: number) => [number, number]): boolean => {
    for (let v = Math.min(lo, hi); v <= Math.max(lo, hi); v++) {
      const [x, z] = at(v);
      if (x === p0.x && z === p0.z) continue;
      if (x === p1.x && z === p1.z) continue;
      if (insideZone(x, z)) return false;
    }
    return true;
  };

  const legsClear = (turn: number): boolean =>
    horizontal
      ? clearRun(p0.x, turn, (x) => [x, p0.z]) &&
        clearRun(p0.z, p1.z, (z) => [turn, z]) &&
        clearRun(turn, p1.x, (x) => [x, p1.z])
      : clearRun(p0.z, turn, (z) => [p0.x, z]) &&
        clearRun(p0.x, p1.x, (x) => [x, turn]) &&
        clearRun(turn, p1.z, (z) => [p1.x, z]);

  // Prefer a turn near the middle of the gutter — it looks like a corridor
  // rather than a tight hook against a wall — then widen the search outward.
  const mid = Math.round((t0 + t1) / 2);
  let turn = mid;
  const span = Math.abs(t1 - t0) + 2;
  for (let d = 0; d <= span; d++) {
    if (legsClear(mid + d)) {
      turn = mid + d;
      break;
    }
    if (legsClear(mid - d)) {
      turn = mid - d;
      break;
    }
  }

  if (horizontal) {
    run(p0.x, turn, (x) => push(x, p0.z));
    run(p0.z, p1.z, (z) => push(turn, z));
    run(turn, p1.x, (x) => push(x, p1.z));
  } else {
    run(p0.z, turn, (z) => push(p0.x, z));
    run(p0.x, p1.x, (x) => push(x, turn));
    run(turn, p1.z, (z) => push(p1.x, z));
  }
}

/** The global-grid tile where a carved portal meets its zone's edge. */
function exitPoint(zone: Zone, tile: Tile, side: Side): Vec2 {
  switch (side) {
    case 'east':
      return { x: zone.originX + zone.w - 1, z: zone.originZ + tile.y };
    case 'west':
      return { x: zone.originX, z: zone.originZ + tile.y };
    case 'south':
      return { x: zone.originX + tile.x, z: zone.originZ + zone.h - 1 };
    default:
      return { x: zone.originX + tile.x, z: zone.originZ };
  }
}

/**
 * Walkable tile nearest the given side, tie-broken toward the centre of that
 * edge. `rng`, when given, jitters the tie-break so two zones of the same size
 * do not always open at the exact same spot.
 */
function pickEdgeTile(tiles: Tile[], span: number, side: Side, rng?: Rng): Tile {
  let best = tiles[0];
  let bestScore = -Infinity;
  const centre = Math.floor(span / 2);
  for (const t of tiles) {
    let edge: number;
    let along: number;
    switch (side) {
      case 'west':
        edge = -t.x;
        along = t.y;
        break;
      case 'east':
        edge = t.x;
        along = t.y;
        break;
      case 'north':
        edge = -t.y;
        along = t.x;
        break;
      default:
        edge = t.y;
        along = t.x;
        break;
    }
    const score = edge * 1000 - Math.abs(along - centre) + (rng ? rng.float(0, 400) : 0);
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

/**
 * Zones the player is guaranteed to have crossed before reaching `zoneId` —
 * its dominators in the graph, minus itself.
 *
 * With branching routes, "an earlier zone" is not enough for a cross-biome
 * tool: a zone on one branch is skipped entirely by players who took the
 * other, so planting the tool there makes the run unwinnable for half the
 * seeds' playthroughs. Only a dominator is on every route.
 */
function dominatorsOf(world: World, zoneId: string): Zone[] {
  const zones = world.zones;
  const parents = new Map<string, string[]>();
  for (const z of zones) {
    for (const g of z.gates) {
      parents.set(g.toZoneId, [...(parents.get(g.toZoneId) ?? []), z.id]);
    }
  }

  const all = new Set(zones.map((z) => z.id));
  const dom = new Map<string, Set<string>>();
  // Zones are built rank by rank and each edge points to a strictly later
  // node, so a single pass in index order is enough to reach the fixpoint.
  for (const z of zones) {
    const ps = parents.get(z.id) ?? [];
    if (!ps.length) {
      dom.set(z.id, new Set([z.id]));
      continue;
    }
    // Intersect the parents' dominator sets: only a zone on every incoming
    // route dominates this one.
    let acc = new Set<string>(dom.get(ps[0]) ?? all);
    for (const p of ps.slice(1)) {
      const pd = dom.get(p) ?? all;
      acc = new Set<string>([...acc].filter((x: string) => pd.has(x)));
    }
    acc.add(z.id);
    dom.set(z.id, acc);
  }

  return zones.filter((z) => z.id !== zoneId && dom.get(zoneId)?.has(z.id));
}

/**
 * Decide which mechanism guards each passage and where its loot goes.
 *
 * One mechanism per *gate*, not per zone: a zone that opens onto two
 * neighbours has two of them, so the choice of route is also a choice of
 * puzzle. A zone with no gate — the final one, and every dead-end branch —
 * gets none; the branch's reward is its loot, not another lock.
 *
 * Balance follows the brief: 1/2/4 dominate, 3/6 appear once or twice,
 * 7 is reserved for one key transition.
 */
function planProgression(world: World, root: Rng, forced?: MechanismTypeId): void {
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

  // Every passage in the world, in a stable order.
  const passages = world.zones.flatMap((zone) => zone.gates.map((gate) => ({ zone, gate })));

  // Passages that reward exhaustive exploration, and the one transition using
  // a tool fetched from an earlier biome. Both are drawn over passages now
  // rather than zones, since a zone may hold two.
  const pi = passages.map((_, i) => i);
  const deepIdx = new Set(
    rng.sample(
      pi.filter((i) => passages[i].zone.index > 0),
      Math.min(2, Math.max(1, Math.floor(passages.length / 3))),
    ),
  );
  const crossIdx = new Set(
    rng.sample(
      pi.filter((i) => passages[i].zone.rank >= 2 && !deepIdx.has(i)),
      passages.length >= 4 ? 1 : 0,
    ),
  );

  // The zone the run ends in: the only non-optional zone with no way on.
  const finalZone = world.zones.find((z) => z.id === world.exit.zoneId)!;

  // Gate tiles are chosen per zone, all of its passages together: they
  // constrain each other, and loot must clear every gate of its zone rather
  // than only the one it belongs to.
  const gateTilesByZone = new Map<string, Tile[]>();
  for (const zone of world.zones) {
    if (!zone.gates.length) continue;
    const tiles = placeBlockingTiles(zone, zone.gates.map((g) => g.tile));
    gateTilesByZone.set(zone.id, tiles);
    // Stash each on its gate so the loop below does not recompute it.
    zone.gates.forEach((gate, i) => {
      (gate as ZoneGate & { blockTile?: Tile }).blockTile = tiles[i];
    });
  }

  passages.forEach(({ zone, gate }, i) => {
    const zoneRng = rng.fork(`gate:${zone.id}->${gate.toZoneId}`);

    // The dev bench pins one mechanism to every passage so it can be inspected
    // on demand. `forced` is only ever set from `src/dev/`; a normal run never
    // reaches this branch, so the draws below stay identical for every seed.
    let allowed: MechanismTypeId[];
    if (forced) allowed = [forced];
    else if (crossIdx.has(i)) allowed = ['cross_biome_tool'];
    else if (deepIdx.has(i)) allowed = ['fragment_set', 'light_threshold'];
    else allowed = ['key_door', 'pedestal_offering', 'break_obstacle', 'activate_bridge'];

    const typeId = pickMechanismType(zoneRng, allowed);

    // Zones guaranteed to be crossed before this one: the only safe home for a
    // cross-biome tool.
    const dominators = dominatorsOf(world, zone.id);

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
        if (!dominators.length) return null;
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

    const gateTile = (gate as ZoneGate & { blockTile?: Tile }).blockTile ?? gate.tile;
    const inst: Mechanism = {
      uid: `mech-${zone.id}-to-${gate.toZoneId}`,
      type: resolvedType,
      zoneId: zone.id,
      toZoneId: gate.toZoneId,
      requires: plan.requires,
      consumesItem: plan.consumesItem,
      target: { type: plan.target.type, tile: gateTile, zoneId: zone.id },
      data: plan.data ?? {},
      unlocked: false,
      // The run ends past the last gate into the final zone, whichever branch
      // the player came through.
      isFinal: gate.toZoneId === finalZone.id,
    };
    // A chasm spans several tiles so the bridge has something to cross; the
    // extra tiles follow the corridor away from the entry.
    if (inst.target.type === 'gap') {
      inst.target.tiles = gapTiles(zone, gateTile);
    }
    world.mechanisms.push(inst);
    gate.mechanismUid = inst.uid;

    // Scatter the items this mechanism needs, inside this zone.
    const needed = plan.items.reduce((n, e) => n + e.count, 0);
    // Loot for this gate must be reachable *without* passing any gate of the
    // zone, or the player would be locked away from their own key — or forced
    // to open one route before the other.
    const reachable = tilesBeforeGates(zone, gateTilesByZone.get(zone.id) ?? []);
    const spots = pickLootSpots(zone, zoneRng, needed, gateTile, reachable);
    let si = 0;
    for (const entry of plan.items) {
      for (let n = 0; n < entry.count; n++) {
        // Walk past spots another item already claimed.
        let tile = spots[si++];
        while (tile && !isFree(zone.id, tile)) tile = spots[si++];
        tile ??= reachable.find((t) => isFree(zone.id, t)) ?? zoneRng.pick(zone.tiles);
        claim(zone.id, tile);
        world.pickups.push({
          uid: `pickup-${inst.uid}-${entry.id}-${n}`,
          itemId: entry.id,
          zoneId: zone.id,
          tile,
          taken: false,
          forMechanism: inst.uid,
        });
      }
      grant(zone.id, entry.id);
    }

    // Cross-biome mechanisms plant their tool in a dominator instead — a zone
    // every route passes through, so the tool is never on the branch the
    // player skipped.
    if (inst.data.crossBiome && dominators.length) {
      const sourceZone = dominators[zoneRng.int(0, dominators.length - 1)];
      const sourceGates = gateTilesByZone.get(sourceZone.id) ?? [];
      const sourceReachable = tilesBeforeGates(sourceZone, sourceGates);
      const crossRng = rng.fork(`cross:${inst.uid}`);
      const crossSpots = pickLootSpots(sourceZone, crossRng, 4, sourceZone.exit, sourceReachable);
      const tile =
        crossSpots.find((t) => isFree(sourceZone.id, t)) ??
        sourceReachable.find((t) => isFree(sourceZone.id, t)) ??
        crossSpots[0];
      claim(sourceZone.id, tile);
      world.pickups.push({
        uid: `pickup-cross-${inst.uid}`,
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

  // Dead-end branches hold a reward rather than a lock: without one there is
  // no reason to walk down a passage that leads nowhere.
  placeBranchRewards(world, root.fork('branch-loot'), claim, isFree, grant, usedItems);

  // The magic compass: early, in the first biome, a few steps from the entry.
  const first = world.zones[0];
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
 * Loot for the optional dead-end branches.
 *
 * These zones are off the critical path, so nothing may *require* what they
 * hold — the run has to stay winnable for a player who never walks in. They
 * take a spare item from a role pool: a bonus, not a key.
 */
function placeBranchRewards(
  world: World,
  rng: Rng,
  claim: (zoneId: string, t: Tile) => void,
  isFree: (zoneId: string, t: Tile) => boolean,
  grant: (zoneId: string, itemId: string) => void,
  usedItems: Set<string>,
): void {
  for (const zone of world.zones) {
    if (!zone.optional) continue;
    const zoneRng = rng.fork(`branch:${zone.id}`);
    const pool = [...ITEM_ROLES.offering, ...ITEM_ROLES.trigger].filter((id) => !usedItems.has(id));
    const itemId = pool.length ? zoneRng.pick(pool) : zoneRng.pick(ITEM_ROLES.offering);
    usedItems.add(itemId);

    const spots = pickLootSpots(zone, zoneRng, 3, zone.entry);
    const tile = spots.find((t) => isFree(zone.id, t)) ?? zone.exit;
    claim(zone.id, tile);
    world.pickups.push({
      uid: `pickup-branch-${zone.id}`,
      itemId,
      zoneId: zone.id,
      tile,
      taken: false,
      forMechanism: null,
    });
    grant(zone.id, itemId);
  }
}

/**
 * Choose the blocking tile for every passage of a zone at once.
 *
 * Each one must be a genuine chokepoint for its own passage: walling it has to
 * cut that portal off from the entry, or the player simply walks around the
 * gate. With two passages there is a second, sharper constraint — gate A must
 * not stand between the entry and portal B. If it did, B could only be reached
 * by opening A first, and the two routes would stop being alternatives and
 * become a forced order.
 *
 * Both are checked against the *portals*, not against the other gate tiles: it
 * is reaching the other passage that must stay free, and where its own gate
 * ends up is decided here too.
 */
function placeBlockingTiles(zone: Zone, portals: Tile[], probe: true): Tile[] | null;
function placeBlockingTiles(zone: Zone, portals: Tile[]): Tile[];
function placeBlockingTiles(zone: Zone, portals: Tile[], probe = false): Tile[] | null {
  const same = (a: Tile, b: Tile) => a.x === b.x && a.y === b.y;

  /** Every tile that could carry the gate for `portal`, best (nearest it) first. */
  const candidatesFor = (portal: Tile): Tile[] => {
    const path = findPath(zone.maze, zone.entry, portal) ?? [portal];
    const out: Tile[] = [];
    for (let k = path.length - 1; k > 0; k--) {
      const t = path[k];
      if (same(t, zone.entry)) continue;
      if (isCutVertex(zone, t, portal)) out.push(t);
    }
    return out;
  };

  const options = portals.map(candidatesFor);

  // Assign gates by backtracking over those candidate lists. A zone with two
  // passages has two interacting constraints — a gate must cut its own portal
  // off, and must leave every other portal and gate reachable on its own — and
  // picking greedily can paint the second passage into a corner where its only
  // remaining choice locks the first one away. That is not a rare corner: a
  // portal carved close to the entry has almost no tile in front of it.
  const chosen: Tile[] = [];
  const fits = (t: Tile, i: number): boolean => {
    // One tile cannot carry two gates, nor sit on another passage's portal.
    if (chosen.some((c) => same(c, t))) return false;
    if (portals.some((o, k) => k !== i && same(o, t))) return false;
    // Blocking here must leave every other portal reachable...
    if (portals.some((o, k) => k !== i && !reachableWithout(zone, o, t))) return false;
    // ...and must neither seal off, nor be sealed off by, a gate already placed.
    if (chosen.some((c) => !reachableWithout(zone, c, t))) return false;
    if (chosen.some((c) => !reachableWithout(zone, t, c))) return false;
    return true;
  };

  const solve = (i: number): boolean => {
    if (i === portals.length) return true;
    for (const t of options[i]) {
      if (!fits(t, i)) continue;
      chosen.push(t);
      if (solve(i + 1)) return true;
      chosen.pop();
    }
    return false;
  };

  if (solve(0)) return chosen;
  // `probe` callers are asking whether the zone's topology admits a valid set
  // at all, so they can open one up; see ensureIndependentApproaches.
  if (probe) return null;

  // No assignment satisfies every constraint. Fall back to the portals
  // themselves: each is trivially a chokepoint for its own passage. Reached
  // only for a single-gate zone whose maze left no cut vertex, since a
  // branching one has had a passage opened for it by then.
  return portals.map((p) => ({ ...p }));
}

/** Does blocking `tile` disconnect `portal` from the zone entry? */
function isCutVertex(zone: Zone, tile: Tile, portal: Tile): boolean {
  const { w, grid } = zone.maze;
  const idx = tile.y * w + tile.x;
  if (grid[idx] !== CELL.FLOOR) return false;

  const probe = Uint8Array.from(grid);
  probe[idx] = CELL.WALL;
  const dist = bfsDistances({ ...zone.maze, grid: probe }, zone.entry);
  return dist[portal.y * w + portal.x] < 0;
}

/** Is `target` still reachable from the entry when `blocked` is walled off? */
function reachableWithout(zone: Zone, target: Tile, blocked: Tile): boolean {
  const { w, grid } = zone.maze;
  const probe = Uint8Array.from(grid);
  probe[blocked.y * w + blocked.x] = CELL.WALL;
  const dist = bfsDistances({ ...zone.maze, grid: probe }, zone.entry);
  return dist[target.y * w + target.x] >= 0;
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

/**
 * Tiles reachable from the entry without crossing ANY of the zone's gates.
 *
 * With one gate per passage, loot placed merely "before its own gate" could
 * still sit behind a sibling gate — reachable only by opening the other route
 * first, which is exactly the forced order the branching is meant to avoid.
 * So the whole gate set is walled off at once.
 */
function tilesBeforeGates(zone: Zone, gates: Tile[]): Tile[] {
  const { w, grid } = zone.maze;
  const probe = Uint8Array.from(grid);
  for (const g of gates) probe[g.y * w + g.x] = CELL.WALL;
  const dist = bfsDistances({ ...zone.maze, grid: probe }, zone.entry);
  const open = zone.tiles.filter((t) => dist[t.y * w + t.x] >= 0);
  // A gate hung right next to the entry can leave almost nothing in front of
  // it; fall back to the whole zone rather than returning an empty pool.
  return open.length ? open : zone.tiles;
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
/** How a signpost names a direction. Cardinal, never a biome name. */
const SIDE_LABEL: Record<Side, string> = {
  north: 'au nord',
  east: 'à l\'est',
  south: 'au sud',
  west: 'à l\'ouest',
};

function placeSignposts(world: World, root: Rng, taken: Set<string>): void {
  const rng = root.fork('signposts');

  for (const zone of world.zones) {
    const lines: string[] = [];
    if (zone.style.blurb) lines.push(zone.style.blurb);

    // The entry sign announces the shape of the choice, not the destinations:
    // naming what lies down a passage would spoil the biome behind it.
    if (zone.gates.length === 0) {
      lines.push(
        zone.optional
          ? 'Cette voie ne mène nulle part — mais on n\'y vient pas pour rien.'
          : 'La sortie finale est ici.',
      );
    } else if (zone.gates.length === 1) {
      lines.push(`Un seul passage, ${SIDE_LABEL[zone.gates[0].side]}.`);
    } else {
      const sides = zone.gates.map((g) => SIDE_LABEL[g.side]).join(' et ');
      lines.push(`Deux chemins d\'ici : ${sides}. À vous de choisir.`);
    }

    for (const gate of zone.gates) {
      const mech = world.mechanisms.find((m) => m.uid === gate.mechanismUid);
      if (mech) lines.push(`${cap(SIDE_LABEL[gate.side])} : ${mechanismHint(mech)}`);
    }

    const loot = [...new Set(world.grantedByZone.get(zone.id) ?? [])];
    if (loot.length) {
      lines.push(`On trouve ici : ${loot.map((id) => ITEMS[id]?.name ?? id).join(', ')}.`);
    }

    world.signposts.push({
      uid: `sign-${zone.id}-entry`,
      zoneId: zone.id,
      tile: neighbourOf(zone, zone.entry, rng, taken),
      title: 'Panneau',
      lines,
    });

    // One sign per blocked passage, at the gate itself.
    for (const gate of zone.gates) {
      const mech = world.mechanisms.find((m) => m.uid === gate.mechanismUid);
      if (!mech) continue;
      world.signposts.push({
        uid: `sign-${mech.uid}`,
        zoneId: zone.id,
        tile: neighbourOf(zone, mech.target.tile, rng, taken),
        title: 'Passage bloqué',
        lines: [mechanismHint(mech)],
        mechanismUid: mech.uid,
      });
    }
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
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
  // Numbered west to east, then north to south inside a rank: the label has to
  // match the order the player meets them, and with two zones per rank X alone
  // no longer gives a total order.
  const ordered = [...world.zones].sort(
    (a, b) => a.originX - b.originX || a.originZ - b.originZ,
  );
  ordered.forEach((zone, i) => {
    world.teleporters.push({
      uid: `tp-${zone.id}`,
      zoneId: zone.id,
      tile: neighbourOf(zone, zone.entry, rng, taken),
      label: `Secteur ${i + 1}`,
      discovered: false,
    });
  });
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
/**
 * Which zone contains a world position (for ambience switching).
 *
 * Zones are laid out in 2D, so an X-only test is not enough: two zones of the
 * same rank share a column and only differ on Z. A position inside a gutter
 * belongs to the nearest zone, which is what keeps the mood from flickering
 * while the player crosses between two biomes.
 */
export function zoneAt(world: World, worldX: number, worldZ: number): Zone {
  const x = worldX / TILE; // back into zone-grid units
  const z = worldZ / TILE;

  let best = world.zones[0];
  let bestD = Infinity;
  for (const zone of world.zones) {
    const inX = x >= zone.originX && x < zone.originX + zone.w;
    const inZ = z >= zone.originZ && z < zone.originZ + zone.h;
    if (inX && inZ) return zone;

    // Distance to the zone's box, so a gutter tile resolves to the zone it is
    // closest to rather than to whichever comes first in the list.
    const dx = Math.max(zone.originX - x, 0, x - (zone.originX + zone.w));
    const dz = Math.max(zone.originZ - z, 0, z - (zone.originZ + zone.h));
    const d = dx * dx + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = zone;
    }
  }
  return best;
}
