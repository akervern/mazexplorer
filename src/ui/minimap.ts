/**
 * Minimap: a real top-down orthographic view of the voxel world, drawn as a
 * second viewport pass of the *main* renderer, with progressive fog of war.
 *
 * It must share the main renderer: meshes live in one WebGL context, and a
 * second WebGLRenderer cannot see them (GPU resources are per-context), which
 * would render an empty map.
 *
 * The fog of war is a 2D overlay canvas stacked on top of the shared 3D canvas:
 * tiles the player has been near get punched out of an opaque mask.
 */

import * as THREE from 'three';
import { TILE } from '../core/types.js';
import { tileToWorld } from '../world/worldGen.js';
import type { World } from '../core/types.js';

/**
 * How far vision spreads along open passages, in maze tiles. This is a path
 * distance, not a straight-line radius: walls stop it.
 */
const REVEAL_RADIUS = 6;
/** World units visible across the minimap (scales with TILE). */
const VIEW_SPAN = 15 * TILE;
/** Low enough to stay inside every biome's fog range is impossible, so the
 *  fog is disabled for this pass instead; the height only needs to clear the
 *  tallest geometry (walls cap at y=3). */
const CAM_HEIGHT = 40 * TILE;

export class Minimap {
  readonly camera: THREE.OrthographicCamera;
  private readonly overlay: HTMLCanvasElement;
  private readonly octx: CanvasRenderingContext2D;
  /** Revealed tiles, `x,z`. */
  private revealed = new Set<string>();
  /** CSS pixel size of the square map. */
  private size = 200;
  private lastPlayer = { x: 0, z: 0, yaw: 0 };

  /** Walkable tiles in world-grid units, `tx,tz` — walls are absent. */
  private readonly walkable = new Set<string>();

  constructor(
    private readonly world: World,
    private readonly container: HTMLElement,
  ) {
    for (const z of world.zones) {
      for (const t of z.tiles) this.walkable.add(`${z.originX + t.x},${z.originZ + t.y}`);
      for (const l of z.links) this.walkable.add(`${l.x},${l.z}`);
    }
    const half = VIEW_SPAN / 2;
    this.camera = new THREE.OrthographicCamera(-half, half, half, -half, 0.1, 200 * TILE);
    // Looking straight down: +Z must map to "down" on the map, so the camera's
    // up vector points along -Z. lookAt() is called per-frame with an offset
    // target, never a point colinear with up.
    this.camera.up.set(0, 0, -1);

    this.overlay = document.createElement('canvas');
    this.overlay.className = 'minimap-overlay';
    container.appendChild(this.overlay);
    this.octx = this.overlay.getContext('2d')!;
    this.resize(container.clientWidth || this.size);
  }

  /** Record exploration and position; the 3D pass happens in `render`. */
  update(playerX: number, playerZ: number, yaw: number): void {
    this.lastPlayer = { x: playerX, z: playerZ, yaw };

    this.revealVisible(Math.floor(playerX / TILE), Math.floor(playerZ / TILE));

    this.drawOverlay(playerX, playerZ, yaw);
  }

  /**
   * Reveal only what the player can actually see from where they stand: the
   * current passage, spreading through open tiles and stopping at walls.
   *
   * A plain radius would punch through walls and expose corridors the player
   * has never walked, which gives away the maze. This walks the walkable graph
   * instead, so a wall one tile away hides everything behind it.
   */
  private revealVisible(px: number, pz: number): void {
    const start = `${px},${pz}`;
    // Standing inside a wall (mid-teleport, spawn nudge): reveal just here.
    if (!this.walkable.has(start)) {
      this.revealed.add(start);
      return;
    }

    const seen = new Set([start]);
    let frontier = [{ x: px, z: pz, d: 0 }];
    this.revealed.add(start);

    while (frontier.length) {
      const next: typeof frontier = [];
      for (const cur of frontier) {
        if (cur.d >= REVEAL_RADIUS) continue;
        for (const [dx, dz] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
          const nx = cur.x + dx;
          const nz = cur.z + dz;
          const k = `${nx},${nz}`;
          if (seen.has(k)) continue;
          seen.add(k);
          // Walls are drawn as seen (you can see the wall facing you) but the
          // spread stops there, so nothing behind them is exposed.
          this.revealed.add(k);
          if (this.walkable.has(k)) next.push({ x: nx, z: nz, d: cur.d + 1 });
        }
      }
      frontier = next;
    }
  }

