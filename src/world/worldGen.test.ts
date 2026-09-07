/**
 * Generation invariants. Run with `npm test`.
 *
 * These guard the properties that are expensive to notice by playing:
 *  - the world is one connected walkable space
 *  - every gate is a real chokepoint (progression cannot be skipped)
 *  - the biome graph branches, and every branch is walkable
 *  - an optional dead-end branch is never needed to finish
 *  - every run is completable without getting locked away from your own items
 *  - the same seed rebuilds the same world
 */

import { Inventory } from '../core/inventory.js';
import type { Mechanism, SizeKey, World, WorldMutator } from '../core/types.js';
import { CELL, bfsDistances } from './maze.js';
import { MECHANISM_IDS, tryUnlock } from './unlockMechanisms.js';
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

    // Any route into the final zone finishes the run: the player opens the gate
    // on the branch they took, not all of them (mirrors Game.checkFinish).
    const finalMechs = world.mechanisms.filter((m) => m.isFinal);
    const wayIn = !finalMechs.length || finalMechs.some((m) => m.unlocked);
    if (seen.has(exitKey(world)) && wayIn) {
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

    // 2. every passage out of a zone is reachable from that zone's entry
    for (const z of world.zones) {
      const d = bfsDistances(z.maze, z.entry);
      for (const g of z.gates) {
        check(
          `${label} ${z.id} gate to ${g.toZoneId} reachable`,
          d[g.tile.y * z.maze.w + g.tile.x] >= 0,
        );
      }
      if (!z.gates.length) {
        check(`${label} ${z.id} exit reachable`, d[z.exit.y * z.maze.w + z.exit.x] >= 0);
      }
    }

    // 3. every gate is a genuine chokepoint for its own passage: walling it
    //    must cut that passage off, so the route it guards cannot be walked
    //    around — including through the zone's *other* passage.
    for (const m of world.mechanisms) {
      const z = world.zones.find((zz) => zz.id === m.zoneId)!;
      const gate = z.gates.find((g) => g.mechanismUid === m.uid)!;
      const probe = Uint8Array.from(z.maze.grid);
      probe[m.target.tile.y * z.maze.w + m.target.tile.x] = CELL.WALL;
      const d = bfsDistances({ ...z.maze, grid: probe }, z.entry);
      check(
        `${label} ${m.uid} is a chokepoint`,
        d[gate.tile.y * z.maze.w + gate.tile.x] < 0,
        m.type,
      );
    }

    // 3b. the routes are independent: opening one passage must never be a
    //     prerequisite for reaching another, or the branching collapses back
    //     into a forced order.
    for (const z of world.zones) {
      if (z.gates.length < 2) continue;
      for (const a of z.gates) {
        const ma = world.mechanisms.find((m) => m.uid === a.mechanismUid);
        if (!ma) continue;
        const probe = Uint8Array.from(z.maze.grid);
        probe[ma.target.tile.y * z.maze.w + ma.target.tile.x] = CELL.WALL;
        const d = bfsDistances({ ...z.maze, grid: probe }, z.entry);
        for (const b of z.gates) {
          if (b === a) continue;
          const mb = world.mechanisms.find((m) => m.uid === b.mechanismUid);
          if (!mb) continue;
          check(
            `${label} ${z.id} gate ${mb.uid} reachable without opening ${ma.uid}`,
            d[mb.target.tile.y * z.maze.w + mb.target.tile.x] >= 0,
          );
        }
      }
    }

    // 3c. geometry and grid agree: a link tile that falls inside a zone must be
    //     floor in that zone's maze too. When it is not, the renderer lays a
    //     corridor over tiles the maze calls wall and the gutter reads as a
    //     trench cut across the biome — invisible to every other check here,
    //     since the world stays perfectly walkable.
    for (const owner of world.zones) {
      for (const l of owner.links) {
        for (const z of world.zones) {
          if (l.x < z.originX || l.x >= z.originX + z.w) continue;
          if (l.z < z.originZ || l.z >= z.originZ + z.h) continue;
          const lx = l.x - z.originX;
          const lz = l.z - z.originZ;
          check(
            `${label} link (${l.x},${l.z}) is floor in ${z.id}`,
            z.maze.grid[lz * z.maze.w + lx] === CELL.FLOOR,
          );
        }
      }
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

    // 6. an optional dead-end branch is a bonus, never a requirement: the run
    //    must still be winnable for a player who never walks into one.
    const skipped = generateWorld({ seed, size });
    for (const p of skipped.pickups) {
      const z = skipped.zones.find((zz) => zz.id === p.zoneId)!;
      if (z.optional) p.taken = true; // pretend it was never collected
    }
    const simSkip = simulate(skipped);
    check(`${label} completable ignoring optional branches`, simSkip.won, simSkip.stuck.join(' | '));

    // 7. every zone is entered by a carved passage, and the graph is acyclic
    //    (a back edge would let the player walk around a gate).
    for (const z of world.zones) {
      for (const g of z.gates) {
        const dest = world.zones.find((zz) => zz.id === g.toZoneId)!;
        check(`${label} ${z.id} -> ${g.toZoneId} goes forward`, dest.rank > z.rank);
      }
    }
  }
}

// 8. the graph actually branches: at medium and large at least one zone must
//    offer a real choice of route, or the world is still a chain.
for (const size of ['medium', 'large'] as SizeKey[]) {
  const branching = SEEDS.filter((seed) =>
    generateWorld({ seed, size }).zones.some((z) => z.gates.length > 1),
  );
  check(
    `${size}: some seeds branch`,
    branching.length > 0,
    `${branching.length}/${SEEDS.length} seeds have a zone with 2+ exits`,
  );
}

// 9. the dev gallery's test bench (`config.forceMechanism`, F4) must produce a
//    world that is actually playable for every mechanism in the catalogue —
//    otherwise the bench shows a puzzle that cannot be solved, which is worse
//    than no bench at all. Two zones is the generator's floor, and the harshest
//    case: `cross_biome_tool` has almost no earlier zone to plant its tool in.
for (const id of MECHANISM_IDS) {
  for (const seed of ['bench-a', 'bench-b', 'bench-c']) {
    const label = `bench ${id}/${seed}`;
    const world = generateWorld({ seed, size: 'small', biomeCount: 2, forceMechanism: id });

    // The point of the bench: the mechanism asked for is the one on screen.
    // `cross_biome_tool` is the exception the generator documents — it declines
    // when no dominator can hold its tool, and falls back to `key_door`.
    const types = new Set(world.mechanisms.map((m) => m.type));
    check(
      `${label} shows the forced mechanism`,
      types.has(id) || (id === 'cross_biome_tool' && types.has('key_door')),
      `got ${[...types].join(', ')}`,
    );

    check(`${label} completable`, simulate(world).won);
  }
}

// 10. determinism
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
console.log(
  `✓ all invariants hold (${SIZES.length * SEEDS.length} worlds + ${MECHANISM_IDS.length * 3} bench worlds)`,
);
