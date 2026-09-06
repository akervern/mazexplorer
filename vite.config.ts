import { defineConfig } from 'vite';

/**
 * The only build knob: the dev-tools flag.
 *
 * It is inlined as a literal (not read from `import.meta.env` at runtime) so
 * that in a normal build `devToolsEnabled()` folds to `false` and Rollup drops
 * the whole `src/dev/` graph. Left as a runtime lookup, the dynamic import in
 * `game.ts` still emits a ~10 kB chunk into `dist/` that no production build
 * has any use for.
 */
export default defineConfig(() => ({
  define: {
    __DEV_TOOLS__: JSON.stringify(process.env.VITE_DEV_TOOLS === '1'),
  },
}));
