# Unlock mechanisms

Detail behind the "Adding an unlock mechanism" section in CLAUDE.md. The
registry is `src/world/unlockMechanisms.ts`; the ids live in `MechanismTypeId`
(`core/types.ts`).

## The interface

Everything else in the codebase talks to a mechanism through `MechanismType`,
so a new entry needs no change to maze generation, the renderer, the HUD, the
compass, the signposts or the dev gallery.

**Generation time**

- `plan(ctx)` reserves items via `ctx.pickItem(role)` /
  `ctx.pickCrossBiomeItem()` and declares a `target.type`
  (`door | pedestal | rubble | gap | gate`). Returning `null` **declines** —
  the generator falls back to `key_door`. `cross_biome_tool` is the live
  example: it declines when no dominator zone can hold its tool.
- Items listed in the returned plan are scattered by the generator inside the
  zone, always in `tilesBeforeGates()` — clear of *every* gate of that zone.

**Play time**

- `onCheck(inv, inst)` decides whether the requirements are met.
- `onUnlock(world, inst)` may only call `WorldMutator.clearBlocking()` or
  `buildBridge()`. Anything else would let a mechanism reach past the small
  surface the game layer deliberately exposes.
- `consumeCount(inst)` says how many units to eat when `consumesItem`.

**Display** — four fields the dev gallery reads: `category`, `summary`,
`consumes`, `targetKind`. They are *stated* rather than derived from `plan()`,
which needs a `PlanContext` the gallery has no business fabricating. Keep them
in step with what `plan()` actually returns; nothing enforces it.

## Two axes, deliberately different

`MechanismCategory` groups by **what the mechanism asks of the player**:

| category    | what it asks                                            |
| ----------- | ------------------------------------------------------- |
| `fetch`     | find one hidden item                                    |
| `sacrifice` | find one item, which is consumed                        |
| `collect`   | gather several scattered copies                         |
| `traversal` | the terrain blocks; unlocking changes the geometry      |
| `backtrack` | the item is in an earlier biome — take a teleporter     |

The pools in `planProgression()` sort by a **passage's role in the run**:
ordinary passages, 1–2 "deep exploration" ones, one late transition. A category
can appear in several pools, and a pool can hold several categories — they
answer different questions and should not be collapsed into one list.

Adding a family is one entry in `MECHANISM_CATEGORIES`; the gallery groups by
it with no further wiring.

## The dev bench (F4)

`GameConfig.forceMechanism` pins one mechanism to every passage. It is read at
exactly one point — the pool choice in `planProgression()` — and only when set,
so a normal run draws precisely what it always drew and **no existing seed
shifts**. That is the whole reason it is a config field rather than a change to
the pools.

The gallery's "Tester" button builds `{ size: 'small', biomeCount: 2 }`, the
generator's floor: one starting zone, one final zone, a single passage between
them plus the dead-end branch the graph always adds. The gate sits 16–18 tiles
from the spawn, and the compass points at it.

Bench runs are throwaway: `playingState` skips the save restore and
`Game.persist()` returns early, so opening the bench never overwrites a real
run's progress.

`npm test` covers every mechanism forced onto that world — completable, and
actually showing the mechanism asked for. The one documented exception is
`cross_biome_tool` on the start zone's gate: there is no earlier biome to plant
its tool in, so it declines and falls back to `key_door`, exactly as it would
in a real world.
