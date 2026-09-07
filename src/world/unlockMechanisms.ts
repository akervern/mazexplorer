/**
 * Pluggable unlock-mechanism registry.
 *
 * Adding a new mechanism = adding one entry to MECHANISM_TYPES (and its id to
 * MechanismTypeId). Nothing in the maze generator, renderer, HUD or compass
 * needs to change: they all talk to a mechanism through MechanismType.
 */

import type { Rng } from '../core/rng.js';
import type {
  BlockingKind,
  InventoryLike,
  Mechanism,
  MechanismData,
  MechanismTypeId,
  UnlockResult,
  WorldMutator,
  Zone,
} from '../core/types.js';
import { itemName } from './items.js';

/** What a mechanism asks the generator to place. */
export interface MechanismPlan {
  requires: string[];
  consumesItem: boolean;
  target: { type: BlockingKind };
  /** Items to scatter inside the zone. Empty for cross-biome mechanisms. */
  items: { id: string; count: number }[];
  data?: MechanismData;
}

/** Generation-time services handed to `plan()`. */
export interface PlanContext {
  rng: Rng;
  zone: Zone;
  /** Reserve an unused item for a role ('key' | 'offering' | ...). */
  pickItem(role: ItemRole): string;
  /** Reserve a tool to be planted in an *earlier* biome; null if impossible. */
  pickCrossBiomeItem(): string | null;
}

export type ItemRole = 'key' | 'offering' | 'fragment' | 'tool' | 'trigger';

/**
 * What a mechanism asks of the player. The catalogue is meant to grow, so a
 * mechanism declares its family rather than being recognised by id: the dev
 * gallery groups by it, and it documents at a glance what a new entry adds
 * that the existing ones do not.
 *
 * It is *not* the same axis as the pools in `planProgression()`, which are
 * about a passage's role in the run (ordinary / deep / late transition). A
 * category may appear in several pools.
 */
export type MechanismCategory = 'fetch' | 'sacrifice' | 'collect' | 'traversal' | 'backtrack';

/** Display metadata for each category, in the order the gallery lists them. */
export const MECHANISM_CATEGORIES: Record<
  MechanismCategory,
  { label: string; blurb: string }
> = {
  fetch: {
    label: 'Trouver un objet',
    blurb: 'Un objet unique, caché dans la zone, ouvre le passage. La base du jeu.',
  },
  sacrifice: {
    label: 'Offrir un objet',
    blurb: "L'objet est consommé — il ne resservira pas ailleurs.",
  },
  collect: {
    label: 'Rassembler plusieurs objets',
    blurb: 'Plusieurs exemplaires dispersés : récompense la fouille complète de la zone.',
  },
  traversal: {
    label: 'Franchir un obstacle',
    blurb: 'Le terrain lui-même bloque ; le déblocage change la géométrie.',
  },
  backtrack: {
    label: 'Revenir sur ses pas',
    blurb: "L'objet vient d'un biome déjà traversé : il faut reprendre un téléporteur.",
  },
};

export interface MechanismType {
  id: MechanismTypeId;
  label: string;
  /** Family this mechanism belongs to — groups the dev gallery. */
  category: MechanismCategory;
  /** One line for the dev gallery: what the player actually has to do. */
  summary: string;
  /**
   * Whether the required item is eaten on unlock. `plan()` decides it per
   * instance; this is the same answer stated statically, so the gallery can
   * show it without fabricating a generation context.
   */
  consumes: boolean;
  /** Blocking geometry this mechanism puts in the corridor. */
  targetKind: BlockingKind;
  /** Relative pick weight inside its allowed pool. */
  weight: number;
  plan(ctx: PlanContext): MechanismPlan | null;
  hint(inst: Mechanism): string;
  onCheck(inv: InventoryLike, inst: Mechanism): boolean;
  onUnlock(world: WorldMutator, inst: Mechanism): UnlockResult;
  /** How many units to consume when `consumesItem` (default 1). */
  consumeCount?(inst: Mechanism): number;
}

function count(inv: InventoryLike, id: string): number {
  return inv.counts[id] ?? 0;
}

