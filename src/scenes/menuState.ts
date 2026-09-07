/** Title screen: pick a seed and a size, then hand them to `playing`. */

import type { State } from '../core/stateMachine.js';
import type { AppContext, AppEvent, AppStateId } from './appState.js';

export function menuState(ctx: AppContext): State<AppStateId, AppEvent, AppContext> {
  return {
    id: 'menu',
    on: { start: 'playing' },

    enter() {
      // A finished or abandoned run leaves nothing behind: the next `start`
      // rebuilds a Game from the seed.
      ctx.game?.dispose();
      ctx.game = null;
      ctx.pause.hide();
      ctx.endScreen.hide();
      // `show()` re-renders, so a save written by the run that just ended turns
      // into a "Reprendre" button without the menu being told about it.
      ctx.menu.show();
    },

    exit() {
      ctx.menu.hide();
    },
  };
}
