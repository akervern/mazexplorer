/**
 * Developer debug overlay: a live readout of everything the HUD deliberately
 * hides — real biome names, tile/world coordinates, draw calls, progression
 * state — plus the dev-mode key legend.
 *
 * Deliberately text-only and cheap: it reads values the game already computed
 * for the frame, and refreshes on a timer rather than every frame so it never
 * shows up in the profile it is meant to help read.
 *
 * Dev-only: behind `import.meta.env.VITE_DEV_TOOLS` at its call site.
 */

import type * as THREE from 'three';
import { TILE } from '../core/types.js';
import type { World, Zone } from '../core/types.js';

/** Seconds between refreshes — 10 Hz reads fine and costs nothing. */
const REFRESH = 0.1;
/** Window over which the FPS average is taken, in seconds. */
const FPS_WINDOW = 0.5;

export interface DevStats {
  zone: Zone;
  position: { x: number; y: number; z: number };
  yaw: number;
  pitch: number;
  noclip: boolean;
  elapsed: number;
  renderer: THREE.WebGLRenderer;
}

export class DevOverlay {
  private readonly root: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private visible = true;

  private acc = 0;
  private fpsAcc = 0;
  private fpsFrames = 0;
  private fps = 0;

  constructor(container: HTMLElement, private readonly world: World) {
    this.root = document.createElement('div');
    this.root.className = 'devoverlay';
    this.root.innerHTML = `
      <div class="devoverlay-title">MODE DEV</div>
      <div class="devoverlay-body" data-body></div>
      <div class="devoverlay-keys">
        <b>F1</b> carte complète · <b>F2</b> noclip · <b>F3</b> overlay<br>
        en vol : <b>Espace</b> monter · <b>Ctrl</b> descendre · <b>Maj</b> vite
      </div>`;
    container.appendChild(this.root);
    this.bodyEl = this.root.querySelector('[data-body]')!;
  }

  get isVisible(): boolean {
    return this.visible;
  }

  toggle(): void {
    this.visible = !this.visible;
    this.root.hidden = !this.visible;
  }

  update(dt: number, stats: DevStats): void {
    // FPS is averaged over a window: a per-frame reciprocal jitters too much
    // to read, and the number is here to spot sustained drops.
    this.fpsAcc += dt;
    this.fpsFrames++;
    if (this.fpsAcc >= FPS_WINDOW) {
      this.fps = this.fpsFrames / this.fpsAcc;
      this.fpsAcc = 0;
      this.fpsFrames = 0;
    }

    if (!this.visible) return;
    this.acc += dt;
    if (this.acc < REFRESH) return;
    this.acc = 0;

    this.bodyEl.innerHTML = this.rows(stats)
      .map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`)
      .join('');
  }

  private rows(s: DevStats): [string, string][] {
    const p = s.position;
    const info = s.renderer.info;
    const zone = s.zone;
    // Global grid tile, the space the dev map and `Tile` both speak.
    const tx = Math.floor(p.x / TILE);
    const tz = Math.floor(p.z / TILE);
    // Zone-local tile, which is what `Zone.entry` / `exit` / mechanism targets use.
    const lx = tx - zone.originX;
    const lz = tz - zone.originZ;

    const tp = this.world.teleporters.find((t) => t.zoneId === zone.id);
    const mechs = this.world.mechanisms;
    const unlocked = mechs.filter((m) => m.unlocked).length;
    const taken = this.world.pickups.filter((pp) => pp.taken).length;
    const here = mechs.find((m) => m.zoneId === zone.id);

    return [
      ['fps', this.fps.toFixed(0)],
      ['seed', this.world.seed],
      ['secteur', `${tp?.label ?? zone.id} · ${zone.style.name}`],
      ['biome id', `${zone.biomeId} (#${zone.index})`],
      ['tile global', `${tx}, ${tz}`],
      ['tile locale', `${lx}, ${lz}`],
      ['monde', `${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`],
      ['cap / pitch', `${deg(s.yaw)}° / ${deg(s.pitch)}°`],
      ['noclip', s.noclip ? '<em class="on">ACTIF</em>' : 'off'],
      ['mécanisme ici', here ? `${here.type} ${here.unlocked ? '✓' : '✗'}` : '—'],
      ['progression', `${unlocked}/${mechs.length} mécanismes · ${taken}/${this.world.pickups.length} objets`],
      ['draw calls', `${info.render.calls} · ${info.render.triangles.toLocaleString('fr-FR')} tris`],
      ['géométries', `${info.memory.geometries} · ${info.memory.textures} textures`],
    ];
  }

  dispose(): void {
    this.root.remove();
  }
}

function deg(rad: number): string {
  return (((rad * 180) / Math.PI) % 360).toFixed(0);
}
