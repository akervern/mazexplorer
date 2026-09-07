/**
 * Mechanism gallery and test bench (F4).
 *
 * The problem it solves: `planProgression()` draws each gate's mechanism from
 * a weighted pool, so seeing a specific one — `light_threshold` at weight 1,
 * `cross_biome_tool` reserved for a single late passage — means rerolling
 * seeds until it turns up, then walking a whole world to reach it.
 *
 * This panel lists the catalogue grouped by `MechanismCategory` and starts a
 * throwaway run with `forceMechanism` set, on the smallest possible world:
 * every gate is that mechanism, its loot is in the first zone, and the exit is
 * one passage away. What it tests is the part `npm test` cannot see — the
 * blocking geometry on screen, the unlock effect, the signpost wording.
 *
 * Dev-only: reached exclusively from `DevTools`, itself behind `__DEV_TOOLS__`.
 */

import type { BlockingKind, GameConfig, MechanismTypeId } from '../core/types.js';
import {
  MECHANISM_CATEGORIES,
  MECHANISM_IDS,
  MECHANISM_TYPES,
  type MechanismCategory,
} from '../world/unlockMechanisms.js';

/**
 * Bench world: `biomeCount: 2` is the generator's floor — one starting zone,
 * one final zone, a single passage between them (plus the one dead-end branch
 * the graph always adds). `small` keeps the mazes at 7 cells, so the gate is a
 * few corridors from the spawn rather than a hike.
 */
/** Human-readable name for each blocking geometry. */
const BLOCKING_LABELS: Record<BlockingKind, string> = {
  door: 'porte',
  pedestal: 'socle',
  rubble: 'éboulis',
  gap: 'gouffre',
  gate: 'portail',
};

const BENCH: Omit<GameConfig, 'seed' | 'forceMechanism'> = {
  size: 'small',
  biomeCount: 2,
  shadows: true,
};

export class DevGallery {
  private readonly root: HTMLElement;
  private visible = false;

  /** Called with a bench config when a mechanism's "test" button is clicked. */
  onTest: ((config: GameConfig) => void) | null = null;
  /** Called when the panel closes, so the caller can re-grab pointer lock. */
  onClose: (() => void) | null = null;

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'devgallery';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="devgallery-panel">
        <header>
          <strong>Galerie des mécaniques — mode dev</strong>
          <span class="devgallery-count">${MECHANISM_IDS.length} mécaniques · ${
            Object.keys(MECHANISM_CATEGORIES).length
          } familles</span>
        </header>
        <div class="devgallery-body">${this.groups()}</div>
        <footer>
          <span>« Tester » relance une partie jetable : 2 secteurs, un seul passage, gardé par cette mécanique.</span>
          <button type="button" data-close>Fermer (F4)</button>
        </footer>
      </div>`;
    container.appendChild(this.root);

    this.root.querySelector('[data-close]')!.addEventListener('click', () => this.hide());
    for (const btn of this.root.querySelectorAll<HTMLButtonElement>('[data-test]')) {
      btn.addEventListener('click', () => this.test(btn.dataset.test as MechanismTypeId));
    }
    // Clicking the backdrop closes, like the dev map.
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) this.hide();
    });
  }

  /** The catalogue, grouped by category and in `MECHANISM_CATEGORIES` order. */
  private groups(): string {
    const cats = Object.keys(MECHANISM_CATEGORIES) as MechanismCategory[];
    return cats
      .map((cat) => {
        const ids = MECHANISM_IDS.filter((id) => MECHANISM_TYPES[id].category === cat);
        if (!ids.length) return '';
        const meta = MECHANISM_CATEGORIES[cat];
        return `
          <section class="devgallery-group">
            <h3>${escapeHtml(meta.label)} <span>${ids.length}</span></h3>
            <p class="devgallery-blurb">${escapeHtml(meta.blurb)}</p>
            <div class="devgallery-cards">${ids.map((id) => this.card(id)).join('')}</div>
          </section>`;
      })
      .join('');
  }

  private card(id: MechanismTypeId): string {
    const m = MECHANISM_TYPES[id];
    // Only what the mechanism declares statically. The per-instance values —
    // which item was drawn, how many fragments — are what the bench run puts
    // on screen; `plan()` cannot run without a generation context.
    return `
      <article class="devgallery-card">
        <h4>${escapeHtml(m.label)}</h4>
        <code>${escapeHtml(m.id)}</code>
        <p>${escapeHtml(m.summary)}</p>
        <dl>
          <div><dt>blocage</dt><dd>${escapeHtml(BLOCKING_LABELS[m.targetKind])}</dd></div>
          <div><dt>poids</dt><dd>${m.weight}</dd></div>
          <div><dt>consomme</dt><dd>${m.consumes ? 'oui' : 'non'}</dd></div>
        </dl>
        <button type="button" class="devgallery-test" data-test="${m.id}">Tester ▸</button>
      </article>`;
  }

  private test(id: MechanismTypeId): void {
    // A fresh seed each time: the bench is for looking at the mechanism, and a
    // new maze around it every run is more useful than a repeatable one.
    const seed = `bench-${id}-${Math.random().toString(36).slice(2, 7)}`;
    // Close *without* `onClose`: that re-requests pointer lock on the game
    // this restart is about to dispose, and the release still in flight from
    // opening the panel then lands on the new game — which `main.ts` reads as
    // the player walking away, stacking a pause over the bench run. The new
    // game's `start()` requests the lock itself.
    this.visible = false;
    this.root.hidden = true;
    this.onTest?.({ ...BENCH, seed, forceMechanism: id });
  }

  get isOpen(): boolean {
    return this.visible;
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  show(): void {
    this.visible = true;
    this.root.hidden = false;
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.root.hidden = true;
    this.onClose?.();
  }

  dispose(): void {
    this.root.remove();
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
