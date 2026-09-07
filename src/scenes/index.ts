/** Builds the app's state machine and its screens. */

import { StateMachine } from '../core/stateMachine.js';
import { EndScreen, PauseOverlay, StartMenu } from '../ui/menu.js';
import type { AppContext, AppEvent, AppMachine, AppStateId } from './appState.js';
import { menuState } from './menuState.js';
import { playingState } from './playingState.js';
import { pausedState } from './pausedState.js';
import { finishedState } from './finishedState.js';

export type { AppContext, AppEvent, AppMachine, AppStateId } from './appState.js';

/** What the entry point drives: the machine, plus the one bit of game state a
 * browser event needs to consult. */
export interface App {
  send(event: AppEvent, payload?: unknown): boolean;
  /**
   * Whether the running game has ever held pointer lock. Before the player's
   * first click the browser has granted nothing, so a `pointerlockchange` then
   * is startup noise, not the player leaving.
   */
  hasHadPointerLock(): boolean;
}

export function createApp(container: HTMLElement): App {
  const ctx = {
    container,
    menu: new StartMenu(container, {
      onStart: (config) => ctx.machine.send('start', { config }),
    }),
    pause: new PauseOverlay(
      container,
      () => ctx.machine.send('resume'),
      () => ctx.machine.send('quit'),
    ),
    endScreen: new EndScreen(container),
    game: null,
    config: null,
    // Filled in on the next line; the screens above only read it from inside
    // their callbacks, which cannot fire before then.
    machine: null as unknown as AppMachine,
  } satisfies AppContext as AppContext;

  ctx.machine = new StateMachine<AppStateId, AppEvent, AppContext>(ctx, [
    menuState(ctx),
    playingState(ctx),
    pausedState(ctx),
    finishedState(ctx),
  ]);

  ctx.machine.start('menu');

  return {
    send: (event, payload) => ctx.machine.send(event, payload),
    hasHadPointerLock: () => ctx.game?.hasHadPointerLock ?? false,
  };
}
