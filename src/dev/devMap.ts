/**
 * Developer full-world map.
 *
 * A flat 2D canvas drawn straight from the `World` data — deliberately *not*
 * the in-game minimap: that one is a 3D viewport pass with fog of war, and
 * stretching it to the whole world would mean disabling the very thing it
 * exists for. This one has no fog, shows every zone at once, and every marker
 * the generator produced (gates, pickups, signposts, teleporters, entry/exit).
 *
 * Clicking a walkable tile teleports there — see `onTeleport`.
 *
 * Dev-only: this module is behind `import.meta.env.VITE_DEV_TOOLS` at its call
 * site, so a production build never pulls it in.
 */

import { TILE } from '../core/types.js';
import type { Mechanism, Tile, World, Zone } from '../core/types.js';

/** Padding around the world bounds, in tiles. */
const PAD = 2;

interface Marker {
  x: number;
  z: number;
  color: string;
  label: string;
  ring?: boolean;
}

export class DevMap {
  private readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly infoEl: HTMLElement;

  /** Walkable tiles in global grid units, `tx,tz`. */
  private readonly walkable = new Set<string>();
  /** Which zone each walkable tile belongs to, for the tile colour. */
  private readonly zoneOfTile = new Map<string, Zone>();
  private markers: Marker[] = [];

  /** World bounds in global grid tiles. */
  private minX = 0;
  private minZ = 0;
  private spanX = 1;
  private spanZ = 1;

  /** Grid tiles per CSS pixel, recomputed on every resize. */
  private scale = 1;
  private offX = 0;
  private offZ = 0;

  private visible = false;
  /** Player position in world units, for the arrow. */
  private player = { x: 0, z: 0, yaw: 0 };

  /** Called with world-unit coordinates when a walkable tile is clicked. */
  onTeleport: ((x: number, z: number) => void) | null = null;
  /** Called when the map is closed, so the caller can re-grab pointer lock. */
  onClose: (() => void) | null = null;

