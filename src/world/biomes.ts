import type { ZoneStyle } from '../core/types.js';

/**
 * Biome definitions: palette, ambience, maze tuning.
 * Colors are flat RGB — the renderer shades faces per-normal to fake
 * Minecraft-style lighting, and textures are generated on a 2D canvas.
 *
 * BIOME_POOL is the set the world graph draws from. Every biome — including the
 * one the run starts in — is picked by the seed, so two seeds rarely open on
 * the same mood.
 */

export const BIOMES: Record<string, ZoneStyle> = {
  forest: {
    id: 'forest',
    name: 'Forêt',
    blurb: 'Une futaie dense, tapis de mousse et troncs serrés.',
    sky: 0x8fc7e8,
    fog: { color: 0xa9d3ea, near: 28, far: 92 },
    light: { sun: 0.95, ambient: 0.55, sunColor: 0xfff3d0, ambientColor: 0xa8c8e0 },
    blocks: {
      floor: { tex: 'grass', color: 0x6aa84f },
      wall: { tex: 'leaves', color: 0x3d6b2e },
      accent: { tex: 'wood', color: 0x7a5230 },
    },
    weather: null,
    mazeScale: 1.0,
  },

  desert: {
    id: 'desert',
    name: 'Désert',
    blurb: 'Des dunes brûlantes et des murs de grès taillé.',
    sky: 0xe8c98a,
    fog: { color: 0xe3c489, near: 36, far: 120 },
    light: { sun: 1.15, ambient: 0.62, sunColor: 0xfff0c4, ambientColor: 0xe0cfa0 },
    blocks: {
      floor: { tex: 'sand', color: 0xd9c188 },
      wall: { tex: 'sandstone', color: 0xc2a066 },
      accent: { tex: 'sandstone', color: 0xb08d5a },
    },
    weather: null,
    mazeScale: 1.15,
  },

  snow: {
    id: 'snow',
    name: 'Neige',
    blurb: 'Un dédale de glace où la neige ne cesse jamais de tomber.',
    sky: 0xbcd4e6,
    fog: { color: 0xcfe0ec, near: 20, far: 68 },
    light: { sun: 0.8, ambient: 0.7, sunColor: 0xeaf4ff, ambientColor: 0xc4d8ea },
    blocks: {
      floor: { tex: 'snow', color: 0xeef4f8 },
      wall: { tex: 'ice', color: 0x9dc4dc },
      accent: { tex: 'ice', color: 0x7fb0cf },
    },
    weather: 'snow',
    mazeScale: 1.05,
  },

  cave: {
    id: 'cave',
    name: 'Grotte',
    blurb: 'Des galeries humides éclairées par des veines luminescentes.',
    sky: 0x14161f,
    fog: { color: 0x14161f, near: 12, far: 48 },
    light: { sun: 0.34, ambient: 0.36, sunColor: 0x9fb4d8, ambientColor: 0x4a5570 },
    blocks: {
      floor: { tex: 'gravel', color: 0x5a5a62 },
      wall: { tex: 'stone', color: 0x4a4a52 },
      accent: { tex: 'crystal', color: 0x6fd8e0 },
    },
    weather: null,
    mazeScale: 0.95,
  },

  swamp: {
    id: 'swamp',
    name: 'Marais',
    blurb: 'De la boue, des lianes, et une eau qui ne reflète rien.',
    sky: 0x6d7a52,
    fog: { color: 0x63704a, near: 16, far: 60 },
    light: { sun: 0.62, ambient: 0.48, sunColor: 0xd8e0a8, ambientColor: 0x66784e },
    blocks: {
      floor: { tex: 'mud', color: 0x5c4a32 },
      wall: { tex: 'vines', color: 0x3f5a2c },
      accent: { tex: 'wood', color: 0x4a3b26 },
    },
    weather: null,
    mazeScale: 1.1,
  },

  ruins: {
    id: 'ruins',
    name: 'Ruines',
    blurb: 'Un temple effondré dont les dalles gardent encore des marques.',
    sky: 0xc8a882,
    fog: { color: 0xbfa079, near: 24, far: 80 },
    light: { sun: 0.88, ambient: 0.52, sunColor: 0xffe8c0, ambientColor: 0xb49a7a },
    blocks: {
      floor: { tex: 'tiles', color: 0x9a8d78 },
      wall: { tex: 'bricks', color: 0x7d7161 },
      accent: { tex: 'gold', color: 0xc9a227 },
    },
    weather: null,
    mazeScale: 1.2,
  },
};

/**
 * Every biome the world graph can use, entry included — the order is shuffled
 * per seed in `generateWorld`.
 */
export const BIOME_POOL: string[] = ['forest', 'desert', 'snow', 'cave', 'swamp', 'ruins'];