  /**
   * Second render pass, sharing the main renderer so the map sees the same
   * meshes. Call after the main scene render; it restores full-canvas state.
   */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene): void {
    const { x, z } = this.lastPlayer;
    this.camera.position.set(x, CAM_HEIGHT, z);
    // Target is directly below, so aim slightly along -Z to keep the view
    // matrix well-defined against the -Z up vector.
    this.camera.lookAt(x, 0, z - 0.001);
    this.camera.updateProjectionMatrix();

    // Map the viewport to the same screen box the CSS gives the container.
    const rect = this.container.getBoundingClientRect();
    const canvasRect = renderer.domElement.getBoundingClientRect();
    const left = rect.left - canvasRect.left;
    // WebGL's Y origin is bottom-left; the DOM's is top-left.
    const bottom = canvasRect.height - (rect.top - canvasRect.top) - rect.height;

    const prevScissorTest = renderer.getScissorTest();
    renderer.setViewport(left, bottom, rect.width, rect.height);
    renderer.setScissor(left, bottom, rect.width, rect.height);
    renderer.setScissorTest(true);

    // Biome fog is tuned for eye level (far: 24-60), so from 40 units up it
    // would swallow the whole map in flat fog colour. Drop it for this pass.
    const prevFog = scene.fog;
    scene.fog = null;
    // autoClear is off for this pass so the main view survives underneath.
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(scene, this.camera);
    renderer.autoClear = prevAutoClear;
    scene.fog = prevFog;

    // Restore the full canvas for the next frame's main pass.
    renderer.setScissorTest(prevScissorTest);
    renderer.setViewport(0, 0, canvasRect.width, canvasRect.height);
    renderer.setScissor(0, 0, canvasRect.width, canvasRect.height);
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

    const scale = s / VIEW_SPAN; // screen px per world unit
    ctx.globalCompositeOperation = 'destination-out';
    const span = Math.ceil(VIEW_SPAN / TILE / 2) + 2;
    const ptx = Math.floor(playerX / TILE);
    const ptz = Math.floor(playerZ / TILE);
    for (let dz = -span; dz <= span; dz++) {
      for (let dx = -span; dx <= span; dx++) {
        const tx = ptx + dx;
        const tz = ptz + dz;
        if (!this.revealed.has(`${tx},${tz}`)) continue;
        // A revealed tile covers TILE x TILE world units.
        const p = this.worldToScreen(tx * TILE, tz * TILE, playerX, playerZ);
        const side = scale * TILE;
        ctx.fillRect(p.x, p.y, side + 1, side + 1);
      }
    }
    ctx.globalCompositeOperation = 'source-over';

    // --- teleporter markers (discovered only) ---
    for (const tp of this.world.teleporters) {
      if (!tp.discovered) continue;
      const zone = this.world.zones.find((z) => z.id === tp.zoneId)!;
      const { x: wx, z: wz } = tileToWorld(zone, tp.tile);
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
    ctx.save();
    ctx.translate(s / 2, s / 2);
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
    const dpr = Math.min(devicePixelRatio, 2);
    this.overlay.width = this.size * dpr;
    this.overlay.height = this.size * dpr;
    this.overlay.style.width = '100%';
    this.overlay.style.height = '100%';
    this.octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Serialisable fog-of-war state. */
  toJSON(): string[] {
    return [...this.revealed];
  }

  restore(tiles: string[]): void {
    this.revealed = new Set(tiles);
  }

  dispose(): void {
    this.overlay.remove();
  }
}
