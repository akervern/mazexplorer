import { defineConfig } from 'vite';

/**
 * Two build knobs: the dev-tools flag, and the base path.
 *
 * `__DEV_TOOLS__` is inlined as a literal (not read from `import.meta.env` at
 * runtime) so that in a normal build `devToolsEnabled()` folds to `false` and
 * Rollup drops the whole `src/dev/` graph. Left as a runtime lookup, the
 * dynamic import in `game.ts` still emits a ~10 kB chunk into `dist/` that no
 * production build has any use for.
 *
 * `base` is `/` for dev and for the e2e suite; GitHub Pages serves the site
 * from `/<repo>/`, so the Actions workflow sets `BASE_PATH` accordingly.
 */
export default defineConfig(() => ({
  base: process.env.BASE_PATH ?? '/',
  define: {
    __DEV_TOOLS__: JSON.stringify(process.env.VITE_DEV_TOOLS === '1'),
  },
}));
