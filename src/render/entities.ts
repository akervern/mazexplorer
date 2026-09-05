/**
 * World entities: item pickups, signposts, teleporter pads.
 * All geometry is procedural; icons are canvas-drawn sprites.
 */

import * as THREE from 'three';
import type { World, Zone } from '../core/types.js';
import { ITEMS } from '../world/items.js';
import { makeLabelTexture } from './textures.js';
import { tileToWorld } from '../world/worldGen.js';

export interface EntityViews {
  group: THREE.Group;
  pickups: Map<string, THREE.Object3D>;
  teleporters: Map<string, THREE.Object3D>;
  signposts: Map<string, THREE.Object3D>;
  /** Per-frame animation (bobbing, spinning). */
  update(t: number): void;
  dispose(): void;
}

function zoneOf(world: World, id: string): Zone {
  return world.zones.find((z) => z.id === id)!;
}

export function buildEntities(world: World): EntityViews {
  const group = new THREE.Group();
  const pickups = new Map<string, THREE.Object3D>();
  const teleporters = new Map<string, THREE.Object3D>();
  const signposts = new Map<string, THREE.Object3D>();
  const animated: { obj: THREE.Object3D; baseY: number; spin: number }[] = [];
  const disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = [];

  // --- pickups: a floating tinted cube with the item icon on top ---
  for (const p of world.pickups) {
    const zone = zoneOf(world, p.zoneId);
    const item = ITEMS[p.itemId];
    const obj = new THREE.Group();

    const geo = new THREE.BoxGeometry(0.34, 0.34, 0.34);
    const mat = new THREE.MeshLambertMaterial({
      color: item?.color ?? 0xffffff,
      emissive: new THREE.Color(item?.color ?? 0xffffff).multiplyScalar(0.35),
    });
    const cube = new THREE.Mesh(geo, mat);
    obj.add(cube);
    disposables.push(geo, mat);

    const tex = makeLabelTexture(item?.icon ?? '❓', 'rgba(0,0,0,0)');
    const sprMat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true });
    const spr = new THREE.Sprite(sprMat);
    spr.scale.set(0.5, 0.5, 0.5);
    spr.position.y = 0.5;
    obj.add(spr);
    disposables.push(tex, sprMat);

    const baseY = 0.55;
    const pw = tileToWorld(zone, p.tile);
    obj.position.set(pw.x, baseY, pw.z);
    group.add(obj);
    pickups.set(p.uid, obj);
    animated.push({ obj, baseY, spin: 1.2 });
  }

  // --- signposts: a post plus a board with a readable icon ---
  for (const s of world.signposts) {
    const zone = zoneOf(world, s.zoneId);
    const obj = new THREE.Group();

    const postGeo = new THREE.BoxGeometry(0.12, 1.3, 0.12);
    const postMat = new THREE.MeshLambertMaterial({ color: 0x6b4c2a });
    const post = new THREE.Mesh(postGeo, postMat);
    post.position.y = 0.65;
    obj.add(post);

    const boardGeo = new THREE.BoxGeometry(0.9, 0.55, 0.08);
    const boardMat = new THREE.MeshLambertMaterial({ color: 0x9a7040 });
    const board = new THREE.Mesh(boardGeo, boardMat);
    board.position.y = 1.4;
    obj.add(board);
    disposables.push(postGeo, postMat, boardGeo, boardMat);

    const tex = makeLabelTexture(s.mechanismUid ? '🔒' : '📜', 'rgba(0,0,0,0)');
    const sprMat = new THREE.SpriteMaterial({ map: tex, transparent: true });
    const spr = new THREE.Sprite(sprMat);
    spr.scale.set(0.42, 0.42, 0.42);
    spr.position.set(0, 1.42, 0.09);
    obj.add(spr);
    disposables.push(tex, sprMat);

    const sw = tileToWorld(zone, s.tile);
    obj.position.set(sw.x, 0, sw.z);
    group.add(obj);
    signposts.set(s.uid, obj);
  }

  // --- teleporters: a glowing pad with a rotating ring ---
  for (const t of world.teleporters) {
    const zone = zoneOf(world, t.zoneId);
    const obj = new THREE.Group();

    const padGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.12, 12);
    const padMat = new THREE.MeshLambertMaterial({
      color: 0x2a3550,
      emissive: 0x2266aa,
      emissiveIntensity: 0.7,
    });
    const pad = new THREE.Mesh(padGeo, padMat);
    pad.position.y = 0.06;
    obj.add(pad);

    const ringGeo = new THREE.TorusGeometry(0.3, 0.045, 8, 20);
    const ringMat = new THREE.MeshLambertMaterial({
      color: 0x66ccff,
      emissive: 0x3399dd,
      emissiveIntensity: 1.1,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.55;
    obj.add(ring);
    disposables.push(padGeo, padMat, ringGeo, ringMat);

    const tw = tileToWorld(zone, t.tile);
    obj.position.set(tw.x, 0, tw.z);
    group.add(obj);
    teleporters.set(t.uid, obj);
    animated.push({ obj: ring, baseY: 0.55, spin: 0.9 });
  }

  return {
    group,
    pickups,
    teleporters,
    signposts,
    update(t) {
      for (const a of animated) {
        a.obj.rotation.y = t * a.spin;
        a.obj.position.y = a.baseY + Math.sin(t * 2 + a.baseY * 4) * 0.07;
      }
    },
    dispose() {
      for (const d of disposables) d.dispose();
      group.clear();
    },
  };
}

/** Small particle burst played when a mechanism unlocks or an item is taken. */
export function spawnBurst(
  parent: THREE.Object3D,
  position: THREE.Vector3,
  color: number,
  count = 18,
): (dt: number) => boolean {
  const geo = new THREE.BoxGeometry(0.09, 0.09, 0.09);
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true });
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  const vel: THREE.Vector3[] = [];
  const pos: THREE.Vector3[] = [];
  const dummy = new THREE.Object3D();

  for (let i = 0; i < count; i++) {
    pos.push(position.clone());
    const a = (i / count) * Math.PI * 2;
    vel.push(new THREE.Vector3(Math.cos(a) * 2.2, 2.6 + (i % 4) * 0.5, Math.sin(a) * 2.2));
  }
  parent.add(mesh);

  let life = 0;
  return (dt: number) => {
    life += dt;
    for (let i = 0; i < count; i++) {
      vel[i].y -= 9 * dt;
      pos[i].addScaledVector(vel[i], dt);
      dummy.position.copy(pos[i]);
      dummy.scale.setScalar(Math.max(0, 1 - life / 1.1));
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mat.opacity = Math.max(0, 1 - life / 1.1);

    if (life > 1.1) {
      mesh.removeFromParent();
      geo.dispose();
      mat.dispose();
      return false; // done
    }
    return true;
  };
}
