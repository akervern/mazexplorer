/**
 * Dev mode wiring: full map (F1), noclip flight (F2), debug overlay (F3).
 *
 * The whole feature is gated on `__DEV_TOOLS__`, a compile-time constant set
 * from `VITE_DEV_TOOLS` by `vite.config.ts` and true only under
 * `npm run dev:debug`. It must be a literal rather than an
 * `import.meta.env` lookup: Rollup can only drop the dynamic import in
 * `game.ts` — and with it this whole module graph — when the condition folds
 * to `false` at build time.
 *
 * Keys are Function keys on purpose: every letter is either movement or an
 * existing game binding, and F1-F3 cannot collide with AZERTY/QWERTY layouts.
 */

import type * as THREE from 'three';
import type { World, Zone } from '../core/types.js';
import { DevMap } from './devMap.js';
import { DevOverlay, type DevStats } from './devOverlay.js';

/** What the dev tools need from the running game. */
export interface DevHost {
  world: World;
  renderer: THREE.WebGLRenderer;
  currentZone(): Zone;
  playerState(): { x: number; y: number; z: number; yaw: number; pitch: number; noclip: boolean };
  elapsedTime(): number;
  /** Teleport to a world-space point (dev map click). */
  teleportToWorld(x: number, z: number): void;
  setNoclip(on: boolean): void;
  /** Freeze/unfreeze player input while a dev panel has the pointer. */
  setPanelOpen(open: boolean): void;
  toast(message: string): void;
}

export class DevTools {
  private readonly map: DevMap;
  private readonly overlay: DevOverlay;

  constructor(container: HTMLElement, private readonly host: DevHost) {
    this.map = new DevMap(container, host.world);
    this.overlay = new DevOverlay(container, host.world);

    this.map.onTeleport = (x, z) => {
      this.host.teleportToWorld(x, z);
      this.host.toast('Téléporté (dev)');
    };
    this.map.onClose = () => this.host.setPanelOpen(false);

    window.addEventListener('keydown', this.onKeyDown);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    switch (e.code) {
      case 'F1':
        // The browser's own help panel would otherwise steal F1.
        e.preventDefault();
        this.toggleMap();
        break;
      case 'F2':
        e.preventDefault();
        this.toggleNoclip();
        break;
      case 'F3':
        e.preventDefault();
        this.overlay.toggle();
        break;
      case 'Escape':
        // Escape pauses the game; swallow it while the map owns the screen.
        if (this.map.isOpen) {
          e.preventDefault();
          e.stopPropagation();
          this.map.hide();
        }
        break;
    }
  };

  private toggleMap(): void {
    this.map.toggle();
    // Opening releases pointer lock so the cursor can pick a destination.
    this.host.setPanelOpen(this.map.isOpen);
  }

  private toggleNoclip(): void {
    const on = !this.host.playerState().noclip;
    this.host.setNoclip(on);
    this.host.toast(on ? 'Noclip ON — vol libre' : 'Noclip OFF');
  }

  /** True while a dev panel is grabbing input; the game pauses movement. */
  get panelOpen(): boolean {
    return this.map.isOpen;
  }

  update(dt: number): void {
    const p = this.host.playerState();
    this.map.update(p.x, p.z, p.yaw);
    this.overlay.update(dt, {
      zone: this.host.currentZone(),
      position: { x: p.x, y: p.y, z: p.z },
      yaw: p.yaw,
      pitch: p.pitch,
      noclip: p.noclip,
      elapsed: this.host.elapsedTime(),
      renderer: this.host.renderer,
    } satisfies DevStats);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    this.map.dispose();
    this.overlay.dispose();
  }
}
