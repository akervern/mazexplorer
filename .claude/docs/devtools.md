# Dev mode

Detail behind the short section in CLAUDE.md.

Four tools in `src/dev/`, on function keys so they cannot collide with a
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
- **F4** — mechanism gallery and test bench: the catalogue grouped by
  `MechanismCategory`, each card with a "Tester" button that restarts the run
  on a two-zone world where every gate is that mechanism. See
  `mechanisms.md` for `forceMechanism` itself.

  Two things it has to get right, both learned the hard way:

  - It closes **without firing `onClose`** before restarting. `onClose`
    re-requests pointer lock on the game the restart is about to dispose, and
    the release still in flight from opening the panel then lands on the *new*
    game — which `main.ts` reads as the player walking away and stacks a pause
    over the bench run. The new game's `start()` requests the lock itself.
  - The restart goes through the state machine (`DevHost.restart` →
    `GameHooks.onRestart` → `send('start')`, a self-transition `playing` now
    declares), never by building a `Game` from inside `src/dev/`. `playing`
    stays the owner of the game's lifecycle.

Gating: `__DEV_TOOLS__`, a compile-time literal defined in `vite.config.ts` from
`VITE_DEV_TOOLS`. It must stay a literal, and the guard must sit **directly in
front of the `import()`** in `game.ts` — guarding only the calling method still
leaves a ~10 kB dev chunk in `dist/`. Verify with `ls dist/assets/` after a
plain `npm run build`: no `devTools-*.js` should appear. (The dev CSS does ship
in `style.css`; it is ~1 kB of unused rules, kept there so the panels inherit
the shared variables.)

`src/dev/` may read the world and the player, but nothing outside it may import
from it — `game.ts` holds only a `type` import plus the guarded dynamic one.