  constructor(container: HTMLElement, private readonly world: World) {
    this.indexWorld();

    this.root = document.createElement('div');
    this.root.className = 'devmap';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="devmap-panel">
        <header>
          <strong>Carte complète — mode dev</strong>
          <span class="devmap-seed">seed ${escapeHtml(world.seed)} · ${world.biomeCount} secteurs</span>
        </header>
        <div class="devmap-canvas-wrap"><canvas></canvas></div>
        <footer>
          <span class="devmap-info" data-info>Clique une case pour t'y téléporter</span>
          <span class="devmap-legend">
            <i style="background:#ffe066"></i>joueur
            <i style="background:#66ccff"></i>téléporteur
            <i style="background:#ff6b6b"></i>blocage
            <i style="background:#8affc1"></i>objet
            <i style="background:#c8a2ff"></i>panneau
            <i style="background:#ffffff"></i>entrée/sortie
          </span>
          <span class="devmap-hint">F1 ou Échap pour fermer</span>
        </footer>
      </div>`;
    container.appendChild(this.root);

    this.canvas = this.root.querySelector('canvas')!;
    this.ctx = this.canvas.getContext('2d')!;
    this.infoEl = this.root.querySelector('[data-info]')!;

    this.canvas.addEventListener('click', this.onClick);
    this.canvas.addEventListener('mousemove', this.onHover);
    this.root.addEventListener('click', (e) => {
      // Clicking the backdrop (outside the panel) closes.
      if (e.target === this.root) this.hide();
    });
    window.addEventListener('resize', this.onResize);
  }

  /** Collect walkable tiles and every marker worth seeing, once. */
  private indexWorld(): void {
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;

    const add = (tx: number, tz: number, zone: Zone) => {
      const k = `${tx},${tz}`;
      this.walkable.add(k);
      this.zoneOfTile.set(k, zone);
      if (tx < minX) minX = tx;
      if (tz < minZ) minZ = tz;
      if (tx > maxX) maxX = tx;
      if (tz > maxZ) maxZ = tz;
    };

    for (const zone of this.world.zones) {
      for (const t of zone.tiles) add(zone.originX + t.x, zone.originZ + t.y, zone);
      // Links are already in global grid units (see `linkToWorld`).
      for (const l of zone.links) add(l.x, l.z, zone);
    }

    this.minX = minX - PAD;
    this.minZ = minZ - PAD;
    this.spanX = maxX - minX + 1 + PAD * 2;
    this.spanZ = maxZ - minZ + 1 + PAD * 2;

    this.rebuildMarkers();
  }

  /**
   * Markers reflect live progress (a taken pickup, an unlocked gate), so they
   * are rebuilt every time the map opens rather than cached at construction.
   */
  private rebuildMarkers(): void {
    const m: Marker[] = [];
    const at = (zoneId: string, tile: Tile) => {
      const zone = this.zoneOf(zoneId);
      return { x: zone.originX + tile.x, z: zone.originZ + tile.y };
    };

    for (const z of this.world.zones) {
      const e = { x: z.originX + z.entry.x, z: z.originZ + z.entry.y };
      const x = { x: z.originX + z.exit.x, z: z.originZ + z.exit.y };
      m.push({ ...e, color: '#ffffff', label: `${z.id} entrée` });
      m.push({ ...x, color: '#ffffff', label: `${z.id} sortie` });
    }
    for (const s of this.world.signposts) {
      m.push({ ...at(s.zoneId, s.tile), color: '#c8a2ff', label: `panneau : ${s.title}` });
    }
    for (const p of this.world.pickups) {
      if (p.taken) continue;
      m.push({ ...at(p.zoneId, p.tile), color: '#8affc1', label: `objet : ${p.itemId}` });
    }
    for (const k of this.world.mechanisms) {
      if (k.unlocked) continue;
      m.push({ ...at(k.zoneId, k.target.tile), color: '#ff6b6b', label: this.mechLabel(k), ring: true });
    }
    for (const t of this.world.teleporters) {
      m.push({
        ...at(t.zoneId, t.tile),
        color: t.discovered ? '#66ccff' : '#3b6f8a',
        label: `téléporteur : ${t.label}${t.discovered ? '' : ' (non découvert)'}`,
        ring: true,
      });
    }
    this.markers = m;
  }

  private mechLabel(k: Mechanism): string {
    const needs = k.requires.length ? ` — requiert ${k.requires.join(', ')}` : '';
    return `${k.type} (${k.target.type})${needs}${k.isFinal ? ' · final' : ''}`;
  }

  private zoneOf(id: string): Zone {
    return this.world.zones.find((z) => z.id === id)!;
  }

  // ------------------------------------------------------------------ display

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
    this.rebuildMarkers();
    this.onResize();
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.root.hidden = true;
    this.onClose?.();
  }

  /** Called from the game loop; only redraws while open. */
  update(playerX: number, playerZ: number, yaw: number): void {
    this.player = { x: playerX, z: playerZ, yaw };
    if (this.visible) this.draw();
  }

  private onResize = (): void => {
    if (!this.visible) return;
    const wrap = this.canvas.parentElement!;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (w <= 0 || h <= 0) return;

    const dpr = Math.min(devicePixelRatio, 2);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Fit the whole world, keeping tiles square and centring the leftover.
    this.scale = Math.min(w / this.spanX, h / this.spanZ);
    this.offX = (w - this.spanX * this.scale) / 2;
    this.offZ = (h - this.spanZ * this.scale) / 2;

    this.draw();
  };

  /** Grid tile -> canvas CSS pixels (low corner). */
  private toScreen(tx: number, tz: number) {
    return {
      x: this.offX + (tx - this.minX) * this.scale,
      y: this.offZ + (tz - this.minZ) * this.scale,
    };
  }

  /** Canvas CSS pixels -> grid tile. */
  private toTile(px: number, py: number) {
    return {
      tx: Math.floor((px - this.offX) / this.scale + this.minX),
      tz: Math.floor((py - this.offZ) / this.scale + this.minZ),
    };
  }

  private draw(): void {
    const ctx = this.ctx;
    const w = this.canvas.width / (this.ctx.getTransform().a || 1);
    const h = this.canvas.height / (this.ctx.getTransform().d || 1);
    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = '#0b0d13';
    ctx.fillRect(0, 0, w, h);

    // --- walkable tiles, tinted by their zone's floor colour ---
    const side = Math.max(1, this.scale);
    for (const key of this.walkable) {
      const [txs, tzs] = key.split(',');
      const tx = Number(txs);
      const tz = Number(tzs);
      const zone = this.zoneOfTile.get(key)!;
      const p = this.toScreen(tx, tz);
      ctx.fillStyle = tileColor(zone);
      ctx.fillRect(p.x, p.y, side + 0.5, side + 0.5);
    }

    // --- zone outlines and labels ---
    ctx.font = `${Math.max(9, Math.min(14, this.scale * 3))}px system-ui, sans-serif`;
    ctx.textBaseline = 'bottom';
    for (const z of this.world.zones) {
      const a = this.toScreen(z.originX, z.originZ);
      const b = this.toScreen(z.originX + z.w, z.originZ + z.h);
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = 1;
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);

      const tp = this.world.teleporters.find((t) => t.zoneId === z.id);
      ctx.fillStyle = 'rgba(255,255,255,0.65)';
      // The biome name is a debug label and this is the debug map, so both the
      // positional label and the internal name are useful here.
      ctx.fillText(`${tp?.label ?? z.id} · ${z.style.name}`, a.x + 2, a.y - 2);
    }

    // --- markers ---
    const r = Math.max(2.5, this.scale * 0.42);
    for (const mk of this.markers) {
      const p = this.toScreen(mk.x, mk.z);
      const cx = p.x + this.scale / 2;
      const cy = p.y + this.scale / 2;
      ctx.fillStyle = mk.color;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      if (mk.ring) {
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(cx, cy, r + 1.8, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // --- player arrow ---
    const ptx = this.player.x / TILE;
    const ptz = this.player.z / TILE;
    const pp = this.toScreen(ptx, ptz);
    ctx.save();
    ctx.translate(pp.x, pp.y);
    ctx.rotate(-this.player.yaw);
    const a = Math.max(5, this.scale * 0.9);
    ctx.fillStyle = '#ffe066';
    ctx.strokeStyle = '#1a1a1a';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(0, -a);
    ctx.lineTo(a * 0.72, a * 0.85);
    ctx.lineTo(0, a * 0.42);
    ctx.lineTo(-a * 0.72, a * 0.85);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // ---------------------------------------------------------------- pointer

  private eventTile(e: MouseEvent) {
    const rect = this.canvas.getBoundingClientRect();
    return this.toTile(e.clientX - rect.left, e.clientY - rect.top);
  }

  private onHover = (e: MouseEvent): void => {
    const { tx, tz } = this.eventTile(e);
    const key = `${tx},${tz}`;
    const zone = this.zoneOfTile.get(key);
    const near = this.markers.filter((m) => m.x === tx && m.z === tz);

    if (!zone) {
      this.canvas.style.cursor = 'default';
      this.infoEl.textContent = `(${tx}, ${tz}) — mur`;
      return;
    }
    this.canvas.style.cursor = 'pointer';
    const tp = this.world.teleporters.find((t) => t.zoneId === zone.id);
    const what = near.length ? ` — ${near.map((m) => m.label).join(' · ')}` : '';
    this.infoEl.textContent = `(${tx}, ${tz}) ${tp?.label ?? zone.id} · ${zone.style.name}${what}`;
  };

  private onClick = (e: MouseEvent): void => {
    const { tx, tz } = this.eventTile(e);
    if (!this.walkable.has(`${tx},${tz}`)) return;
    // Tile centre, in world units — same convention as `tileToWorld`.
    this.onTeleport?.(tx * TILE + TILE / 2, tz * TILE + TILE / 2);
    this.hide();
  };

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    this.root.remove();
  }
}

/** Floor colour of the zone, darkened so markers stay readable on top. */
function tileColor(zone: Zone): string {
  const c = zone.style.blocks.floor.color;
  const r = ((c >> 16) & 0xff) * 0.55 + 18;
  const g = ((c >> 8) & 0xff) * 0.55 + 18;
  const b = (c & 0xff) * 0.55 + 18;
  return `rgb(${r | 0}, ${g | 0}, ${b | 0})`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
