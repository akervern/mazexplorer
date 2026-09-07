# End-to-end tests (Playwright)

Detail behind the Verification section in CLAUDE.md. Config in
`playwright.config.ts`, helpers in `tests/helpers.ts`.

## Why the config looks like that

- **`channel: 'chromium'`** — the headless *shell* Playwright installs by
  default ships without the GPU stack and silently falls back to SwiftShader.
- **No `...devices['Desktop Chrome']`** — the descriptor carries its own
  1280x720 viewport, which overrides the suite's and shrinks the dev map enough
  to push the southern zones out of the sweep. That cost an hour once.
- **`tests/gpu.spec.ts` asserts the renderer** — SwiftShader draws every other
  test just as happily, so without this check a fallback reads as a pass and
  "verified on the GPU" quietly stops being true.
- **One worker, no parallelism** — each test builds a whole voxel world.
- **The dev server runs with `VITE_DEV_TOOLS=1`** on port 5199: the tests drive
  the F1 map and F3 overlay, which a production build does not contain.

## Driving the game

`startRun(page, seed, size)` fills the menu and waits for the HUD to name a
zone. Then:

- `showOverlay()` — the F3 panel starts **visible** under `dev:debug`, so a
  blind `F3` turns it *off*. A hidden overlay stops refreshing, so its rows go
  stale and every later assertion reads the start zone: a teleport looks like
  it silently failed when it actually worked.
- `openDevMap()` / `teleportTo(/Secteur N/)` — the map is swept inside the page
  (synthetic `mousemove` against its own handler, reading `[data-info]`), then
  clicked for real. Sampling one point per round-trip turns a sweep into
  minutes; doing it in-page takes milliseconds.
- `overlayShowing(label, /pattern/)` polls until the overlay reflects the new
  state, instead of sleeping a guessed amount.

Two hard constraints:

- **Pointer lock cannot be granted by script.** Anything depending on it —
  the FPS controls, noclip flight with Space/Ctrl — never responds. Frame a
  shot by teleporting, never by flying.
- **The dev map closes itself on teleport.** Pressing Escape afterwards is not
  a no-op: the game receives it and opens the pause panel.

## Ignored console noise

`collectErrors()` filters the favicon 404 — the browser requests it on its own
and the page declares none. Everything else fails the test: the assertion is
"zero errors", not "few errors", so a real one cannot hide in the noise.

## Writing a new one

An e2e test that cannot fail is worse than none. After writing one, break the
thing it covers and watch it go red. The first version of the map test counted
walls and floors; dropping every maze tile from the map *raised* the wall count
and it stayed green. It now asserts that all nine zones of the pinned seed are
namable as floor.

`g199/large` is pinned on purpose: it is the layout that exposed the
gutter-through-a-maze bug, and it has both a forking rank and two dead-end
branches.
