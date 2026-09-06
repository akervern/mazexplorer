# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Vite dev server, http://localhost:5173
npm run dev:debug  # same, plus the dev tools (full map, noclip, overlay)
npm test           # generation invariants (tsx src/world/worldGen.test.ts)
npm run typecheck  # tsc --noEmit
npm run build      # typecheck + vite build
```

`npm test` is a plain tsx script, not a test runner — there is no per-test filter.
To narrow it, edit the `SIZES` / `SEEDS` arrays at the top of
`src/world/worldGen.test.ts` (18 worlds = 3 sizes × 6 seeds by default).

Product text (signposts, HUD, menus, item names, mechanism hints) is in French.
Code, comments and identifiers are in English.

**Biome names are never shown to the player.** `ZoneStyle.name` is a debug/dev
label; the mood on screen is the reveal. The HUD, signposts and teleporters all
use the positional label instead (`Secteur N`, numbered west to east, from
`Game.zoneLabel()` and the teleporter's own `label`). Signpost blurbs describe
a place without naming it, and never name the *next* zone.

## Determinism is the core invariant

Seed + config ⇒ byte-identical world. `Math.random()` must never appear in
anything under `src/world/` or `src/core/` (`randomSeedString()` in
`core/rng.ts` is the one deliberate exception — it only picks a seed for the
menu, it never generates).

Every generation step draws from `rng.fork('tag')`, an independent stream
derived from seed + tag. **Consequence: adding a generation step must use a new
`fork()`, never an extra draw on an existing stream** — reusing a stream shifts
every later draw and changes unrelated parts of the world for all existing
seeds. Registry iteration order is likewise seed-relevant (`MECHANISM_IDS`).

## World model and coordinate spaces

Three spaces, converted only through `worldGen.ts` helpers:

1. **Maze cell** — `cols × rows` logical cells (`maze.ts`).
2. **Zone grid tile** — cells expanded to `(cols*2+1) × (rows*2+1)`; odd indices
   are cells, even ones walls. `Tile {x, y}` is always this space. Zones carry
   `originX`/`originZ` so all zone tiles share one global grid.
3. **World / voxel units** — grid × `TILE`.

`TILE` (`core/types.ts`, currently 3) is the single knob for corridor width.
Everything derived from it — interaction ranges, fog, camera planes, shadow
frustum, minimap span — scales off it, so never hardcode a distance in world
units; write it as a multiple of `TILE`. Convert with `tileToWorld()` (tile
centre), `tileOrigin()` (low corner) and `linkToWorld()`; never multiply by
`TILE` by hand at a call site.

A voxel at index `i` spans `[i, i+1)`. Rendering compensates by placing box
instances at `+0.5` (`voxelWorld.ts`), and collision computes its high bound as
`ceil(c+R)-1`, not `floor(c+R)` — using floor widens the AABB by a voxel on one
side and makes walls asymmetrically solid. Player movement is integrated per
axis in sub-steps smaller than the player radius; a single long step tunnels
through walls on a slow frame.

Changing `TILE` invalidates saved positions (stored in world units). `save.ts`
bakes `TILE` into the storage key (`mazexplorer:save:v2:t${TILE}`) so old saves
are dropped rather than spawning the camera inside a wall.

## Generation pipeline (`world/worldGen.ts`)

`generateWorld(config)`:
biome order (all of `BIOME_POOL` shuffled on the `biome-order` fork and cut to
`biomeCount` — **no biome is pinned to the front**, the starting one is drawn
from the seed like the rest) → zones (one maze per biome, laid side by side on X with a gutter;
there are no corridor zones — walking one was dead time) → `linkZones()` carves
each exit east, each next entry west, and fills the gutter as an **L** (a straight interpolation leaves diagonal,
non-walkable gaps) → `planProgression()` → signposts → teleporters.

Biome mazes come from **randomized Kruskal** (`maze.ts`), not a recursive
backtracker: Kruskal merges many small clumps, so corridors stay short and
junctions are frequent — a backtracker grows one long snake with few branch
points. Two knobs shape the texture, and they pull against each other:

- `loop` (0.15) knocks out extra walls between already-connected cells. This is
  what makes crossroads; it also destroys chokepoints.
- `braid` (0.08) reopens dead ends. Kept low **because dead ends are wanted** —
  `loop` already provides the shortcuts braiding used to be responsible for.

Raising `loop` much past ~0.2 risks leaving no cut vertex on an entry→exit path,
and `placeBlockingTile()` needs one to hang a gate on — `npm test` fails loudly
when that happens, so re-run it after touching either knob.

`planProgression()` assigns exactly one mechanism per biome zone, drawn from a
pool chosen by the zone's role:

- most zones: `key_door`, `pedestal_offering`, `break_obstacle`, `activate_bridge`
- 1–2 "deep exploration" zones: `fragment_set`, `light_threshold`
- one late transition (needs ≥ 4 biomes): `cross_biome_tool`, whose item is
  planted in an *earlier* biome — the intended backtrack via teleporter

Loot for a gate is placed only in `tilesBeforeGate()`. This is the subtle
constraint: without it a key can spawn behind its own door.

## Adding an unlock mechanism

One entry in `src/world/unlockMechanisms.ts` plus its id in `MechanismTypeId`
(`core/types.ts`). Nothing else changes — maze generation, renderer, HUD,
compass and signposts all go through the `MechanismType` interface, and
signposts read `requires` to write their own hint.

- `plan(ctx)` runs at generation: reserve items via `ctx.pickItem(role)` /
  `ctx.pickCrossBiomeItem()`, declare a `target.type` (`door | pedestal |
  rubble | gap | gate`). Return `null` to decline — the generator falls back to
  `key_door`.
- `onCheck(inv, inst)` / `onUnlock(world, inst)` run at play time. `onUnlock`
  may only call `WorldMutator.clearBlocking()` / `buildBridge()`.
- Then allow the id in the appropriate pool in `planProgression()`.

Then run `npm test` — the invariants below catch a mechanism that makes a world
unwinnable.

## What `npm test` guarantees

Per world: one connected walkable space; each zone's exit reachable from its
entry; **every gate is a true chokepoint** (walling it disconnects the exit, so
progression cannot be routed around); the exit is gated; and the run is
**completable** — a headless simulation collects reachable pickups and fires
reachable mechanisms until it wins. Plus determinism (same seed ⇒ identical
world, different seeds differ).

These checks are pure logic and prove nothing about what is on screen. See
Verification below.

## Dev mode (`npm run dev:debug`)

Three tools in `src/dev/`, on function keys so they cannot collide with a
movement key on either AZERTY or QWERTY:

- **F1** — full-world map: every zone at once, no fog of war, with gates,
  pickups, signposts, teleporters and entry/exit marked. **Click a tile to
  teleport there.** It is a flat 2D canvas drawn from `World` data, deliberately
  *not* the in-game minimap (that one is a 3D viewport pass whose whole point is
  the fog).
- **F2** — noclip: free flight, no gravity or collision. Forward follows camera
  pitch; Space/Ctrl are absolute up/down; Shift is fast. Leaving noclip runs the
  same nudge a teleport does, so exiting inside a wall cannot trap the camera.
- **F3** — debug overlay: fps, seed, real `ZoneStyle.name`, global and
  zone-local tile, world position, progression counts and draw calls.

Gating: `__DEV_TOOLS__`, a compile-time literal defined in `vite.config.ts` from
`VITE_DEV_TOOLS`. It must stay a literal, and the guard must sit **directly in
front of the `import()`** in `game.ts` — guarding only the calling method still
leaves a ~10 kB dev chunk in `dist/`. Verify with `ls dist/assets/` after a
plain `npm run build`: no `devTools-*.js` should appear. (The dev CSS does ship
in `style.css`; it is ~1 kB of unused rules, kept there so the panels inherit
the shared variables.)

`src/dev/` may read the world and the player, but nothing outside it may import
from it — `game.ts` holds only a `type` import plus the guarded dynamic one.

## Verification

`npm test` and `npm run typecheck` passing does **not** mean the change works:
they never render a frame. For anything touching rendering, collision, camera,
minimap or UI, run `npm run dev` and look at it before reporting done.

## Layer boundaries worth keeping

- `world/` and `core/` are DOM-free and Three.js-free — that is what lets the
  test suite run headless under tsx. Keep Three.js in `render/`, `player/`,
  `ui/` and `game.ts`.
- Input is abstracted behind `InputSource` (`player/input.ts`):
  `getMoveVector()` / `getLookDelta()` / `drainActions()`. Pointer Lock is one
  source, not a dependency — adding a touch joystick must not touch the
  controller or `game.ts`.
- Voxels render as one `InstancedMesh` per (texture, tint, variant, tint-step)
  key — never a mesh per block. Textures are generated on a 2D canvas; the
  project ships zero external assets.
- Visual variety lives in `render/decor.ts` (see Environment variety below).
- Saves hold only seed, config, progress uids and fog-of-war tiles; the world
  is regenerated from the seed. Storage failures are swallowed on purpose —
  progress is a convenience, never a requirement.

## Environment variety

Four cosmetic layers stop corridors reading as one repeated tile: texture
**variants** (4 per name, picked per block), per-block **tint jitter**, wall
**relief** (some tiles step up, plus accent bands and buttresses) and ground
**props**. All live in `render/` — they never touch `solid`, walkability or a
generation stream, so retuning them cannot shift an existing seed's world.

Two colour rules, both learned from bugs: never use a palette **accent** raw on
a large surface (a gold floor patch reads as a rendering bug — `weatheredTint()`
pulls it back toward its surface), and never tint a **prop** from its own biome
palette (a green tuft on green floor disappears — `propMaterial()` pushes it
away from the floor's luminance).

Details, tuning values and the draw-call budget: `.claude/docs/variety.md`.

## Maintaining this file

Update the affected section in the **same commit** as any change that
invalidates it: `TILE` or the coordinate helpers, the collision bounds, the
generation pipeline (step order, `fork()` usage, zone layout, loot-before-gate),
a new or changed unlock mechanism and its pool in `planProgression()`, the
invariants `npm test` covers, the npm commands, the layer boundaries, or the
variety layers in `render/decor.ts`. A stale
CLAUDE.md is worse than none — it sends the next session after an architecture
that no longer exists.

Split it when it passes ~200 lines, or when a single section passes ~40. Keep a
short core here (commands, determinism, layer boundaries, visual verification)
and move the detail to `.claude/docs/` — the natural cuts are `coordinates.md`,
`worldgen.md` and `mechanisms.md` — leaving a link from each section.
