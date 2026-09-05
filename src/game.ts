/**
 * Game orchestration: scene setup, per-biome ambience, interaction handling,
 * mechanism resolution and the main loop.
 */

import * as THREE from 'three';
import { Inventory } from './core/inventory.js';
import { saveProgress, loadProgress } from './core/save.js';
import type {
  GameConfig,
  Mechanism,
  Tile,
  World,
  WorldMutator,
  Zone,
  ZoneStyle,
} from './core/types.js';
import { Compass } from './player/compass.js';
import { PlayerController, EYE_HEIGHT } from './player/controller.js';
import { InputManager, KeyboardMouseInput, type GameAction } from './player/input.js';
import { buildEntities, spawnBurst, type EntityViews } from './render/entities.js';
import {
  buildWorld,
  clearBlocker,
  placeBridgeTile,
  type BuiltWorld,
} from './render/voxelWorld.js';
import { Hud } from './ui/hud.js';
import { Minimap } from './ui/minimap.js';
import { ITEMS } from './world/items.js';
import { MECHANISM_TYPES, tryUnlock } from './world/unlockMechanisms.js';
import { TILE } from './core/types.js';
import { generateWorld, tileToWorld, zoneAtWorldX } from './world/worldGen.js';

// Interaction distances scale with the world: a tile is TILE units across, so
// these stay the same *in tiles* regardless of the voxel scale.
const INTERACT_RANGE = 1.6 * TILE;
const PICKUP_RANGE = 0.9 * TILE;
const AMBIENCE_BLEND = 2.2; // seconds to cross-fade between biome moods

export interface GameHooks {
  onFinish(seconds: number): void;
  onPause(): void;
}

export class Game {
  readonly world: World;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly built: BuiltWorld;
  private readonly entities: EntityViews;
  private readonly inventory = new Inventory();
  private readonly player: PlayerController;
  private readonly input = new InputManager();
  private readonly keyboard: KeyboardMouseInput;
  private readonly hud: Hud;
  private readonly minimap: Minimap;
  private readonly compass: Compass;
  private readonly mutator: WorldMutator;

  private readonly sun: THREE.DirectionalLight;
  private readonly ambient: THREE.HemisphereLight;
  private readonly fog: THREE.Fog;

  private currentZone: Zone;
  private targetStyle: ZoneStyle;
  private blendT = 1;
  private fromStyle: ZoneStyle;

  private effects: ((dt: number) => boolean)[] = [];
  private bridgeQueue: { zone: Zone; tiles: Tile[]; timer: number }[] = [];
  private snow: THREE.Points | null = null;

  private elapsed = 0;
  private running = false;
  private finished = false;
  private clock = new THREE.Clock();
  private saveTimer = 0;
  private raf = 0;

  constructor(
    private readonly container: HTMLElement,
    readonly config: GameConfig,
    private readonly hooks: GameHooks,
  ) {
    this.world = generateWorld(config);

    // --- renderer ---
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.shadowMap.enabled = config.shadows ?? true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.className = 'game-canvas';
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(
      74,
      container.clientWidth / container.clientHeight,
      0.1,
      // Beyond the farthest biome fog (120), so nothing pops at the fog wall.
      160,
    );

    // --- world geometry ---
    this.built = buildWorld(this.world, { shadows: config.shadows ?? true });
    this.scene.add(this.built.group);
    this.entities = buildEntities(this.world);
    this.scene.add(this.entities.group);

    // --- lighting & ambience ---
    const startZone = this.world.zones.find((z) => z.id === this.world.startZoneId)!;
    this.currentZone = startZone;
    this.fromStyle = startZone.style;
    this.targetStyle = startZone.style;

    this.fog = new THREE.Fog(startZone.style.fog.color, startZone.style.fog.near, startZone.style.fog.far);
    this.scene.fog = this.fog;
    this.scene.background = new THREE.Color(startZone.style.sky);

    this.ambient = new THREE.HemisphereLight(
      startZone.style.light.ambientColor,
      0x2a2a30,
      startZone.style.light.ambient,
    );
    this.scene.add(this.ambient);

    this.sun = new THREE.DirectionalLight(
      startZone.style.light.sunColor,
      startZone.style.light.sun,
    );
    this.sun.position.set(30, 60, 20);
    this.sun.castShadow = config.shadows ?? true;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 200;
    const d = 30 * TILE;
    this.sun.shadow.camera.left = -d;
    this.sun.shadow.camera.right = d;
    this.sun.shadow.camera.top = d;
    this.sun.shadow.camera.bottom = -d;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // --- player ---
    this.player = new PlayerController(
      this.built.solid,
      this.input,
      { ...tileToWorld(startZone, this.world.start), y: 0 },
    );
    this.keyboard = new KeyboardMouseInput(this.renderer.domElement);
    this.input.add(this.keyboard);

    // --- UI ---
    this.hud = new Hud(container);
    this.minimap = new Minimap(this.world, this.hud.createMinimapContainer());
    this.compass = new Compass(this.world, this.inventory);
    this.hud.renderInventory(this.inventory);
    this.hud.setZoneName(this.zoneLabel(startZone));
    this.hud.onTeleport = (uid) => this.teleportTo(uid);

    this.mutator = {
      clearBlocking: (inst) => {
        const zone = this.zoneOf(inst.zoneId);
        clearBlocker(this.built, inst, zone);
      },
      buildBridge: (inst) => {
        const zone = this.zoneOf(inst.zoneId);
        // Lay a slab for every tile the chasm covers, one at a time.
        const tiles = inst.target.tiles ?? [inst.target.tile];
        this.bridgeQueue.push({ zone, tiles: [...tiles], timer: 0 });
      },
    };

    this.inventory.onChange(() => {
      this.hud.renderInventory(this.inventory);
      this.checkNearbyMechanisms();
    });

    window.addEventListener('resize', this.onResize);
    this.applyWeather(startZone.style);
  }

