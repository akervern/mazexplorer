/**
 * Start menu, pause overlay and end screen.
 * Seed and size are chosen here; the same pair always rebuilds the same world.
 */

import { randomSeedString } from '../core/rng.js';
import type { GameConfig, SizeKey } from '../core/types.js';
import { SIZE_PRESETS } from '../world/worldGen.js';
import { loadProgress, hasSave } from '../core/save.js';
import { escapeHtml } from './hud.js';

export interface MenuCallbacks {
  onStart(config: GameConfig): void;
  onResume?(): void;
}

export class StartMenu {
  private readonly root: HTMLElement;

  constructor(
    container: HTMLElement,
    private readonly callbacks: MenuCallbacks,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'menu-screen';
    container.appendChild(this.root);
    this.render();
  }

  private render(): void {
    const saved = hasSave() ? loadProgress() : null;
    const sizes = (Object.keys(SIZE_PRESETS) as SizeKey[])
      .map((k) => {
        const p = SIZE_PRESETS[k];
        return `<label class="size-option">
            <input type="radio" name="size" value="${k}" ${k === 'medium' ? 'checked' : ''}>
            <span class="size-label">${p.label}</span>
            <span class="size-meta">${p.biomes} biomes · ~${p.minutes} min</span>
          </label>`;
      })
      .join('');

    this.root.innerHTML = `
      <div class="menu-panel">
        <h1>Mazexplorer</h1>
        <p class="tagline">Un labyrinthe voxel, généré par graine. Pas d'ennemis — seulement le chemin.</p>

        <label class="field">
          <span>Graine (seed)</span>
          <div class="seed-row">
            <input type="text" data-seed value="${escapeHtml(randomSeedString())}" spellcheck="false">
            <button type="button" data-reroll title="Nouvelle graine aléatoire">🎲</button>
          </div>
        </label>

        <fieldset class="field">
          <legend>Taille du labyrinthe</legend>
          <div class="size-grid">${sizes}</div>
        </fieldset>

        <label class="field checkbox">
          <input type="checkbox" data-shadows checked>
          <span>Ombres portées (désactive pour plus de fluidité)</span>
        </label>

        <div class="menu-actions">
          <button class="primary" data-play>Générer &amp; Jouer</button>
          ${saved ? `<button data-continue>Reprendre (${escapeHtml(saved.config.seed)})</button>` : ''}
        </div>
        <p class="hint">ZQSD / WASD pour se déplacer · Souris pour regarder · E pour interagir · M pour la carte</p>
      </div>`;

    const seedInput = this.root.querySelector<HTMLInputElement>('[data-seed]')!;
    this.root.querySelector('[data-reroll]')!.addEventListener('click', () => {
      seedInput.value = randomSeedString();
    });

    this.root.querySelector('[data-play]')!.addEventListener('click', () => {
      const size = (this.root.querySelector<HTMLInputElement>('input[name=size]:checked')?.value ??
        'medium') as SizeKey;
      const shadows = this.root.querySelector<HTMLInputElement>('[data-shadows]')!.checked;
      const seed = seedInput.value.trim() || randomSeedString();
      this.callbacks.onStart({ seed, size, shadows });
    });

    this.root.querySelector('[data-continue]')?.addEventListener('click', () => {
      const s = loadProgress();
      if (s) this.callbacks.onStart(s.config);
    });
  }

  hide(): void {
    this.root.hidden = true;
  }

  show(): void {
    this.root.hidden = false;
    this.render();
  }

  dispose(): void {
    this.root.remove();
  }
}

/** End-of-run screen: time and seed, ready to share or replay. */
export class EndScreen {
  private readonly root: HTMLElement;

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'menu-screen';
    this.root.hidden = true;
    container.appendChild(this.root);
  }

  show(opts: {
    seconds: number;
    config: GameConfig;
    biomes: number;
    onReplay(): void;
    onMenu(): void;
  }): void {
    const m = Math.floor(opts.seconds / 60);
    const s = Math.floor(opts.seconds % 60);
    this.root.hidden = false;
    this.root.innerHTML = `
      <div class="menu-panel">
        <h1>Sortie atteinte 🎉</h1>
        <p class="tagline">${opts.biomes} biomes traversés.</p>
        <div class="result-row"><span>Temps</span><strong>${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}</strong></div>
        <div class="result-row"><span>Graine</span><strong class="seed-out">${escapeHtml(opts.config.seed)}</strong></div>
        <div class="result-row"><span>Taille</span><strong>${SIZE_PRESETS[opts.config.size].label}</strong></div>
        <div class="menu-actions">
          <button class="primary" data-replay>Rejouer cette graine</button>
          <button data-menu>Menu principal</button>
          <button data-copy>Copier la graine</button>
        </div>
      </div>`;

    this.root.querySelector('[data-replay]')!.addEventListener('click', () => {
      this.hide();
      opts.onReplay();
    });
    this.root.querySelector('[data-menu]')!.addEventListener('click', () => {
      this.hide();
      opts.onMenu();
    });
    this.root.querySelector('[data-copy]')!.addEventListener('click', () => {
      void navigator.clipboard?.writeText(opts.config.seed);
    });
  }

  hide(): void {
    this.root.hidden = true;
  }
}

/** Pause overlay shown when pointer lock is released. */
export class PauseOverlay {
  private readonly root: HTMLElement;

  constructor(container: HTMLElement, onResume: () => void, onQuit: () => void) {
    this.root = document.createElement('div');
    this.root.className = 'menu-screen pause';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="menu-panel compact">
        <h2>Pause</h2>
        <div class="menu-actions">
          <button class="primary" data-resume>Reprendre</button>
          <button data-quit>Quitter vers le menu</button>
        </div>
        <p class="hint">Progression sauvegardée automatiquement.</p>
      </div>`;
    container.appendChild(this.root);
    this.root.querySelector('[data-resume]')!.addEventListener('click', onResume);
    this.root.querySelector('[data-quit]')!.addEventListener('click', onQuit);
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  show(): void {
    this.root.hidden = false;
  }

  hide(): void {
    this.root.hidden = true;
  }
}
