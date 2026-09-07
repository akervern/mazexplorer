/**
 * The run itself. Owns the `Game`: builds it on entry from the `start` /
 * `replay` payload, and turns the game's two hooks into machine events so the
 * game never has to know what a screen is.
 */

import type { State } from '../core/stateMachine.js';
import { clearSave, loadProgress } from '../core/save.js';
import { Game } from '../game.js';
import type { AppContext, AppEvent, AppStateId, StartPayload } from './appState.js';

export function playingState(ctx: AppContext): State<AppStateId, AppEvent, AppContext> {
  return {
    id: 'playing',
    // `start` re-enters `playing` from itself: the dev gallery's test bench
    // swaps the running world for another one without going through the menu.
    // A self-transition still runs `exit()` then `enter()`, so the old game is
    // disposed and the new config is honoured like any fresh run.
    on: { pause: 'paused', finish: 'finished', quit: 'menu', start: 'playing' },

    enter({ from, payload }) {
      // Coming back from the pause overlay resumes the same game; anything else
      // is a new run and carries a config.
      if (from === 'paused' && ctx.game) {
        ctx.game.resume();
        return;
      }

      const config = (payload as StartPayload | null)?.config ?? ctx.config;
      if (!config) throw new Error('playing entered without a config');
      ctx.config = config;

      ctx.game?.dispose();
      const game = new Game(ctx.container, config, {
        onFinish: (seconds) =>
          ctx.machine.send('finish', {
            seconds,
            // Zones actually walked through: a run takes one route through the
            // graph, so this is smaller than the world's zone count.
            biomes: game.world.teleporters.filter((t) => t.discovered).length,
            explored: game.world.zones.length,
          }),
        onPause: () => ctx.machine.send('pause'),
        // Dev gallery test bench: re-enter `playing` with another config.
        onRestart: (next) => ctx.machine.send('start', { config: next }),
      });
      ctx.game = game;

      // The dev bench is a throwaway world: it must neither restore the
      // player's progress nor wipe it on the way in.
      if (!config.forceMechanism) {
        // Resuming the same seed restores progress; a fresh seed starts clean.
        const saved = loadProgress();
        if (saved && saved.config.seed === config.seed && saved.config.size === config.size) {
          game.restore();
        } else {
          clearSave();
        }
      }

      game.start();
    },

    exit(next) {
      // Pausing keeps the game alive — `Game.pause()` already ran, either from
      // the Esc key or from the lost pointer lock. Any other exit ends the run.
      if (next === 'paused') return;
      ctx.game?.dispose();
      ctx.game = null;
    },
  };
}