  /** Whether pointer lock has ever been granted for this game. */
  get hasHadPointerLock(): boolean {
    return this.keyboard.everLocked;
  }


  /**
   * What the HUD calls a zone. Biome names are deliberately never shown — the
   * mood on screen is the reveal — so a zone reads as its teleporter's
   * positional label ("Secteur 2").
   */
  private zoneLabel(zone: Zone): string {
    return this.world.teleporters.find((t) => t.zoneId === zone.id)?.label ?? 'Secteur';
  }

  private zoneOf(id: string): Zone {
    return this.world.zones.find((z) => z.id === id)!;
  }

  // ---------------------------------------------------------------- lifecycle

  start(): void {
    this.running = true;
    this.clock.start();
    this.keyboard.requestLock();
    this.loop();
  }

  pause(): void {
    this.running = false;
    this.keyboard.releaseLock();
    this.persist();
  }

  resume(): void {
    if (this.finished) return;
    this.running = true;
    this.clock.getDelta(); // discard the paused span
    this.keyboard.requestLock();
    this.loop();
  }

  /** Restore a previous run of the *same* seed. */
  restore(): void {
    const saved = loadProgress();
    if (!saved || saved.config.seed !== this.config.seed) return;

    this.elapsed = saved.elapsed;
    for (const [id, n] of Object.entries(saved.inventory)) this.inventory.add(id, n);

    for (const uid of saved.taken) {
      const p = this.world.pickups.find((pp) => pp.uid === uid);
      if (p) {
        p.taken = true;
        this.entities.pickups.get(uid)?.removeFromParent();
      }
    }
    for (const uid of saved.unlocked) {
      const m = this.world.mechanisms.find((mm) => mm.uid === uid);
      if (!m || m.unlocked) continue;
      m.unlocked = true;
      const zone = this.zoneOf(m.zoneId);
      if (m.target.type === 'gap') {
        // Re-lay the bridge instantly: a restored chasm must stay crossable.
        for (const t of m.target.tiles ?? [m.target.tile]) {
          placeBridgeTile(this.built, zone, t, this.config.shadows ?? true);
        }
      } else {
        clearBlocker(this.built, m, zone);
      }
    }
    for (const uid of saved.discovered) {
      const t = this.world.teleporters.find((tt) => tt.uid === uid);
      if (t) t.discovered = true;
    }
    this.minimap.restore(saved.revealed);
    this.player.teleportTo(saved.position.x, saved.position.y, saved.position.z);
    this.player.state.yaw = saved.yaw;
  }

  private persist(): void {
    const p = this.player.state.position;
    saveProgress({
      config: this.config,
      elapsed: this.elapsed,
      inventory: this.inventory.toJSON(),
      unlocked: this.world.mechanisms.filter((m) => m.unlocked).map((m) => m.uid),
      taken: this.world.pickups.filter((pp) => pp.taken).map((pp) => pp.uid),
      discovered: this.world.teleporters.filter((t) => t.discovered).map((t) => t.uid),
      revealed: this.minimap.toJSON(),
      position: { x: p.x, y: p.y, z: p.z },
      yaw: this.player.state.yaw,
      savedAt: Date.now(),
    });
  }

