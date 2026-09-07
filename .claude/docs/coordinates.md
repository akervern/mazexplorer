# Coordinate spaces and collision

Detail behind the short section in CLAUDE.md.

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

