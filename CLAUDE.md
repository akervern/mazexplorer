# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Vite dev server, http://localhost:5173
npm run dev:debug  # same, plus the dev tools (full map, noclip, overlay)
npm test           # generation invariants (tsx src/world/worldGen.test.ts)
npm run test:e2e   # Playwright: renders the real game on the GPU (see Verification)
npm run test:all   # both suites
npm run typecheck  # tsc --noEmit
npm run build      # typecheck + vite build
```

`npm run test:e2e` starts its own dev server on port 5199 with the dev tools
on, since the tests drive the F1 map and F3 overlay. `--ui` opens the Playwright
runner; a failure leaves a screenshot and trace under `test-results/`.

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
   `originX`/`originZ` so all zone tiles share one global grid — laid out in
   2D, so locate a position with `zoneAt(world, x, z)`, never by X alone.
3. **World / voxel units** — grid × `TILE`.

`TILE` (`core/types.ts`, currently 3) is the single knob for corridor width.
Everything derived from it scales off it, so never hardcode a distance in world
units; write it as a multiple of `TILE`. Convert with `tileToWorld()` (tile
centre), `tileOrigin()` (low corner) and `linkToWorld()`; never multiply by
`TILE` by hand at a call site.

Collision bounds, the voxel `+0.5` offset, sub-stepping against tunnelling and
what changing `TILE` invalidates: `.claude/docs/coordinates.md`.

## Generation pipeline (`world/worldGen.ts`)

**The world is a graph, not a chain.** `generateWorld(config)`:
biome graph (`biome-graph` fork) → biome styles (`biome-order` fork — **no
biome is pinned to the front**, the starting one is drawn from the seed like
the rest) → one maze per node → 2D layout → `linkZones()` carves one passage
per graph edge and fills each gutter as an **L** (a straight interpolation
leaves diagonal, non-walkable gaps) → `planProgression()` → signposts →
teleporters.

The shape that follows from it:

- a zone can have **several exits** (`Zone.gates`, one per outgoing edge)
  leading to different biomes, and the branches **reconverge** before the end;
- some branches are **dead ends** holding loot — `Zone.optional`. Nothing the
  run needs may live there;
- zones are placed in **2D** (X = graph depth, Z = spread within a rank), so
  `originX`/`originZ` and `zoneAt(world, x, z)` — never an X-only lookup;
- **one mechanism per gate**, not per zone: two exits means two puzzles;
- `config.biomeCount` is the **depth** (biomes on one route), not the zone
  count. Alternative routes add zones without lengthening the run.

Details — graph construction, layout, portal placement, the gating constraints
and why each exists: `.claude/docs/worldgen.md`. Read it before touching
`linkZones`, `placeBlockingTiles` or the layout.

Biome mazes come from **randomized Kruskal** (`maze.ts`), not a recursive
backtracker: Kruskal merges many small clumps, so corridors stay short and
junctions are frequent — a backtracker grows one long snake with few branch
points. Two knobs shape the texture, and they pull against each other:

- `loop` (0.15) knocks out extra walls between already-connected cells. This is
  what makes crossroads; it also destroys chokepoints.
- `braid` (0.08) reopens dead ends. Kept low **because dead ends are wanted** —
  `loop` already provides the shortcuts braiding used to be responsible for.

Raising `loop` much past ~0.2 risks leaving no cut vertex on an entry→portal
path, and `placeBlockingTiles()` needs one per gate — `npm test` fails loudly
when that happens, so re-run it after touching either knob.

`planProgression()` assigns one mechanism per **gate**, drawn from a pool
chosen by the passage's role:

- most passages: `key_door`, `pedestal_offering`, `break_obstacle`, `activate_bridge`
- 1–2 "deep exploration" passages: `fragment_set`, `light_threshold`
- one late transition: `cross_biome_tool`, whose item is planted in a
  **dominator** — a zone every route crosses, since a zone on the branch the
  player skipped would make the run unwinnable.

Two subtle constraints, both load-bearing:

- loot for a gate goes only in `tilesBeforeGates()` — clear of **every** gate
  of its zone, or a key spawns behind its own door, or behind the other route's;
- a zone's gates must be mutually independent: opening one may never be a
  prerequisite for reaching another, or the branching collapses into a forced
  order.

## Adding an unlock mechanism

One entry in `src/world/unlockMechanisms.ts` plus its id in `MechanismTypeId`
(`core/types.ts`). Nothing else changes — maze generation, renderer, HUD,
compass, signposts and the dev gallery all go through the `MechanismType`
interface, and signposts read `requires` to write their own hint.

- `plan(ctx)` runs at generation and may return `null` to decline (the
  generator falls back to `key_door`); `onCheck` / `onUnlock` run at play time,
  and `onUnlock` may only call `clearBlocking()` / `buildBridge()`.
- Declare the four fields the gallery displays: `category`, `summary`,
  `consumes`, `targetKind`.
- Allow the id in the appropriate pool in `planProgression()` — pools are per
  *passage*, not per zone.

`MechanismCategory` groups the catalogue by **what it asks of the player**
(`fetch`, `sacrifice`, `collect`, `traversal`, `backtrack`) — a different axis
from the pools, which sort by a *passage's role* in the run.

Then run `npm test`: the invariants catch a mechanism that makes a world
unwinnable, in a normal world and in the dev bench's two-zone one.

The interface in full, the two axes, and the `forceMechanism` bench:
`.claude/docs/mechanisms.md`.

## What `npm test` guarantees

Per world: one connected walkable space; every passage reachable from its
zone's entry; **every gate is a true chokepoint** for its own passage (walling
it disconnects that route, so progression cannot be routed around); **the
routes are independent** (no gate gates another); **link tiles are floor in any
zone they cross** (geometry and grid must agree, or a gutter is a trench carved
across a biome — walkable, so nothing else catches it); the exit is gated; the
run is **completable** — a headless simulation collects reachable pickups and
fires reachable mechanisms until it wins — and still completable **ignoring
every optional branch**. Plus: edges always point to a later rank, some seeds
branch, and determinism (same seed ⇒ identical world, different seeds differ).

Plus, for the dev bench: every mechanism in the catalogue, forced onto a
two-zone world, still yields a **completable** run and really shows the
mechanism asked for (`cross_biome_tool` may fall back to `key_door` on the
start zone's gate, which has no earlier biome to plant its tool in).

These checks are pure logic and prove nothing about what is on screen. See
Verification below.

## Dev mode (`npm run dev:debug`)

Four tools in `src/dev/`, on function keys: **F1** full-world map (click a
tile to teleport), **F2** noclip, **F3** debug overlay (fps, seed, real
`ZoneStyle.name`, graph rank, this zone's exits and their mechanisms), **F4**
mechanism gallery.

The gallery lists the catalogue grouped by `MechanismCategory` and its
"Tester" button starts a throwaway run on a two-zone world where every gate is
that mechanism — `GameConfig.forceMechanism`, honoured at the single point in
`planProgression()` that picks a pool. Without it, seeing a specific mechanism
means rerolling seeds until the weighted draw yields it. The field is dev-only:
absent from a normal run, so no existing seed shifts. A bench run neither
restores nor writes the save (`playingState`, `Game.persist`).

Gated by `__DEV_TOOLS__`, a compile-time literal from `vite.config.ts`. The
guard must sit **directly in front of the `import()`** in `game.ts` — guarding
only the calling method still ships a ~10 kB dev chunk. Verify with
`ls dist/assets/` after a plain `npm run build`: no `devTools-*.js`.

`src/dev/` may read the world and the player, but nothing outside it may import
from it. Details: `.claude/docs/devtools.md`.

## Verification

`npm test` and `npm run typecheck` passing does **not** mean the change works:
they never render a frame. `npm run test:e2e` does — it drives the real game in
headless Chromium, on the actual GPU (AMD via ANGLE/Vulkan). `npm run test:all`
runs both.

For anything touching rendering, collision, camera, minimap or UI, add or
extend an e2e test — and still run `npm run dev:debug` and look at the screen
for anything about feel: proportions, colour, pacing. No assertion catches
"this reads wrong".

Two traps that cost real time, and the rest of the detail (config choices,
driving helpers, the pinned seed): `.claude/docs/e2e.md`.

- **Pointer lock cannot be granted by script** — noclip flight keys never
  respond in a test. Teleport from the dev map to frame a shot.
- **An e2e test that cannot fail is worse than none.** After writing one, break
  what it covers and watch it go red.

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
- Screen flow goes through the state machine (`scenes/`), never through screens
  toggling each other — see Screens and states.
- Saves hold only seed, config, progress uids and fog-of-war tiles; the world
  is regenerated from the seed. Storage failures are swallowed on purpose —
  progress is a convenience, never a requirement.

## Screens and states

`core/stateMachine.ts` is a generic, DOM-free FSM; `scenes/` holds the app's
four states and the shared context they act on. `main.ts` only builds the
machine and forwards `pointerlockchange`.

    menu --start--> playing --pause--> paused --resume--> playing
                    playing --finish--> finished
                    paused/finished --quit--> menu   finished --replay--> playing

The transition table is the whole flow: **an event a state does not declare is
dropped**, which is the point — `finished` has no `pause`, so an Esc after the
exit cannot stack a pause panel over the results.

Rules that keep it honest:

- A state's `enter()`/`exit()` owns showing and hiding its own screen. Screens
  never hide themselves in a click handler, or a transition down another path
  leaves one visible.
- `playing` owns the `Game`: it builds it, and disposes it on any exit except to
  `paused` (which keeps it alive so resuming is free). `Game.pause()`/`resume()`
  are idempotent — pause is reached both from Esc and from a lost pointer lock,
  and a second `resume()` would start a rival rAF loop.
- Screens report intent as events (`ctx.machine.send(...)`); they hold no
  reference to each other and no game state.
- **Pointer lock is not a pause signal by itself.** A dev panel releases the
  lock on purpose, and closing one delivers the pending release *after* the
  re-request — so `main.ts` settles on the next frame and judges the resulting
  state, and `Game.pointerLockLossIsPause` requires that the game still wants
  the lock (`InputManager.wantsLock`).
- Escape is consumed by `Game.handleActions`, topmost layer first (popup, then
  dev panel, then pause). It cannot be swallowed in `dev/`: the browser's own
  Esc-exits-pointer-lock is not preventable, and `InputManager` attaches before
  the dev tools load, so the action is already queued.

Adding a screen is one state file plus its id and events in `scenes/appState.ts`.

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
generation pipeline (step order, `fork()` usage, the biome graph, zone layout,
gate independence, loot-before-gates), a new or changed unlock mechanism and
its pool in `planProgression()`, the
invariants `npm test` covers, what the e2e suite drives, the npm commands, the
layer boundaries, or the variety layers in `render/decor.ts`. A stale
CLAUDE.md is worse than none — it sends the next session after an architecture
that no longer exists.

Split it when it passes ~200 lines, or when a single section passes ~40. Keep a
short core here (commands, determinism, layer boundaries, visual verification)
and move the detail to `.claude/docs/`, leaving a link from each section.
Already split out: `coordinates.md`, `worldgen.md`, `devtools.md`, `e2e.md`,
`variety.md`, `mechanisms.md`.
