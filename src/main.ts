/** Entry point: builds the screen state machine and feeds it browser events. */

import './style.css';
import { createApp } from './scenes/index.js';

const app = createApp(document.getElementById('app')!);

/**
 * Losing pointer lock mid-game (Esc, alt-tab) pauses, so the player is not left
 * walking blind. But the lock is never granted before the player's first click
 * — browsers require a user gesture — so a game that has not captured it yet
 * must keep running rather than pausing on startup.
 *
 * Everything else is the machine's problem: `pause` outside `playing` is not a
 * declared transition, so it is dropped rather than guarded against here.
 */
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement) return;
  if (!app.hasHadPointerLock()) return;
  app.send('pause');
});
