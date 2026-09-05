/**
 * HUD: inventory, compass needle, toasts, signpost popup, teleporter menu.
 * All layout uses relative units so it survives small screens (see style.css).
 */

import type { CompassReading } from '../player/compass.js';
import type { Inventory } from '../core/inventory.js';
import { ITEMS } from '../world/items.js';

export interface TeleportOption {
  uid: string;
  label: string;
  zoneId: string;
}

export class Hud {
  private readonly root: HTMLElement;
  private readonly inventoryEl: HTMLElement;
  private readonly toastEl: HTMLElement;
  private readonly promptEl: HTMLElement;
  private readonly popupEl: HTMLElement;
  private readonly compassEl: HTMLElement;
  private readonly needleEl: HTMLElement;
  private readonly northEl: HTMLElement;
  private readonly compassLabel: HTMLElement;
  private readonly timerEl: HTMLElement;
  private readonly zoneEl: HTMLElement;
  private readonly clickPlayEl: HTMLElement;
  private toastTimer = 0;

  /** Set while the teleporter menu is open; blocks other interactions. */
  onTeleport: ((uid: string) => void) | null = null;

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="hud-top-left">
        <div class="zone-name" data-zone></div>
        <div class="timer" data-timer>00:00</div>
      </div>
      <div class="crosshair"></div>
      <div class="compass" data-compass hidden>
        <div class="compass-dial">
          <div class="compass-north" data-north></div>
          <div class="compass-needle" data-needle></div>
        </div>
        <div class="compass-label" data-compass-label></div>
      </div>
      <div class="inventory" data-inventory></div>
      <div class="prompt" data-prompt hidden></div>
      <div class="toast" data-toast hidden></div>
      <div class="click-to-play" data-click-play>
        <div class="ctp-card">
          <strong>Clique pour jouer</strong>
          <span>La souris pilote la caméra · Échap pour libérer</span>
        </div>
      </div>
      <div class="popup-backdrop" data-popup hidden></div>
    `;
    container.appendChild(this.root);

    const q = <T extends HTMLElement>(sel: string) => this.root.querySelector(sel) as T;
    this.inventoryEl = q('[data-inventory]');
    this.toastEl = q('[data-toast]');
    this.promptEl = q('[data-prompt]');
    this.popupEl = q('[data-popup]');
    this.compassEl = q('[data-compass]');
    this.needleEl = q('[data-needle]');
    this.northEl = q('[data-north]');
    this.compassLabel = q('[data-compass-label]');
    this.timerEl = q('[data-timer]');
    this.zoneEl = q('[data-zone]');
    this.clickPlayEl = q('[data-click-play]');
  }

  /** Show the "click to play" hint whenever the camera is not captured. */
  setPointerLockHint(visible: boolean): void {
    this.clickPlayEl.classList.toggle('is-visible', visible);
  }

  get element(): HTMLElement {
    return this.root;
  }

  /** Where the minimap canvas mounts. */
  createMinimapContainer(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'minimap';
    this.root.appendChild(el);
    return el;
  }

  setZoneName(name: string): void {
    this.zoneEl.textContent = name;
  }

  setTime(seconds: number): void {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    this.timerEl.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  renderInventory(inv: Inventory): void {
    const ids = inv.ids();
    if (!ids.length) {
      this.inventoryEl.innerHTML = '<div class="inv-empty">Sac vide</div>';
      return;
    }
    this.inventoryEl.innerHTML = ids
      .map((id) => {
        const item = ITEMS[id];
        const n = inv.counts[id];
        return `<div class="inv-slot" title="${item?.desc ?? ''}">
          <span class="inv-icon">${item?.icon ?? '❓'}</span>
          <span class="inv-name">${item?.name ?? id}</span>
          ${n > 1 ? `<span class="inv-count">×${n}</span>` : ''}
        </div>`;
      })
      .join('');
  }

  updateCompass(reading: CompassReading, playerYaw: number): void {
    if (reading.bearing === null && !reading.label) {
      this.compassEl.hidden = true;
      return;
    }
    this.compassEl.hidden = false;
    this.compassLabel.textContent = reading.label;
    // North sits at world yaw 0 (-Z). Counter-rotating by the player's yaw
    // keeps the letter pointing at true north as they turn.
    this.northEl.style.transform = `rotate(${-playerYaw}rad)`;
    if (reading.bearing !== null) {
      // Rotate into view space so the needle points relative to where we look.
      const rel = reading.bearing - playerYaw;
      this.needleEl.style.transform = `rotate(${rel}rad)`;
      this.needleEl.style.opacity = String(0.45 + reading.confidence * 0.55);
      this.needleEl.hidden = false;
    } else {
      this.needleEl.hidden = true;
    }
  }

  /** Contextual "press E" line. */
  setPrompt(text: string | null): void {
    if (!text) {
      this.promptEl.hidden = true;
      return;
    }
    this.promptEl.hidden = false;
    this.promptEl.textContent = text;
  }

  toast(message: string, duration = 3.2): void {
    this.toastEl.hidden = false;
    this.toastEl.textContent = message;
    this.toastTimer = duration;
  }

  update(dt: number): void {
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toastEl.hidden = true;
    }
  }

  get popupOpen(): boolean {
    return !this.popupEl.hidden;
  }

  /** Signpost / info popup. Returns a closer. */
  showPopup(title: string, lines: string[], footer = 'Échap ou E pour fermer'): void {
    this.popupEl.hidden = false;
    this.popupEl.innerHTML = `
      <div class="popup">
        <h2>${escapeHtml(title)}</h2>
        ${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('')}
        <div class="popup-footer">${escapeHtml(footer)}</div>
      </div>`;
  }

  /**
   * Teleporter destination picker.
   *
   * With a single pad discovered there is nothing to pick, so the menu explains
   * the network instead of showing a lone disabled button the player cannot
   * make sense of.
   */
  showTeleportMenu(options: TeleportOption[], current: string): void {
    this.popupEl.hidden = false;
    const elsewhere = options.filter((o) => o.zoneId !== current);
    const here = options.find((o) => o.zoneId === current);
    const hereName = here ? escapeHtml(here.label) : 'ce secteur';

    const body = elsewhere.length
      ? `<p>Réseau de téléportation — vous êtes à <strong>${hereName}</strong>.
           Choisis une destination déjà découverte :</p>
         <div class="tp-list">${elsewhere
           .map(
             (o) =>
               `<button class="tp-option" data-tp="${o.uid}">${escapeHtml(o.label)}</button>`,
           )
           .join('')}</div>`
      : `<p>Réseau de téléportation — vous êtes à <strong>${hereName}</strong>.</p>
         <p class="tp-empty">C'est le seul relais activé pour l'instant. Chaque nouveau
           secteur atteint ajoute son relais au réseau ; reviens ici pour voyager
           entre eux d'un pas.</p>`;

    this.popupEl.innerHTML = `
      <div class="popup">
        <h2>Téléporteur</h2>
        ${body}
        <div class="popup-footer">Échap pour annuler</div>
      </div>`;

    this.popupEl.querySelectorAll<HTMLButtonElement>('[data-tp]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const uid = btn.dataset.tp!;
        this.closePopup();
        this.onTeleport?.(uid);
      });
    });
  }

  closePopup(): void {
    this.popupEl.hidden = true;
    this.popupEl.innerHTML = '';
  }

  dispose(): void {
    this.root.remove();
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
