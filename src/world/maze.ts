/**
 * Grid maze generation.
 *
 * A maze of `cols` x `rows` cells is expanded into a voxel grid of
 * (cols*2+1) x (rows*2+1): odd coordinates are cells, even ones are walls.
 * Recursive backtracker (depth-first) gives long winding corridors and plenty
 * of dead ends — good for 20-30 min of exploration.
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
}

export function generateMaze(rng: Rng, cols: number, rows: number, opts: MazeOptions = {}): Maze {
  const braid = opts.braid ?? 0.12;
  const w = cols * 2 + 1;
  const h = rows * 2 + 1;
  const grid = new Uint8Array(w * h); // all walls

  const visited = new Uint8Array(cols * rows);
  const at = (x: number, y: number) => y * w + x;

  const start: Tile = { x: rng.int(0, cols - 1), y: rng.int(0, rows - 1) };
  const stack: Tile[] = [start];
  visited[start.y * cols + start.x] = 1;
  grid[at(start.x * 2 + 1, start.y * 2 + 1)] = CELL.FLOOR;

  while (stack.length) {
    const cur = stack[stack.length - 1];
    const options: { nx: number; ny: number; d: (typeof DIRS)[number] }[] = [];
    for (const d of DIRS) {
      const nx = cur.x + d.dx;
      const ny = cur.y + d.dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      if (visited[ny * cols + nx]) continue;
      options.push({ nx, ny, d });
    }
    if (!options.length) {
      stack.pop();
      continue;
    }
    const { nx, ny, d } = rng.pick(options);
    visited[ny * cols + nx] = 1;
    grid[at(nx * 2 + 1, ny * 2 + 1)] = CELL.FLOOR;
    grid[at(cur.x * 2 + 1 + d.dx, cur.y * 2 + 1 + d.dy)] = CELL.FLOOR;
    stack.push({ x: nx, y: ny });
  }

  // Braiding: reopen a few dead ends into loops so backtracking is less punishing.
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
