/// <reference types="vite/client" />

/**
 * Compile-time dev-tools flag, injected by `vite.config.ts` from the
 * `VITE_DEV_TOOLS` environment variable (`npm run dev:debug` sets it).
 * A literal, so a production build folds it to `false` and drops `src/dev/`.
 */
declare const __DEV_TOOLS__: boolean;
