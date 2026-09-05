/**
 * Generation invariants. Run with `npm test`.
 *
 * These guard the properties that are expensive to notice by playing:
 *  - the world is one connected walkable space
 *  - every gate is a real chokepoint (progression cannot be skipped)
 *  - every run is completable without getting locked away from your own items
 *  - the same seed rebuilds the same world
 */

import { Inventory } from '../core/inventory.js';
import type { Mechanism, SizeKey, World, WorldMutator } from '../core/types.js';
import { CELL, bfsDistances } from './maze.js';
import { tryUnlock } from './unlockMechanisms.js';
import { generateWorld } from './worldGen.js';

const SIZES: SizeKey[] = ['small', 'medium', 'large'];
const SEEDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** World-space walkable set. */
function openTiles(world: World): Set<string> {
  const open = new Set<string>();
  for (const z of world.zones) {
    for (const t of z.tiles) open.add(`${z.originX + t.x},${z.originZ + t.y}`);
    for (const l of z.links) open.add(`${l.x},${l.z}`);
  }
  return open;
}

function gateKey(world: World, m: Mechanism): string {
  const z = world.zones.find((zz) => zz.id === m.zoneId)!;
  return `${z.originX + m.target.tile.x},${z.originZ + m.target.tile.y}`;
}

function flood(open: Set<string>, start: string, blocked = new Set<string>()): Set<string> {
  const seen = new Set([start]);
  const q = [start];
  while (q.length) {
    const [x, y] = q.shift()!.split(',').map(Number);
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const k = `${x + dx},${y + dy}`;
      if (open.has(k) && !blocked.has(k) && !seen.has(k)) {
        seen.add(k);
        q.push(k);
      }
    }
  }
  return seen;
}

function startKey(world: World): string {
  const z = world.zones.find((zz) => zz.id === world.startZoneId)!;
  return `${z.originX + world.start.x},${z.originZ + world.start.y}`;
}

function exitKey(world: World): string {
  const z = world.zones.find((zz) => zz.id === world.exit.zoneId)!;
  return `${z.originX + world.exit.tile.x},${z.originZ + world.exit.tile.y}`;
}

/** Play the run automatically: collect what is reachable, open what we can. */
function simulate(world: World): { won: boolean; stuck: string[] } {
  const inv = new Inventory();
  const mut: WorldMutator = { clearBlocking: () => {}, buildBridge: () => {} };
  const open = openTiles(world);
  const start = startKey(world);

  for (let step = 0; step < 60; step++) {
    const blocked = new Set(
      world.mechanisms.filter((m) => !m.unlocked).map((m) => gateKey(world, m)),
    );
    const seen = flood(open, start, blocked);
    let progressed = false;

    for (const p of world.pickups) {
      if (p.taken) continue;
      const z = world.zones.find((zz) => zz.id === p.zoneId)!;
      if (!seen.has(`${z.originX + p.tile.x},${z.originZ + p.tile.y}`)) continue;
      p.taken = true;
      inv.add(p.itemId);
      progressed = true;
    }

    for (const m of world.mechanisms) {
      if (m.unlocked) continue;
      const [gx, gy] = gateKey(world, m).split(',').map(Number);
      const adjacent = [[0, 1], [0, -1], [1, 0], [-1, 0]].some(([dx, dy]) =>
        seen.has(`${gx + dx},${gy + dy}`),
      );
      if (adjacent && tryUnlock(m, inv, mut)) progressed = true;
    }

    const finalMech = world.mechanisms.find((m) => m.isFinal);
    if (seen.has(exitKey(world)) && (!finalMech || finalMech.unlocked)) {
      return { won: true, stuck: [] };
    }
    if (!progressed) break;
  }

  return {
    won: false,
    stuck: world.mechanisms
      .filter((m) => !m.unlocked)
      .map((m) => `${m.type} needs ${m.requires.join('+')}`),
  };
}

console.log('worldGen invariants');

for (const size of SIZES) {
  for (const seed of SEEDS) {
    const label = `${size}/${seed}`;
    const world = generateWorld({ seed, size });

    // 1. one connected space
    const open = openTiles(world);
    const reachable = flood(open, startKey(world));
    check(`${label} connected`, reachable.size === open.size, `${reachable.size}/${open.size}`);

    // 2. each zone's own exit is reachable from its entry
    for (const z of world.zones) {
      const d = bfsDistances(z.maze, z.entry);
      check(`${label} ${z.id} exit reachable`, d[z.exit.y * z.maze.w + z.exit.x] >= 0);
    }

    // 3. every gate is a genuine chokepoint
    for (const m of world.mechanisms) {
      const z = world.zones.find((zz) => zz.id === m.zoneId)!;
      const probe = Uint8Array.from(z.maze.grid);
      probe[m.target.tile.y * z.maze.w + m.target.tile.x] = CELL.WALL;
      const d = bfsDistances({ ...z.maze, grid: probe }, z.entry);
      check(
        `${label} ${m.uid} is a chokepoint`,
        d[z.exit.y * z.maze.w + z.exit.x] < 0,
        m.type,
      );
    }

    // 4. gates actually gate the ending
    const allBlocked = new Set(world.mechanisms.map((m) => gateKey(world, m)));
    check(
      `${label} exit is gated`,
      !flood(open, startKey(world), allBlocked).has(exitKey(world)),
    );

    // 5. the run is winnable
    const sim = simulate(generateWorld({ seed, size }));
    check(`${label} completable`, sim.won, sim.stuck.join(' | '));
  }
}

// 6. determinism
const stable = (w: World) =>
  JSON.stringify(w, (_k, v) =>
    v instanceof Map ? [...v] : v instanceof Uint8Array ? Array.from(v) : v,
  );
check(
  'same seed rebuilds the same world',
  stable(generateWorld({ seed: 'repro', size: 'medium' })) ===
    stable(generateWorld({ seed: 'repro', size: 'medium' })),
);
check(
  'different seeds differ',
  stable(generateWorld({ seed: 'a', size: 'medium' })) !==
    stable(generateWorld({ seed: 'b', size: 'medium' })),
);

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log(`✓ all invariants hold (${SIZES.length * SEEDS.length} worlds)`);
