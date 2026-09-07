/** Results screen: time, seed and size, with replay and menu as events. */

import type { State } from '../core/stateMachine.js';
import { clearSave } from '../core/save.js';
import type { AppContext, AppEvent, AppStateId, FinishPayload } from './appState.js';

export function finishedState(ctx: AppContext): State<AppStateId, AppEvent, AppContext> {
  return {
    id: 'finished',
    // Deliberately no `pause`: the run is over, a stray Esc must not overlay a
    // pause panel on the results.
    on: { replay: 'playing', quit: 'menu' },

    enter({ payload }) {
      const { seconds, biomes, explored } = payload as FinishPayload;
      const config = ctx.config!;
      // The run is won; the save would only offer to resume a finished world.
      clearSave();
      ctx.endScreen.show({
        seconds,
        config,
        biomes,
        explored,
        onReplay: () => ctx.machine.send('replay', { config }),
        onMenu: () => ctx.machine.send('quit'),
      });
    },

    exit() {
      ctx.endScreen.hide();
    },
  };
}