  private loop = (): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.loop);

    const dt = Math.min(0.05, this.clock.getDelta());
    this.elapsed += dt;
    this.update(dt);

    const pos = this.player.state.position;
    this.minimap.update(pos.x, pos.z, this.player.state.yaw);

    this.renderer.render(this.scene, this.camera);
    // Second pass into the minimap's screen box, same renderer so it sees the
    // same meshes (a separate WebGL context could not).
    this.minimap.render(this.renderer, this.scene);
  };

  // ------------------------------------------------------------------- update

  private update(dt: number): void {
    this.handleActions(this.input.drainActions());

    if (!this.hud.popupOpen) this.player.update(dt);
    this.player.applyToCamera(this.camera);

    const pos = this.player.state.position;
    this.sun.position.set(pos.x + 30, 60, pos.z + 20);
    this.sun.target.position.set(pos.x, 0, pos.z);
    this.sun.target.updateMatrixWorld();

    this.updateZone(pos.x);
    this.blendAmbience(dt);
    this.entities.update(this.elapsed);
    this.updateSnow(dt);
    this.tickBridges(dt);

    this.effects = this.effects.filter((fn) => fn(dt));

    this.collectNearbyPickups();
    this.updatePrompt();

    const reading = this.compass.update(dt, this.currentZone, pos.x, pos.z);
    this.hud.updateCompass(reading, this.player.state.yaw);

    this.hud.setTime(this.elapsed);
    this.hud.setPointerLockHint(!this.keyboard.isActive && !this.hud.popupOpen);
    this.hud.update(dt);

    this.checkFinish();

    this.saveTimer += dt;
    if (this.saveTimer > 8) {
      this.saveTimer = 0;
      this.persist();
    }
  }

  private handleActions(actions: GameAction[]): void {
    for (const a of actions) {
      switch (a) {
        case 'jump':
          if (!this.hud.popupOpen) this.player.jump();
          break;
        case 'interact':
          if (this.hud.popupOpen) this.hud.closePopup();
          else this.interact();
          break;
        case 'pause':
          if (this.hud.popupOpen) this.hud.closePopup();
          else {
            this.pause();
            this.hooks.onPause();
          }
          break;
        case 'inventory':
        case 'map':
          // Reserved: the HUD already shows both permanently.
          break;
      }
    }
  }

  /** Track which zone the player stands in, for ambience and the compass. */
  private updateZone(x: number): void {
    const zone = zoneAtWorldX(this.world, x);
    if (zone.id === this.currentZone.id) return;

    this.currentZone = zone;
    this.fromStyle = this.targetStyle;
    this.targetStyle = zone.style;
    this.blendT = 0;
    this.hud.setZoneName(this.zoneLabel(zone));
    this.applyWeather(zone.style);

    // Arriving in a biome reveals its teleporter.
    const tp = this.world.teleporters.find((t) => t.zoneId === zone.id);
    if (tp && !tp.discovered) {
      tp.discovered = true;
      this.hud.toast(`Téléporteur découvert : ${tp.label}`);
    }
  }

  /** Cross-fade sky, fog and light between biome moods. */
  private blendAmbience(dt: number): void {
    if (this.blendT >= 1) return;
    this.blendT = Math.min(1, this.blendT + dt / AMBIENCE_BLEND);
    const t = this.blendT * this.blendT * (3 - 2 * this.blendT); // smoothstep
    const a = this.fromStyle;
    const b = this.targetStyle;

    const sky = new THREE.Color(a.sky).lerp(new THREE.Color(b.sky), t);
    (this.scene.background as THREE.Color).copy(sky);
    this.fog.color.copy(new THREE.Color(a.fog.color).lerp(new THREE.Color(b.fog.color), t));
    this.fog.near = a.fog.near + (b.fog.near - a.fog.near) * t;
    this.fog.far = a.fog.far + (b.fog.far - a.fog.far) * t;

    this.sun.intensity = a.light.sun + (b.light.sun - a.light.sun) * t;
    this.sun.color.copy(new THREE.Color(a.light.sunColor).lerp(new THREE.Color(b.light.sunColor), t));
    this.ambient.intensity = a.light.ambient + (b.light.ambient - a.light.ambient) * t;
    this.ambient.color.copy(
      new THREE.Color(a.light.ambientColor).lerp(new THREE.Color(b.light.ambientColor), t),
    );
  }

  // -------------------------------------------------------------- interaction

  /** Items are picked up by walking over them. */
  private collectNearbyPickups(): void {
    const pos = this.player.state.position;
    for (const p of this.world.pickups) {
      if (p.taken) continue;
      const zone = this.zoneOf(p.zoneId);
      const w = tileToWorld(zone, p.tile);
      const dx = w.x - pos.x;
      const dz = w.z - pos.z;
      if (dx * dx + dz * dz > PICKUP_RANGE * PICKUP_RANGE) continue;

      p.taken = true;
      const obj = this.entities.pickups.get(p.uid);
      if (obj) {
        this.effects.push(
          spawnBurst(this.scene, obj.position.clone(), ITEMS[p.itemId]?.color ?? 0xffffff, 14),
        );
        obj.removeFromParent();
      }
      this.inventory.add(p.itemId);
      const item = ITEMS[p.itemId];
      this.hud.toast(`${item?.icon ?? ''} ${item?.name ?? p.itemId} ramassé`);
    }
  }

  /** What is in front of the player right now, if anything. */
  private nearestInteractable():
    | { kind: 'sign'; uid: string }
    | { kind: 'teleporter'; uid: string }
    | { kind: 'mechanism'; mech: Mechanism }
    | null {
    const pos = this.player.state.position;
    let best: ReturnType<Game['nearestInteractable']> = null;
    let bestD = INTERACT_RANGE * INTERACT_RANGE;

    const test = (x: number, z: number, make: () => NonNullable<typeof best>) => {
      const dx = x - pos.x;
      const dz = z - pos.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = make();
      }
    };

    for (const s of this.world.signposts) {
      const zone = this.zoneOf(s.zoneId);
      const w = tileToWorld(zone, s.tile);
      test(w.x, w.z, () => ({ kind: 'sign', uid: s.uid }));
    }
    for (const t of this.world.teleporters) {
      if (!t.discovered) continue;
      const zone = this.zoneOf(t.zoneId);
      const w = tileToWorld(zone, t.tile);
      test(w.x, w.z, () => ({ kind: 'teleporter', uid: t.uid }));
    }
    for (const m of this.world.mechanisms) {
      if (m.unlocked) continue;
      const zone = this.zoneOf(m.zoneId);
      const w = tileToWorld(zone, m.target.tile);
      test(w.x, w.z, () => ({ kind: 'mechanism', mech: m }));
    }
    return best;
  }

  private updatePrompt(): void {
    if (this.hud.popupOpen) {
      this.hud.setPrompt(null);
      return;
    }
    const target = this.nearestInteractable();
    if (!target) {
      this.hud.setPrompt(null);
      return;
    }
    switch (target.kind) {
      case 'sign':
        this.hud.setPrompt('[E] Lire le panneau');
        break;
      case 'teleporter':
        this.hud.setPrompt('[E] Utiliser le téléporteur');
        break;
      case 'mechanism': {
        const ok = MECHANISM_TYPES[target.mech.type].onCheck(this.inventory, target.mech);
        this.hud.setPrompt(ok ? '[E] Débloquer le passage' : '[E] Examiner le passage');
        break;
      }
    }
  }

  private interact(): void {
    const target = this.nearestInteractable();
    if (!target) return;

    if (target.kind === 'sign') {
      const s = this.world.signposts.find((ss) => ss.uid === target.uid)!;
      this.hud.showPopup(s.title, s.lines);
      return;
    }

    if (target.kind === 'teleporter') {
      const options = this.world.teleporters
        .filter((t) => t.discovered)
        .map((t) => ({ uid: t.uid, label: t.label, zoneId: t.zoneId }));
      this.hud.showTeleportMenu(options, this.currentZone.id);
      return;
    }

    // A mechanism: try it, or explain what is missing.
    const mech = target.mech;
    const result = tryUnlock(mech, this.inventory, this.mutator);
    if (result) {
      this.onUnlocked(mech, result.message);
    } else {
      this.hud.showPopup('Passage bloqué', [MECHANISM_TYPES[mech.type].hint(mech)]);
    }
  }

  /** Re-check every nearby mechanism whenever the inventory changes. */
  private checkNearbyMechanisms(): void {
    const pos = this.player.state.position;
    for (const m of this.world.mechanisms) {
      if (m.unlocked) continue;
      const zone = this.zoneOf(m.zoneId);
      const w = tileToWorld(zone, m.target.tile);
      const dx = w.x - pos.x;
      const dz = w.z - pos.z;
      if (dx * dx + dz * dz > INTERACT_RANGE * INTERACT_RANGE) continue;

      const result = tryUnlock(m, this.inventory, this.mutator);
      if (result) this.onUnlocked(m, result.message);
    }
  }

  private onUnlocked(mech: Mechanism, message: string): void {
    const zone = this.zoneOf(mech.zoneId);
    const mw = tileToWorld(zone, mech.target.tile);
    const at = new THREE.Vector3(mw.x, 1, mw.z);
    this.effects.push(spawnBurst(this.scene, at, 0xffe9a8, 22));
    this.hud.toast(message, 4);
    this.persist();
  }

  private teleportTo(uid: string): void {
    const tp = this.world.teleporters.find((t) => t.uid === uid);
    if (!tp) return;
    const zone = this.zoneOf(tp.zoneId);
    const tw = tileToWorld(zone, tp.tile);
    this.player.teleportTo(tw.x, 0, tw.z);
    this.currentZone = zone;
    this.fromStyle = this.targetStyle;
    this.targetStyle = zone.style;
    this.blendT = 0;
    this.hud.setZoneName(this.zoneLabel(zone));
    this.applyWeather(zone.style);
    this.hud.toast(`Téléporté : ${tp.label}`);
    this.keyboard.requestLock();
  }

  /** Lay bridge slabs one at a time for a small sense of ceremony. */
  private tickBridges(dt: number): void {
    for (const b of this.bridgeQueue) {
      b.timer -= dt;
      if (b.timer > 0 || !b.tiles.length) continue;
      const tile = b.tiles.shift()!;
      placeBridgeTile(this.built, b.zone, tile, this.config.shadows ?? true);
      b.timer = 0.16;
    }
    this.bridgeQueue = this.bridgeQueue.filter((b) => b.tiles.length);
  }

  // ------------------------------------------------------------------ weather

  private applyWeather(style: ZoneStyle): void {
    if (style.weather === 'snow' && !this.snow) {
      const count = 900;
      const pos = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        pos[i * 3] = (Math.random() - 0.5) * 60;
        pos[i * 3 + 1] = Math.random() * 26;
        pos[i * 3 + 2] = (Math.random() - 0.5) * 60;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const mat = new THREE.PointsMaterial({
        color: 0xffffff,
        size: 0.16,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
      });
      this.snow = new THREE.Points(geo, mat);
      this.snow.frustumCulled = false;
      this.scene.add(this.snow);
    } else if (style.weather !== 'snow' && this.snow) {
      this.snow.geometry.dispose();
      (this.snow.material as THREE.Material).dispose();
      this.snow.removeFromParent();
      this.snow = null;
    }
  }

  private updateSnow(dt: number): void {
    if (!this.snow) return;
    const pos = this.player.state.position;
    this.snow.position.set(pos.x, 0, pos.z);
    const arr = this.snow.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < arr.count; i++) {
      let y = arr.getY(i) - dt * 2.4;
      if (y < 0) y += 26;
      arr.setY(i, y);
    }
    arr.needsUpdate = true;
  }

  // ------------------------------------------------------------------- ending

  private checkFinish(): void {
    if (this.finished) return;
    const lastZone = this.zoneOf(this.world.exit.zoneId);
    const finalMech = this.world.mechanisms.find((m) => m.isFinal);
    if (finalMech && !finalMech.unlocked) return;

    const pos = this.player.state.position;
    const ew = tileToWorld(lastZone, this.world.exit.tile);
    const ex = ew.x;
    const ez = ew.z;
    if ((ex - pos.x) ** 2 + (ez - pos.z) ** 2 > 2.2 * 2.2) return;

    this.finished = true;
    this.running = false;
    this.keyboard.releaseLock();
    this.hooks.onFinish(this.elapsed);
  }

  // -------------------------------------------------------------------- misc

  private onResize = (): void => {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.minimap.resize(Math.min(220, Math.max(120, Math.min(w, h) * 0.22)));
  };

  dispose(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    this.input.dispose();
    this.minimap.dispose();
    this.hud.dispose();
    this.entities.dispose();
    this.built.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

export { EYE_HEIGHT };