/** Comma-joined French list of required item names. */
function requiresText(requires: string[]): string {
  const names = requires.map(itemName);
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} et ${names[names.length - 1]}`;
}

export const MECHANISM_TYPES: Record<MechanismTypeId, MechanismType> = {
  /** 1. Key -> door. The classic, most-used beat. */
  key_door: {
    id: 'key_door',
    label: 'Porte verrouillée',
    category: 'fetch',
    summary:
      'Trouver la clé cachée dans la zone, puis toucher la porte.',
    consumes: false,
    targetKind: 'door',
    weight: 3,
    plan(ctx) {
      const key = ctx.pickItem('key');
      return {
        requires: [key],
        consumesItem: false,
        target: { type: 'door' },
        items: [{ id: key, count: 1 }],
      };
    },
    hint: (inst) => `Passage verrouillé. Il te faut : ${requiresText(inst.requires)}.`,
    onCheck: (inv, inst) => inst.requires.every((id) => count(inv, id) >= 1),
    onUnlock(world, inst) {
      world.clearBlocking(inst);
      return { message: 'La porte coulisse dans le mur.', effect: 'slide' };
    },
  },

  /** 2. Offering consumed on a pedestal. */
  pedestal_offering: {
    id: 'pedestal_offering',
    label: 'Socle rituel',
    category: 'sacrifice',
    summary:
      'Trouver l\'offrande et la déposer : elle disparaît de l\'inventaire.',
    consumes: true,
    targetKind: 'pedestal',
    weight: 3,
    plan(ctx) {
      const offering = ctx.pickItem('offering');
      return {
        requires: [offering],
        consumesItem: true,
        target: { type: 'pedestal' },
        items: [{ id: offering, count: 1 }],
      };
    },
    hint: (inst) =>
      `Un socle attend une offrande : ${requiresText(inst.requires)}. Elle sera consumée.`,
    onCheck: (inv, inst) => inst.requires.every((id) => count(inv, id) >= 1),
    onUnlock(world, inst) {
      world.clearBlocking(inst);
      return { message: "L'offrande se dissout, le passage s'ouvre.", effect: 'burst' };
    },
  },

  /** 3. Scattered fragment set — rewards full exploration. */
  fragment_set: {
    id: 'fragment_set',
    label: 'Sceau brisé',
    category: 'collect',
    summary:
      'Retrouver les 2 ou 3 fragments dispersés dans la zone.',
    consumes: true,
    targetKind: 'gate',
    weight: 1,
    plan(ctx) {
      const frag = ctx.pickItem('fragment');
      const n = ctx.rng.int(2, 3);
      return {
        requires: [frag],
        consumesItem: true,
        target: { type: 'gate' },
        items: [{ id: frag, count: n }],
        data: { needed: n },
      };
    },
    hint: (inst) =>
      `Sceau brisé : rassemble les ${inst.data.needed} « ${itemName(inst.requires[0])} » dispersés ici.`,
    onCheck: (inv, inst) => count(inv, inst.requires[0]) >= (inst.data.needed ?? 1),
    onUnlock(world, inst) {
      world.clearBlocking(inst);
      return { message: 'Les fragments se rejoignent — le sceau cède.', effect: 'burst' };
    },
    consumeCount: (inst) => inst.data.needed ?? 1,
  },

  /** 4. Tool breaks an obstacle on contact. */
  break_obstacle: {
    id: 'break_obstacle',
    label: 'Éboulis',
    category: 'traversal',
    summary:
      'Trouver l\'outil, puis briser l\'éboulis qui barre le couloir.',
    consumes: false,
    targetKind: 'rubble',
    weight: 3,
    plan(ctx) {
      const tool = ctx.pickItem('tool');
      return {
        requires: [tool],
        consumesItem: false,
        target: { type: 'rubble' },
        items: [{ id: tool, count: 1 }],
      };
    },
    hint: (inst) => `Un éboulis bloque la voie. Outil requis : ${requiresText(inst.requires)}.`,
    onCheck: (inv, inst) => inst.requires.every((id) => count(inv, id) >= 1),
    onUnlock(world, inst) {
      world.clearBlocking(inst);
      return { message: "L'obstacle vole en éclats.", effect: 'shatter' };
    },
  },

  /** 5. Bridge over a gap, laid down block by block. */
  activate_bridge: {
    id: 'activate_bridge',
    label: 'Passerelle',
    category: 'traversal',
    summary:
      'Trouver le déclencheur : une passerelle se construit au-dessus du vide.',
    consumes: false,
    targetKind: 'gap',
    weight: 2,
    plan(ctx) {
      const trigger = ctx.pickItem('trigger');
      return {
        requires: [trigger],
        consumesItem: false,
        target: { type: 'gap' },
        items: [{ id: trigger, count: 1 }],
      };
    },
    hint: (inst) =>
      `Le vide coupe le chemin. Pour bâtir la passerelle : ${requiresText(inst.requires)}.`,
    onCheck: (inv, inst) => inst.requires.every((id) => count(inv, id) >= 1),
    onUnlock(world, inst) {
      world.buildBridge(inst);
      return { message: 'Les dalles se posent une à une au-dessus du vide.', effect: 'bridge' };
    },
  },

  /** 6. Progressive threshold — N of M crystals, deliberate slack. */
  light_threshold: {
    id: 'light_threshold',
    label: 'Portail de lumière',
    category: 'collect',
    summary:
      'Récolter assez de cristaux parmi ceux cachés — il y a de la marge.',
    consumes: false,
    targetKind: 'gate',
    weight: 1,
    plan(ctx) {
      const total = ctx.rng.int(4, 5);
      const needed = Math.max(2, total - ctx.rng.int(1, 2));
      return {
        requires: ['light_crystal'],
        consumesItem: false,
        target: { type: 'gate' },
        items: [{ id: 'light_crystal', count: total }],
        data: { needed, total },
      };
    },
    hint: (inst) =>
      `Portail éteint : il s'ouvrira avec ${inst.data.needed} cristaux de lumière sur les ${inst.data.total} cachés ici.`,
    onCheck: (inv, inst) => count(inv, 'light_crystal') >= (inst.data.needed ?? 1),
    onUnlock(world, inst) {
      world.clearBlocking(inst);
      return { message: 'Le portail s’embrase et laisse passer.', effect: 'glow' };
    },
  },

  /**
   * 7. Cross-biome tool. The item comes from an *earlier* biome and is never
   * consumed, so the player walks back through a teleporter to fetch it.
   */
  cross_biome_tool: {
    id: 'cross_biome_tool',
    label: 'Obstacle ancien',
    category: 'backtrack',
    summary:
      'L\'outil est dans un biome précédent : repartir le chercher par un téléporteur.',
    consumes: false,
    targetKind: 'rubble',
    weight: 1,
    plan(ctx) {
      const tool = ctx.pickCrossBiomeItem();
      if (!tool) return null; // no earlier biome available — generator falls back
      return {
        requires: [tool],
        consumesItem: false,
        target: { type: 'rubble' },
        items: [], // planted elsewhere by the generator
        data: { crossBiome: true },
      };
    },
    hint: (inst) =>
      `Il te faut un objet d'un biome précédent : ${requiresText(inst.requires)}. Prends un téléporteur.`,
    onCheck: (inv, inst) => inst.requires.every((id) => count(inv, id) >= 1),
    onUnlock(world, inst) {
      world.clearBlocking(inst);
      return { message: "L'outil d'un autre lieu vient à bout de l'obstacle.", effect: 'shatter' };
    },
  },
};

