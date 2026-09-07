# World generation

Detail behind the short section in CLAUDE.md. `world/worldGen.ts`.

## The biome graph

`generateWorld(config)` runs:

biome graph (`biome-graph` fork) → biome styles (`biome-order` fork) → one maze
per node → 2D layout → `linkZones()` carves the passages and gutters →
`planProgression()` → signposts → teleporters.

The graph is a **DAG, not a chain**. `buildBiomeGraph(rng, depth)` lays out
ranks from the start zone to the final one:

- **rank 0** is the start, the last rank is the finish — both always alone, so
  the run has one opening and one ending;
- one or two **middle ranks are two zones wide**. Every zone of the previous
  rank opens onto every zone of the next, so a widening rank is a real choice
  of route and a narrowing one reconverges whichever side was taken. Both
  branches always reach the end: the choice is *which biome you cross*, never
  whether you can finish;
- one or two **dead-end branches** hang off a mid-graph zone. They hold loot
  and nothing else — never off the start (the player would take one for the way
  on) and never off the final zone.

`config.biomeCount` (from the size preset) is the **depth** — biomes on a
single route — not the number of zones. Widening a rank adds a zone without
making the run longer, so the two must not share a budget: an earlier version
did, and every fork paid for itself by shortening the game, which is why it
never actually forked at `medium`. `World.biomeCount` reports the zone count.

Routes stay comparable in length: at `medium` the shortest route crosses 4
gates, at `large` 5 — the same as the old chain. The extra mechanisms sit on
routes a given run never walks.

## Layout

Zones are placed in 2D: **X grows with graph depth** (so the run still reads
west to east and `Secteur N` keeps its meaning), **Z spreads a rank's zones**
around the axis. A rank's column is as wide as its widest maze.

Optional branches are laid out **beside their host**, in the host's own column,
north or south of it — not in their rank's stack. A branch parked in the stack
lands dozens of tiles from the zone it hangs off, and its gutter cannot reach
it without crossing another maze.

## Passages

`Zone.gates` is one `ZoneGate` per outgoing graph edge; `Zone.entry` is the
single tile the player arrives at. A zone reached by several parents keeps
**one** entry — later parents route their gutter to that same tile — so
progression has a single point to reason from.

`carveToSide()` opens a corridor from a walkable tile out to one side of the
grid. Two constraints on which tile:

- **away from the entry and from sibling portals** (a quarter of the maze span).
  A portal carved beside the entry shares its corridor, and then no tile can
  gate that passage without sealing the others off;
- **facing the source portal's line** when carving a destination entry, so the
  gutter is a straight run rather than an L dodging two mazes.

`carveGutter()` fills the gap as an L, trying every turn line and keeping one
whose legs stay outside every zone box. That is not always possible — the
portals sit on zone edges and the L between them can clip a corner — so
`openLinkTiles()` then opens, in the maze itself, any link tile that landed on
a wall. **Geometry and grid must agree**: otherwise the renderer lays a
corridor over tiles the maze still calls wall, and the gutter reads as a trench
cut across the biome. The world stays perfectly walkable, so no gating
invariant catches it; `npm test` checks it directly.

## Gating with several exits

**One mechanism per gate, not per zone.** A zone with two passages has two, so
the choice of route is also a choice of puzzle. A zone with no gate — the final
one, every dead-end branch — gets none: a branch's reward is its loot.

`placeBlockingTiles(zone, portals)` solves for the whole zone at once, by
backtracking over each portal's candidate cut vertices. Each gate must:

1. be a genuine chokepoint for **its own** portal (walling it cuts that portal
   off from the entry), and
2. leave every other portal and gate reachable **on its own**.

(2) is the subtle one. Without it, gate A stands between the entry and portal
B, B is only reachable by opening A first, and the two "alternatives" collapse
into a forced order. Greedy placement is not enough — the second passage gets
painted into a corner where its only remaining choice locks the first away — so
the assignment backtracks.

When no assignment exists at all, `ensureIndependentApproaches()` knocks out an
interior wall to open a second approach and retries. That is the same operation
as the `loop` knob, applied where the topology demands it rather than at
random.

Loot clears **every gate of its zone** (`tilesBeforeGates`), not just its own —
otherwise a key for one route sits behind the other.

`cross_biome_tool` plants its tool in a **dominator** (`dominatorsOf`): a zone
every route passes through. "An earlier zone" is not enough once routes branch
— a zone on one branch is skipped entirely by players who took the other.

Several passages can lead into the final zone, so several mechanisms carry
`isFinal`. The player opens the one on their route: `Game.checkFinish` and the
test simulation both accept **any** of them being unlocked.

## What `npm test` guarantees

Per world: one connected walkable space; every passage reachable from its
zone's entry; every gate a true chokepoint for its own passage; the routes
mutually independent; link tiles floor in any zone they cross; the exit gated;
the run completable; and completable **while ignoring every optional branch**
— a dead end must never hold something the run needs. Plus: edges always point
to a later rank (no cycle to walk around a gate), some seeds branch, and
determinism.
