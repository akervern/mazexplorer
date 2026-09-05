import type { ItemDef } from '../core/types.js';

/**
 * Item catalogue. Items are pure data; the generator picks which ones a biome
 * hands out, and mechanisms reference them by id.
 *
 * `icon` is an emoji used by the HUD inventory (no external assets).
 * `color` drives the floating voxel pickup in the world.
 */

export const ITEMS: Record<string, ItemDef> = {
  compass: {
    id: 'compass',
    name: 'Boussole magique',
    icon: '🧭',
    color: 0xd8b24a,
    global: true,
    desc: "Indique la direction du point d'intérêt non résolu le plus proche.",
  },

  // --- Keys (mechanism: key_door) ---
  ice_key: { id: 'ice_key', name: 'Clé de glace', icon: '🗝️', color: 0x9fd8f0, desc: 'Ouvre une porte gelée.' },
  sun_key: { id: 'sun_key', name: 'Clé solaire', icon: '🔑', color: 0xf0c860, desc: 'Ouvre une porte de grès.' },
  root_key: { id: 'root_key', name: 'Clé de racine', icon: '🗝️', color: 0x8fbf5a, desc: 'Ouvre une porte de bois vif.' },
  bone_key: { id: 'bone_key', name: 'Clé d’os', icon: '🔑', color: 0xe0dcc8, desc: 'Ouvre une porte scellée.' },

  // --- Pedestal offerings (mechanism: pedestal_offering, consumed) ---
  amber_orb: { id: 'amber_orb', name: 'Orbe d’ambre', icon: '🟠', color: 0xe8a33d, desc: 'À déposer sur un socle.' },
  jade_idol: { id: 'jade_idol', name: 'Idole de jade', icon: '🗿', color: 0x4fae86, desc: 'À déposer sur un socle.' },
  ash_urn: { id: 'ash_urn', name: 'Urne de cendres', icon: '⚱️', color: 0x9a8f88, desc: 'À déposer sur un socle.' },

  // --- Fragment sets (mechanism: fragment_set) ---
  seal_shard: { id: 'seal_shard', name: 'Éclat de sceau', icon: '🔷', color: 0x6fa8dc, stackable: true, desc: 'Un morceau d’un sceau brisé.' },
  tablet_piece: { id: 'tablet_piece', name: 'Fragment de tablette', icon: '🧩', color: 0xc9a227, stackable: true, desc: 'Un morceau d’une tablette gravée.' },

  // --- Tools (mechanism: break_obstacle / cross-biome) ---
  pickaxe: { id: 'pickaxe', name: 'Pioche de fer', icon: '⛏️', color: 0xb0b6c0, desc: 'Brise les éboulis de pierre.' },
  torch: { id: 'torch', name: 'Torche éternelle', icon: '🔥', color: 0xff8c2a, desc: 'Fait fondre les murs de glace.' },
  axe: { id: 'axe', name: 'Hache de bûcheron', icon: '🪓', color: 0x8a6a44, desc: 'Tranche les lianes les plus épaisses.' },

  // --- Bridge triggers (mechanism: activate_bridge) ---
  gear: { id: 'gear', name: 'Rouage ancien', icon: '⚙️', color: 0xa8926a, desc: 'Actionne un mécanisme de passerelle.' },
  lever_handle: { id: 'lever_handle', name: 'Manivelle', icon: '🎚️', color: 0x8c7b5e, desc: 'Complète un levier cassé.' },

  // --- Light crystals (mechanism: light_threshold) ---
  light_crystal: { id: 'light_crystal', name: 'Cristal de lumière', icon: '💎', color: 0x7fe8e0, stackable: true, desc: 'Sa lueur nourrit les portails anciens.' },
};

export function getItem(id: string): ItemDef {
  const it = ITEMS[id];
  if (!it) throw new Error(`Unknown item: ${id}`);
  return it;
}

export function itemName(id: string): string {
  return ITEMS[id]?.name ?? id;
}
