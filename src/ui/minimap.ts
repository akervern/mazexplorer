/**
 * Minimap: a real top-down orthographic view of the voxel world, rendered to
 * its own canvas, with progressive fog of war.
 *
 * The scene is shared with the main view (same meshes, no duplication); only
 * the camera differs. Fog of war is a 2D overlay canvas: tiles the player has
 * been near are punched out of an opaque mask.
 */

import * as THREE from 'three';
import type { World } from '../core/types.js';

const REVEAL_RADIUS = 5.5;
const VIEW_SPAN = 26; // world units visible across the minimap

export class Minimap {
  readonly camera: THREE.OrthographicCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly overlay: HTMLCanvasElement;
  private readonly octx: CanvasRenderingContext2D;
  /** Revealed tiles, `x,z`. */
  private revealed = new Set<string>();
  private size: number;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly world: World,
    container: HTMLElement,
  ) {
    this.size = 200;
    const half = VIEW_SPAN / 2;
    this.camera = new THREE.OrthographicCamera(-half, half, half, -half, 0.1, 200);
    this.camera.position.set(0, 60, 0);
    this.camera.up.set(0, 0, -1);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(this.size, this.size, false);
    const canvas = this.renderer.domElement;
    canvas.className = 'minimap-canvas';
    container.appendChild(canvas);

    this.overlay = document.createElement('canvas');
    this.overlay.className = 'minimap-overlay';
    this.overlay.width = this.size;
    this.overlay.height = this.size;
    container.appendChild(this.overlay);
    this.octx = this.overlay.getContext('2d')!;
  }

  /** Reveal the area around the player and re-render. */
  update(playerX: number, playerZ: number, yaw: number): void {
    // --- fog of war bookkeeping ---
    const r = Math.ceil(REVEAL_RADIUS);
    const px = Math.floor(playerX);
    const pz = Math.floor(playerZ);
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dz * dz > REVEAL_RADIUS * REVEAL_RADIUS) continue;
        this.revealed.add(`${px + dx},${pz + dz}`);
      }
    }

    // --- 3D top-down pass ---
    this.camera.position.set(playerX, 60, playerZ);
    this.camera.lookAt(playerX, 0, playerZ);
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);

    // --- fog + markers overlay ---
    this.drawOverlay(playerX, playerZ, yaw);
  }

  private worldToScreen(wx: number, wz: number, playerX: number, playerZ: number) {
    const scale = this.size / VIEW_SPAN;
    return {
      x: this.size / 2 + (wx - playerX) * scale,
      y: this.size / 2 + (wz - playerZ) * scale,
    };
  }

  private drawOverlay(playerX: number, playerZ: number, yaw: number): void {
    const ctx = this.octx;
    const s = this.size;
    ctx.clearRect(0, 0, s, s);

    // Opaque fog everywhere, then punch out revealed tiles.
    ctx.fillStyle = 'rgba(10, 12, 18, 0.92)';
    ctx.fillRect(0, 0, s, s);

    const scale = s / VIEW_SPAN;
    ctx.globalCompositeOperation = 'destination-out';
    const span = Math.ceil(VIEW_SPAN / 2) + 2;
    for (let dz = -span; dz <= span; dz++) {
      for (let dx = -span; dx <= span; dx++) {
        const wx = Math.floor(playerX) + dx;
        const wz = Math.floor(playerZ) + dz;
        if (!this.revealed.has(`${wx},${wz}`)) continue;
        const p = this.worldToScreen(wx, wz, playerX, playerZ);
        ctx.fillRect(p.x - scale / 2, p.y - scale / 2, scale + 1, scale + 1);
      }
    }
    ctx.globalCompositeOperation = 'source-over';

    // --- teleporter markers (discovered only) ---
    for (const tp of this.world.teleporters) {
      if (!tp.discovered) continue;
      const zone = this.world.zones.find((z) => z.id === tp.zoneId)!;
      const wx = zone.originX + tp.tile.x + 0.5;
      const wz = zone.originZ + tp.tile.y + 0.5;
      if (Math.abs(wx - playerX) > VIEW_SPAN / 2 || Math.abs(wz - playerZ) > VIEW_SPAN / 2) continue;
      const p = this.worldToScreen(wx, wz, playerX, playerZ);
      ctx.fillStyle = '#66ccff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // --- player arrow ---
    const cx = s / 2;
    const cy = s / 2;
    ctx.save();
    ctx.translate(cx, cy);
    // yaw 0 faces -Z (up on the map); screen Y grows downward.
    ctx.rotate(-yaw);
    ctx.fillStyle = '#ffe066';
    ctx.strokeStyle = '#1a1a1a';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(5, 6);
    ctx.lineTo(0, 3);
    ctx.lineTo(-5, 6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  /** Resize to the CSS box the container currently occupies. */
  resize(px: number): void {
    this.size = Math.max(120, Math.round(px));
    this.renderer.setSize(this.size, this.size, false);
    this.overlay.width = this.size;
    this.overlay.height = this.size;
  }

  /** Serialisable fog-of-war state. */
  toJSON(): string[] {
    return [...this.revealed];
  }

  restore(tiles: string[]): void {
    this.revealed = new Set(tiles);
  }

  dispose(): void {
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.overlay.remove();
  }
}
