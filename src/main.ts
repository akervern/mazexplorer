/** Entry point: wires the menu, the game and the end screen together. */

import './style.css';
import { Game } from './game.js';
import type { GameConfig } from './core/types.js';
import { clearSave, loadProgress } from './core/save.js';
import { EndScreen, PauseOverlay, StartMenu } from './ui/menu.js';

const app = document.getElementById('app')!;

let game: Game | null = null;

const endScreen = new EndScreen(app);

const pause = new PauseOverlay(
  app,
  () => {
    pause.hide();
    game?.resume();
  },
  () => {
    pause.hide();
    quitToMenu();
  },
);

const menu = new StartMenu(app, {
  onStart: (config) => startGame(config),
});

function startGame(config: GameConfig): void {
  game?.dispose();
  menu.hide();
  endScreen.hide();
  pause.hide();

  game = new Game(app, config, {
    onFinish: (seconds) => {
      clearSave();
      endScreen.show({
        seconds,
        config,
        biomes: game!.world.biomeCount,
        onReplay: () => startGame(config),
        onMenu: () => quitToMenu(),
      });
    },
    onPause: () => pause.show(),
  });

  // Resuming the same seed restores progress; a fresh seed starts clean.
  const saved = loadProgress();
  if (saved && saved.config.seed === config.seed && saved.config.size === config.size) {
    game.restore();
  } else {
    clearSave();
  }

  game.start();
}

function quitToMenu(): void {
  game?.dispose();
  game = null;
  endScreen.hide();
  pause.hide();
  menu.show();
}

/**
 * Losing pointer lock mid-game (Esc, alt-tab) pauses, so the player is not left
 * walking blind. But the lock is never granted before the player's first click
 * — browsers require a user gesture — so a game that has not captured it yet
 * must keep running rather than pausing on startup.
 */
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement) return;
  if (!game || pause.visible || !game.hasHadPointerLock) return;
  game.pause();
  pause.show();
});
