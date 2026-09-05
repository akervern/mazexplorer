# Environment variety

How the renderer avoids reading as one tile repeated a hundred times.
Linked from the *Layer boundaries* section of `CLAUDE.md`.

Corridors used to read as one tile repeated, because every voxel of a texture
was the same 16x16 canvas. Four layers now fight that, all in `render/`:

1. **Texture variants** (`textures.ts`). Each name is drawn `VARIANTS` (4)
   times from different seeds; `variantHash(x,y,z)` in `voxelWorld.ts` picks
   one per block, so a face is a mosaic. Patterns layer tileable multi-octave
   value noise (`fbm`), a `mottle` cloud at a scale *above* the speckle, and a
   sparse `detail` pass (cracks, blotches, pebbles, tufts, flecks).
2. **Per-block tint jitter** (`voxelWorld.ts`). `TINT_STEPS` (3) brightness
   steps at ±2.5%. Keep it small and quantized: at ±6% a flat floor reads as a
   checkerboard, and an unquantized jitter would multiply batches per block.
3. **Wall relief** (`decor.ts`). A minority of wall *tiles* step up 1–2 blocks,
   plus accent bands and full-accent buttresses, so the skyline is not an
   extruded floorplan. Relief only ever raises — lowering a wall would let the
   player see over it and spoil the maze.
4. **Ground props** (`decor.ts` + `buildProps`). ~34% of floor tiles carry a
   small biome-specific shape (tuft, stalagmite, urn, bones…), batched per
   (kind, material) box.

Two rules learned the hard way, both about colour:

- Never use a palette **accent** raw for a large surface. Accents are chosen as
  highlights, so a gold floor patch or a crystal buttress reads as a rendering
  bug. `weatheredTint()` pulls them 30% back toward the surface they sit on.
- A prop tinted from its own biome palette **disappears** (a green tuft on a
  green floor). `propMaterial()` pushes every prop away from the floor's
  luminance instead.

All of this is cosmetic and lives in `render/` on purpose: it never touches
`solid`, walkability or a generation stream, so it can be retuned without
shifting any existing seed's world, and `world/` stays headless. Props are
skipped on tiles holding a pickup, signpost, teleporter, entry, exit or gate.

Cost check on a medium world: ~440 meshes but **78 draw calls** per frame after
frustum culling, for ~70k instances. Re-measure with
`renderer.info.render.calls` if you raise `VARIANTS` or `TINT_STEPS`.

