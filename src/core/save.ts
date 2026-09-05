/**
 * Local persistence via localStorage — deliberately plain, so a future PWA or
 * Capacitor wrapper keeps working with no storage-layer change.
 *
 * Only the seed, config and player progress are stored: the world itself is
 * regenerated from the seed, so saves stay a few kilobytes.
 */

import { TILE } from './types.js';
import type { GameConfig } from './types.js';

/**
 * Bump this whenever a change makes old saves geometrically invalid — the
 * TILE scale in particular, since a stored position is in world units and a
 * rescale drops it inside a wall.
 */
const KEY = `mazexplorer:save:v2:t${TILE}`;

export interface SavedProgress {
  config: GameConfig;
  elapsed: number;
  inventory: Record<string, number>;
  /** uids of mechanisms already unlocked. */
  unlocked: string[];
  /** uids of pickups already taken. */
  taken: string[];
  /** uids of teleporters already discovered. */
  discovered: string[];
  /** Fog-of-war tiles, "x,z". */
  revealed: string[];
  position: { x: number; y: number; z: number };
  yaw: number;
  savedAt: number;
}

export function saveProgress(p: SavedProgress): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // Storage can be unavailable (private mode, quota). Progress is a
    // convenience, never a requirement — failing silently is correct here.
  }
}

export function loadProgress(): SavedProgress | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedProgress;
    if (!parsed?.config?.seed) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function hasSave(): boolean {
  return loadProgress() !== null;
}

export function clearSave(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
