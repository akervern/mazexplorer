/** Shared domain types. */

export interface Tile {
  x: number;
  y: number;
}

export interface Vec2 {
  x: number;
  z: number;
}

export interface BlockStyle {
  tex: TextureName;
  color: number;
}

export type TextureName =
  | 'grass'
  | 'leaves'
  | 'wood'
  | 'sand'
  | 'sandstone'
  | 'snow'
  | 'ice'
  | 'gravel'
  | 'stone'
  | 'crystal'
  | 'mud'
  | 'vines'
  | 'tiles'
  | 'bricks'
  | 'gold'
  | 'door'
  | 'rubble'
  | 'pedestal'
  | 'gate';

export interface ZoneStyle {
  id: string;
  name: string;
  blurb?: string;
  sky: number;
  fog: { color: number; near: number; far: number };
  light: { sun: number; ambient: number; sunColor: number; ambientColor: number };
  blocks: { floor: BlockStyle; wall: BlockStyle; accent: BlockStyle };
  weather: 'snow' | null;
  mazeScale?: number;
}

export interface Maze {
  w: number;
  h: number;
  grid: Uint8Array;
  cols: number;
  rows: number;
}

/** Which side of a zone grid a portal is carved through. */
export type Side = 'north' | 'east' | 'south' | 'west';

/**
 * One outgoing passage from a zone toward a neighbour. A zone with two gates
 * offers a real choice of route: each is carved to its own side, gated by its
 * own mechanism, and reaches a different zone.
 */
export interface ZoneGate {
  /** Zone this passage leads to. */
  toZoneId: string;
  /** Tile inside this zone the passage leaves from. */
  tile: Tile;
  side: Side;
  /** Tile inside the destination zone the passage arrives at. */
  toTile: Tile;
  /** Uid of the mechanism guarding it, once progression is planned. */
  mechanismUid?: string;
  /** True when this passage only leads to an optional dead-end branch. */
  optional: boolean;
}

export interface Zone {
  id: string;
  index: number;
  biomeId: string;
  style: ZoneStyle;
  maze: Maze;
  w: number;
  h: number;
  originX: number;
  originZ: number;
  /** Depth in the biome graph: 0 for the starting zone. */
  rank: number;
  /** Where the player arrives from the previous zone (the start zone's spawn). */
  entry: Tile;
  /**
   * Where the player leaves toward each neighbour. Empty on a leaf: a dead-end
   * branch or the final zone, whose `exit` is the end of the run.
   */
  gates: ZoneGate[];
  /**
   * The tile the run ends on, for the final zone only. Kept for the renderer
   * and the dev map, which mark it.
   */
  exit: Tile;
  /** True when nothing depends on visiting this zone — a loot cul-de-sac. */
  optional: boolean;
  tiles: Tile[];
  deadEnds: Tile[];
  /** World-space walkable tiles joining this zone to its neighbours. */
  links: Vec2[];
}

export interface ItemDef {
  id: string;
  name: string;
  icon: string;
  color: number;
  desc: string;
  global?: boolean;
  stackable?: boolean;
}

export type MechanismTypeId =
  | 'key_door'
  | 'pedestal_offering'
  | 'fragment_set'
  | 'break_obstacle'
  | 'activate_bridge'
  | 'light_threshold'
  | 'cross_biome_tool';

export type BlockingKind = 'door' | 'pedestal' | 'rubble' | 'gap' | 'gate';

export interface MechanismTarget {
  type: BlockingKind;
  tile: Tile;
  zoneId: string;
  /** Extra tiles covered by the blocking geometry (rubble clusters, gaps). */
  tiles?: Tile[];
}

export interface MechanismData {
  needed?: number;
  total?: number;
  crossBiome?: boolean;
  sourceZoneId?: string;
}

export interface Mechanism {
  uid: string;
  type: MechanismTypeId;
  zoneId: string;
  /** Zone this mechanism's gate opens the way to, when it guards a passage. */
  toZoneId?: string;
  requires: string[];
  consumesItem: boolean;
  target: MechanismTarget;
  data: MechanismData;
  unlocked: boolean;
  isFinal: boolean;
}

export interface Pickup {
  uid: string;
  itemId: string;
  zoneId: string;
  tile: Tile;
  taken: boolean;
  forMechanism: string | null;
}

export interface Signpost {
  uid: string;
  zoneId: string;
  tile: Tile;
  title: string;
  lines: string[];
  mechanismUid?: string;
}

export interface Teleporter {
  uid: string;
  zoneId: string;
  tile: Tile;
  label: string;
  discovered: boolean;
}

export type SizeKey = 'small' | 'medium' | 'large';

export interface GameConfig {
  seed: string;
  size: SizeKey;
  biomeCount?: number;
  shadows?: boolean;
  /**
   * Dev bench only: force every passage to be guarded by this mechanism
   * instead of drawing one from the pool its role allows.
   *
   * Absent in every normal run — and the generator only consults it when it is
   * set — so an existing seed's world is untouched. See `src/dev/devGallery.ts`.
   */
  forceMechanism?: MechanismTypeId;
}

export interface World {
  seed: string;
  size: SizeKey;
  biomeCount: number;
  zones: Zone[];
  mechanisms: Mechanism[];
  pickups: Pickup[];
  signposts: Signpost[];
  teleporters: Teleporter[];
  grantedByZone: Map<string, string[]>;
  width: number;
  start: Tile;
  startZoneId: string;
  exit: { zoneId: string; tile: Tile };
}

/** What a mechanism's `onUnlock` reports back to the game layer. */
export interface UnlockResult {
  message: string;
  effect: 'slide' | 'burst' | 'shatter' | 'bridge' | 'glow';
  mechanism?: Mechanism;
}

/** The subset of the running world that mechanisms are allowed to touch. */
export interface WorldMutator {
  clearBlocking(inst: Mechanism): void;
  buildBridge(inst: Mechanism): void;
}

export interface InventoryLike {
  counts: Record<string, number>;
  has(id: string, n?: number): boolean;
  add(id: string, n?: number): void;
  remove(id: string, n?: number): void;
}

/**
 * World scale: how many voxels one maze tile spans.
 *
 * The maze grid is logical (1 cell = 1 tile); the rendered world multiplies it
 * so corridors are comfortable to walk. At 1 the player (radius 0.32) had only
 * 0.18 of clearance per side and scraped the walls constantly; 2 was still
 * cramped. At 3 a corridor is 3 wide against 3 of wall height — a square
 * cross-section, which reads as a proper passage rather than a slot.
 *
 * Everything derived from it (interaction ranges, fog, camera planes, shadow
 * frustum, minimap span) scales automatically — see the notes at each site.
 */
export const TILE = 3;
