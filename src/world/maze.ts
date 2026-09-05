/**
 * Grid maze generation.
 *
 * A maze of `cols` x `rows` cells is expanded into a voxel grid of
 * (cols*2+1) x (rows*2+1): odd coordinates are cells, even ones are walls.
 *
 * Randomized Kruskal over the cell edges: edges are shuffled and each one is
 * carved when it joins two different components. Unlike a recursive
 * backtracker — which grows one long snake and yields few, very deep dead ends
 * — Kruskal grows many small clumps that merge, so corridors stay short and
 * the maze is dense in T- and 4-way junctions with lots of shallow dead ends.
 * That is the texture we want: constant choices, quick failures.
 */

import type { Rng } from '../core/rng.js';
import type { Maze, Tile } from '../core/types.js';

const DIRS = [
  { dx: 0, dy: -1 },
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
] as const;

export const CELL = { WALL: 0, FLOOR: 1 } as const;

export interface MazeOptions {
  /** Fraction of dead ends reopened into loops (0 = perfect maze). */
  braid?: number;
  /**
   * Fraction of the *remaining* walls between already-connected cells that are
   * knocked out, on top of the spanning tree. This is what turns corridors into
   * crossroads: 0 is a perfect maze, ~0.15 gives a junction-heavy weave.
   * Kept modest on purpose — every extra loop removes chokepoints, and
   * `placeBlockingTile()` needs a cut vertex on the entry->exit path to hang a
   * gate on.
   */
  loop?: number;
}

/** Union-find over cells, path-halving + union by size. */
class DisjointSet {
  private readonly parent: Int32Array;
  private readonly size: Uint32Array;

  constructor(n: number) {
    this.parent = new Int32Array(n);
    this.size = new Uint32Array(n).fill(1);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }

  find(a: number): number {
    let x = a;
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }

  /** Joins a and b; false when they were already connected. */
  union(a: number, b: number): boolean {
    let ra = this.find(a);
    let rb = this.find(b);
    if (ra === rb) return false;
    if (this.size[ra] < this.size[rb]) [ra, rb] = [rb, ra];
    this.parent[rb] = ra;
    this.size[ra] += this.size[rb];
    return true;
  }
}

export function generateMaze(rng: Rng, cols: number, rows: number, opts: MazeOptions = {}): Maze {
  const braid = opts.braid ?? 0.08;
  const loop = opts.loop ?? 0.15;
  const w = cols * 2 + 1;
  const h = rows * 2 + 1;
  const grid = new Uint8Array(w * h); // all walls
  const at = (x: number, y: number) => y * w + x;

  // Every cell is floor from the start; Kruskal only decides which walls fall.
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) grid[at(cx * 2 + 1, cy * 2 + 1)] = CELL.FLOOR;
  }

  // Candidate edges: east and south neighbours of each cell, so each interior
  // wall is listed exactly once.
  const edges: { a: number; b: number; wx: number; wy: number }[] = [];
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const a = cy * cols + cx;
      if (cx + 1 < cols) {
        edges.push({ a, b: a + 1, wx: cx * 2 + 2, wy: cy * 2 + 1 });
      }
      if (cy + 1 < rows) {
        edges.push({ a, b: a + cols, wx: cx * 2 + 1, wy: cy * 2 + 2 });
      }
    }
  }

  const order = rng.shuffle(edges);
  const set = new DisjointSet(cols * rows);
  const spare: typeof edges = [];

  for (const e of order) {
    if (set.union(e.a, e.b)) grid[at(e.wx, e.wy)] = CELL.FLOOR;
    else spare.push(e);
  }

  // Extra openings between already-connected cells: these are the crossroads.
  if (loop > 0) {
    for (const e of rng.sample(spare, Math.floor(spare.length * loop))) {
      grid[at(e.wx, e.wy)] = CELL.FLOOR;
    }
  }

  // Braiding: reopen a few dead ends into loops so backtracking is less
  // punishing. Kept low — dead ends are wanted here, and `loop` above already
  // provides the shortcuts that braiding used to be responsible for.
  if (braid > 0) {
    const deadEnds = findDeadEnds(grid, w, h);
    const toBraid = rng.sample(deadEnds, Math.floor(deadEnds.length * braid));
    for (const { x, y } of toBraid) {
      const walls = DIRS.map((d) => ({ x: x + d.dx, y: y + d.dy })).filter(
        (p) => p.x > 0 && p.y > 0 && p.x < w - 1 && p.y < h - 1 && grid[at(p.x, p.y)] === CELL.WALL,
      );
      if (walls.length) {
        const pick = rng.pick(walls);
        grid[at(pick.x, pick.y)] = CELL.FLOOR;
      }
    }
  }

  return { w, h, grid, cols, rows };
}

/** Cells with exactly one walkable neighbour. */
export function findDeadEnds(grid: Uint8Array, w: number, h: number): Tile[] {
  const out: Tile[] = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (grid[y * w + x] !== CELL.FLOOR) continue;
      let n = 0;
      for (const d of DIRS) if (grid[(y + d.dy) * w + (x + d.dx)] === CELL.FLOOR) n++;
      if (n === 1) out.push({ x, y });
    }
  }
  return out;
}

/** BFS distances from `src` over walkable tiles. -1 = unreachable. */
export function bfsDistances(maze: Maze, src: Tile): Int32Array {
  const { w, h, grid } = maze;
  const dist = new Int32Array(w * h).fill(-1);
  const q: number[] = [src.y * w + src.x];
  dist[src.y * w + src.x] = 0;
  let head = 0;
  while (head < q.length) {
    const idx = q[head++];
    const x = idx % w;
    const y = (idx / w) | 0;
    const d = dist[idx];
    for (const dir of DIRS) {
      const nx = x + dir.dx;
      const ny = y + dir.dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (grid[ni] !== CELL.FLOOR || dist[ni] !== -1) continue;
      dist[ni] = d + 1;
      q.push(ni);
    }
  }
  return dist;
}

/** Shortest path src -> dst as an array of tiles, or null. */
export function findPath(maze: Maze, src: Tile, dst: Tile): Tile[] | null {
  const { w, grid } = maze;
  const dist = bfsDistances(maze, src);
  if (dist[dst.y * w + dst.x] < 0) return null;

  const path: Tile[] = [{ x: dst.x, y: dst.y }];
  let cur: Tile = { x: dst.x, y: dst.y };
  while (!(cur.x === src.x && cur.y === src.y)) {
    const d = dist[cur.y * w + cur.x];
    for (const dir of DIRS) {
      const nx = cur.x + dir.dx;
      const ny = cur.y + dir.dy;
      const ni = ny * w + nx;
      if (grid[ni] === CELL.FLOOR && dist[ni] === d - 1) {
        cur = { x: nx, y: ny };
        path.push(cur);
        break;
      }
    }
  }
  return path.reverse();
}

/** All walkable tiles, in stable scan order. */
export function walkableTiles(maze: Maze): Tile[] {
  const { w, h, grid } = maze;
  const out: Tile[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (grid[y * w + x] === CELL.FLOOR) out.push({ x, y });
    }
  }
  return out;
}
