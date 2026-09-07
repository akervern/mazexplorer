/**
 * Pause overlay. The game object stays alive and simply stops ticking, so
 * resuming is free — no world regeneration, no reload from the save.
 */

import type { State } from '../core/stateMachine.js';
import type { AppContext, AppEvent, AppStateId } from './appState.js';

export function pausedState(ctx: AppContext): State<AppStateId, AppEvent, AppContext> {
  return {
    id: 'paused',
    on: { resume: 'playing', quit: 'menu' },

    enter() {
      // `pause()` is idempotent, which matters: this state is reached both from
      // the Esc key (the game paused itself) and from a lost pointer lock
      // (it did not).
      ctx.game?.pause();
      ctx.pause.show();
    },

    exit() {
      ctx.pause.hide();
    },
  };
}
