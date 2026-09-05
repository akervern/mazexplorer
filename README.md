# Mazexplorer

Un jeu de labyrinthe voxel à la première personne, en **TypeScript + Three.js**.
Tout le monde (biomes, labyrinthes, objets, panneaux, téléporteurs) est généré
procéduralement à partir d'une **graine** : même graine + mêmes réglages =
monde strictement identique.

Pas d'ennemis, pas de mort — la difficulté vient du level design.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # invariants de génération
npm run build      # bundle de production
```

## Contrôles

| Action | Touche |
| --- | --- |
| Se déplacer | `ZQSD` / `WASD` / flèches |
| Regarder | Souris (pointer lock) |
| Courir | `Maj` |
| Sauter | `Espace` |
| Interagir (panneau, téléporteur, passage) | `E` / `Entrée` |
| Pause | `Échap` |

## Architecture

```
src/
  core/       rng (mulberry32 seedable), types, inventaire, sauvegarde
  world/      maze (backtracker), biomes, items, worldGen, unlockMechanisms
  render/     textures (canvas 2D), voxelWorld (InstancedMesh), entities
  player/     input (abstrait), controller (collisions AABB), compass
  ui/         menu, hud, minimap (caméra ortho + fog of war)
  game.ts     orchestration : scène, ambiance par biome, boucle de jeu
```

### Génération

Chaque étape tire sur un flux dérivé (`rng.fork('tag')`), donc **ajouter une
étape de génération quelque part ne décale pas le reste du monde**. Les zones
(biomes et corridors) sont posées côte à côte sur l'axe X et reliées par des
tuiles de liaison en L.

Trois invariants sont vérifiés par `npm test` sur 18 mondes :

1. le monde est un seul espace connexe ;
2. chaque verrou est un **vrai point de passage obligé** (le retirer déconnecte
   la sortie) — impossible de contourner la progression ;
3. chaque partie est **finissable** : le loot d'un verrou est toujours
   atteignable *sans* franchir ce verrou.

Le point 3 est la contrainte subtile : sans elle, la clé peut apparaître
derrière sa propre porte.

## Ajouter un mécanisme de déblocage

C'est le point d'extension principal. Un mécanisme est **une seule entrée** dans
`src/world/unlockMechanisms.ts` — rien d'autre à toucher : ni la génération de
labyrinthe, ni le rendu, ni l'UI, ni les panneaux (qui lisent `requires` tout
seuls pour écrire leur indice).

```ts
// 1. ajouter l'id dans MechanismTypeId (src/core/types.ts)
// 2. ajouter l'entrée :
mon_mecanisme: {
  id: 'mon_mecanisme',
  label: 'Serrure runique',
  weight: 2,                       // poids de tirage dans son pool

  plan(ctx) {                      // génération : quoi bloquer, quoi disperser
    const item = ctx.pickItem('key');
    return {
      requires: [item],
      consumesItem: false,
      target: { type: 'door' },    // door | pedestal | rubble | gap | gate
      items: [{ id: item, count: 1 }],
    };
  },

  hint: (inst) => `Il te faut : ${itemName(inst.requires[0])}.`,
  onCheck: (inv, inst) => inst.requires.every((id) => inv.counts[id] >= 1),
  onUnlock(world, inst) {
    world.clearBlocking(inst);     // ou world.buildBridge(inst)
    return { message: 'La serrure cède.', effect: 'burst' };
  },
},
```

Puis l'autoriser dans un pool de `planProgression` (`worldGen.ts`) selon
l'intention : lisible et fréquent, ou réservé à l'exploration poussée.

Les 7 mécanismes de la V1 : `key_door`, `pedestal_offering`, `fragment_set`,
`break_obstacle`, `activate_bridge`, `light_threshold`, `cross_biome_tool`.
L'équilibrage suit le brief — 1/2/4 majoritaires, 3/6 sur un ou deux biomes,
7 sur une transition clé (aller-retour volontaire via téléporteur).

## Portabilité mobile

Choix pris dès la V1 pour ne pas bloquer un portage PWA/Capacitor :

- **Entrées abstraites** — `InputManager` expose `getMoveVector()` /
  `getLookDelta()` / `drainActions()`. Brancher un joystick tactile = ajouter
  une `InputSource`, sans toucher au contrôleur ni au jeu.
- **Pointer Lock optionnel** — c'est une source d'entrée parmi d'autres, pas une
  dépendance du moteur.
- **UI en unités relatives** (`vmin`, `%`, `rem`) — la minimap, l'inventaire et
  les popups restent lisibles sur petit écran.
- **Perfs** — voxels en `InstancedMesh` groupés par (texture, teinte), jamais un
  mesh par bloc ; deux lumières seulement ; ombres désactivables au menu.
- **Zéro asset externe** — textures générées en canvas 2D, géométrie procédurale.
- **`localStorage`** pour la graine et la progression (le monde se régénère
  depuis la graine, donc la sauvegarde reste minuscule).
