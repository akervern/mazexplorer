/**
 * Magic compass.
 *
 * Points at the nearest unresolved point of interest *in the current zone*:
 * an uncollected pickup, or a mechanism whose requirements are already met
 * (so it nudges you back to the thing you can now open).
 *
 * It gives direction only — never distance, never the path — and takes a
 * moment to settle after re-targeting, so it reads as a magic item rather
 * than a GPS.
 */

import type { Inventory } from '../core/inventory.js';
import type { Mechanism, World, Zone } from '../core/types.js';
import { MECHANISM_TYPES } from '../world/unlockMechanisms.js';
import { tileToWorld } from '../world/worldGen.js';

/** Seconds the needle wanders before locking on to a new target. */
const SETTLE_TIME = 1.6;

export interface CompassTarget {
  kind: 'pickup' | 'mechanism';
  uid: string;
  x: number;
  z: number;
}

export interface CompassReading {
  /** World-space bearing in radians, or null when nothing is targeted. */
  bearing: number | null;
  /** 0..1 — below 1 the needle is still searching. */
  confidence: number;
  label: string;
}

export class Compass {
  private target: CompassTarget | null = null;
  private settle = 0;
  private wobblePhase = 0;

  constructor(
    private readonly world: World,
    private readonly inventory: Inventory,
  ) {}

  /** Nearest unresolved point of interest inside `zone`. */
  private findTarget(zone: Zone, px: number, pz: number): CompassTarget | null {
    let best: CompassTarget | null = null;
    let bestD = Infinity;

    const consider = (kind: CompassTarget['kind'], uid: string, x: number, z: number) => {
      const d = (x - px) ** 2 + (z - pz) ** 2;
      if (d < bestD) {
        bestD = d;
        best = { kind, uid, x, z };
      }
    };

    for (const p of this.world.pickups) {
      if (p.taken || p.zoneId !== zone.id) continue;
      const w = tileToWorld(zone, p.tile);
      consider('pickup', p.uid, w.x, w.z);
    }

    // A locked mechanism you can already satisfy is worth pointing at.
    for (const m of this.world.mechanisms) {
      if (m.unlocked || m.zoneId !== zone.id) continue;
      if (!MECHANISM_TYPES[m.type].onCheck(this.inventory, m)) continue;
      const w = tileToWorld(zone, m.target.tile);
      consider('mechanism', m.uid, w.x, w.z);
    }

    return best;
  }

  /**
   * @param zone the zone the player currently stands in — the compass never
   *   reaches into biomes already left behind.
   */
  update(dt: number, zone: Zone, px: number, pz: number): CompassReading {
    if (!this.inventory.has('compass')) {
      return { bearing: null, confidence: 0, label: '' };
    }

    const found = this.findTarget(zone, px, pz);
    const changed = found?.uid !== this.target?.uid;
    if (changed) {
      this.target = found;
      this.settle = 0;
    }
    this.settle = Math.min(SETTLE_TIME, this.settle + dt);
    this.wobblePhase += dt * 7;

    if (!this.target) {
      return {
        bearing: null,
        confidence: 0,
        label: 'Rien à trouver ici',
      };
    }

    const confidence = this.settle / SETTLE_TIME;
    const trueBearing = Math.atan2(this.target.x - px, -(this.target.z - pz));
    // While settling, the needle sweeps around before homing in.
    const wobble = (1 - confidence) * Math.sin(this.wobblePhase) * Math.PI;

    return {
      bearing: trueBearing + wobble,
      confidence,
      label: confidence < 1 ? 'La boussole cherche…' : this.describe(this.target),
    };
  }

  private describe(t: CompassTarget): string {
    if (t.kind === 'pickup') return 'Objet à proximité';
    const m = this.world.mechanisms.find((mm) => mm.uid === t.uid) as Mechanism | undefined;
    return m ? `Prêt à ouvrir : ${MECHANISM_TYPES[m.type].label}` : 'Mécanisme';
  }
}
