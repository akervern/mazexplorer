/** Entry point: builds the screen state machine and feeds it browser events. */

import './style.css';
import { createApp } from './scenes/index.js';

const app = createApp(document.getElementById('app')!);

/**
 * Losing pointer lock mid-game (Esc, alt-tab) pauses, so the player is not left
 * walking blind — but only when the player is the one who left. Two releases
 * are the app's own doing and must not pause: before the first click the
 * browser has granted no lock at all, and opening a dev panel drops the lock
 * deliberately so the cursor can reach it.
 *
 * Everything else is the machine's problem: `pause` outside `playing` is not a
 * declared transition, so it is dropped rather than guarded against here.
 */
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement) return;
  // Releases and re-acquisitions arrive as a burst of events — closing a dev
  // panel delivers the pending release *after* the re-request. Settle on the
  // next frame and judge the resulting state, not the individual event.
  requestAnimationFrame(() => {
    if (document.pointerLockElement) return;
    if (!app.pointerLockLossIsPause()) return;
    app.send('pause');
  });
});