/** All mechanism ids, stable order (registry iteration must stay seed-safe). */
export const MECHANISM_IDS = Object.keys(MECHANISM_TYPES) as MechanismTypeId[];

export function getMechanism(typeId: MechanismTypeId): MechanismType {
  const m = MECHANISM_TYPES[typeId];
  if (!m) throw new Error(`Unknown mechanism type: ${typeId}`);
  return m;
}

/**
 * Runtime evaluation of one mechanism instance.
 * Returns null when it cannot fire (already unlocked, or requirements unmet).
 */
export function tryUnlock(
  inst: Mechanism,
  inventory: InventoryLike,
  world: WorldMutator,
): UnlockResult | null {
  if (inst.unlocked) return null;
  const type = getMechanism(inst.type);
  if (!type.onCheck(inventory, inst)) return null;

  inst.unlocked = true;
  const result = type.onUnlock(world, inst);

  if (inst.consumesItem) {
    const n = type.consumeCount ? type.consumeCount(inst) : 1;
    for (const id of inst.requires) inventory.remove(id, n);
  }
  return { ...result, mechanism: inst };
}

/** Signpost text for a mechanism instance. */
export function mechanismHint(inst: Mechanism): string {
  return getMechanism(inst.type).hint(inst);
}

/** Weighted pick honouring the recommended balance mix. */
export function pickMechanismType(rng: Rng, allowed: MechanismTypeId[]): MechanismTypeId {
  const pool: MechanismTypeId[] = [];
  for (const id of allowed) {
    const t = MECHANISM_TYPES[id];
    for (let i = 0; i < t.weight; i++) pool.push(id);
  }
  return rng.pick(pool);
}
