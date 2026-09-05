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

export type ZoneKind = 'biome' | 'corridor';

export interface Zone {
  id: string;
  kind: ZoneKind;
  index: number;
  biomeId: string;
  style: ZoneStyle;
  maze: Maze;
  w: number;
  h: number;
  originX: number;
  originZ: number;
  entry: Tile;
  exit: Tile;
  tiles: Tile[];
  deadEnds: Tile[];
  /** World-space walkable tiles joining this zone's exit to the next zone. */
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
}

export interface World {
  seed: string;
  size: SizeKey;
  biomeCount: number;
  zones: Zone[];
  biomeZones: Zone[];
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
