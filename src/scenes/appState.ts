/**
 * The vocabulary of the app's state machine: its states, its events, and the
 * shared context every state gets to act on.
 *
 * The whole screen flow is this one table:
 *
 *   menu     --start-->    playing
 *   playing  --pause-->    paused    (Esc, or pointer lock lost)
 *   playing  --finish-->   finished
 *   paused   --resume-->   playing
 *   paused   --quit-->     menu
 *   finished --replay-->   playing
 *   finished --quit-->     menu
 *
 * Anything not on that table cannot happen: `finished` declares no `pause`, so
 * a late key press after the exit is reached is dropped instead of showing a
 * pause overlay over the results.
 */

import type { GameConfig } from '../core/types.js';
import type { StateMachine, StateContext } from '../core/stateMachine.js';
import type { Game } from '../game.js';
import type { EndScreen, PauseOverlay, StartMenu } from '../ui/menu.js';

export type AppStateId = 'menu' | 'playing' | 'paused' | 'finished';

export type AppEvent = 'start' | 'pause' | 'resume' | 'quit' | 'finish' | 'replay';

/** Everything the states share: the screens, and the one live game (or none). */
export interface AppContext {
  /** Where the canvas and every screen are mounted. */
  readonly container: HTMLElement;
  readonly menu: StartMenu;
  readonly pause: PauseOverlay;
  readonly endScreen: EndScreen;
  /** The running game, owned by `playing` and torn down when it leaves. */
  game: Game | null;
  /** Config of the current or last run — what `replay` reuses. */
  config: GameConfig | null;
  /** Set by the machine's owner once built, so states can send events. */
  machine: AppMachine;
}

export type AppMachine = StateMachine<AppStateId, AppEvent, AppContext>;
export type AppState = StateContext<AppStateId, AppEvent, AppContext>;

/** Payload of the `start` and `replay` events. */
export interface StartPayload {
  config: GameConfig;
}

/** Payload of the `finish` event. */
export interface FinishPayload {
  seconds: number;
  biomes: number;
  explored: number;
}
