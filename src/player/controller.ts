/**
 * First-person player: movement, gravity, jumping, and swept AABB collision
 * against the voxel grid. Axis-separated resolution keeps the player from
 * catching on block seams.
 */

import * as THREE from 'three';
import type { InputManager } from './input.js';

const PLAYER_RADIUS = 0.32;
const PLAYER_HEIGHT = 1.72;
const EYE_HEIGHT = 1.62;
const GRAVITY = 26;
const JUMP_SPEED = 8.2;
const WALK_SPEED = 4.6;
const SPRINT_SPEED = 7.0;
const ACCEL = 14;
const MAX_PITCH = Math.PI / 2 - 0.02;
/** Below this the player has fallen off the world and gets nudged back. */
const VOID_Y = -12;

export interface PlayerState {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  yaw: number;
  pitch: number;
  onGround: boolean;
}

export class PlayerController {
  readonly state: PlayerState;
  private lastSafe = new THREE.Vector3();

  constructor(
    private readonly solid: Set<string>,
    private readonly input: InputManager,
    start: { x: number; y: number; z: number },
  ) {
    this.state = {
      position: new THREE.Vector3(start.x, start.y, start.z),
      velocity: new THREE.Vector3(),
      yaw: 0,
      pitch: 0,
      onGround: false,
    };
    this.lastSafe.copy(this.state.position);
  }

  /** True when a solid block occupies the voxel containing this point. */
  private isSolidAt(x: number, y: number, z: number): boolean {
    return this.solid.has(`${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`);
  }

  /**
   * Does the player's AABB overlap any solid voxel?
   *
   * A voxel at index i spans [i, i+1). The box spans [c-R, c+R), so the last
   * overlapped index is ceil(c+R)-1, NOT floor(c+R): when the box edge lands
   * exactly on a voxel boundary it touches without penetrating. Using floor on
   * the max edge made the box effectively one voxel wider on the low side,
   * which blocked movement asymmetrically (walls felt solid strafing one way
   * and half a voxel away strafing the other).
   */
  private collides(pos: THREE.Vector3): boolean {
    const minX = Math.floor(pos.x - PLAYER_RADIUS);
    const maxX = Math.ceil(pos.x + PLAYER_RADIUS) - 1;
    const minZ = Math.floor(pos.z - PLAYER_RADIUS);
    const maxZ = Math.ceil(pos.z + PLAYER_RADIUS) - 1;
    // pos.y is the player's feet.
    const minY = Math.floor(pos.y);
    const maxY = Math.ceil(pos.y + PLAYER_HEIGHT) - 1;

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        for (let z = minZ; z <= maxZ; z++) {
          if (this.solid.has(`${x},${y},${z}`)) return true;
        }
      }
    }
    return false;
  }

  update(dt: number): void {
    const s = this.state;

    // --- look ---
    const look = this.input.getLookDelta();
    s.yaw -= look.dx;
    s.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, s.pitch - look.dy));

    // --- desired horizontal velocity ---
    const move = this.input.getMoveVector();
    const speed = this.input.sprinting ? SPRINT_SPEED : WALK_SPEED;
    const sin = Math.sin(s.yaw);
    const cos = Math.cos(s.yaw);
    // forward is -Z in three.js convention when yaw = 0
    const wishX = (-sin * move.forward + cos * move.strafe) * speed;
    const wishZ = (-cos * move.forward - sin * move.strafe) * speed;

    const blend = 1 - Math.exp(-ACCEL * dt);
    s.velocity.x += (wishX - s.velocity.x) * blend;
    s.velocity.z += (wishZ - s.velocity.z) * blend;

    // --- gravity ---
    s.velocity.y -= GRAVITY * dt;
    if (s.velocity.y < -55) s.velocity.y = -55;

    // --- integrate with per-axis collision resolution ---
    const pos = s.position;

    /**
     * Move one axis, undoing it entirely on contact.
     *
     * Large steps are split into sub-steps smaller than the player's radius:
     * a single long step could otherwise start and end in open space while
     * passing straight through a wall (tunnelling), which is what makes a fast
     * strafe slip through geometry on a slow frame.
     */
    const tryAxis = (axis: 'x' | 'y' | 'z', delta: number) => {
      if (delta === 0) return;
      const steps = Math.max(1, Math.ceil(Math.abs(delta) / (PLAYER_RADIUS * 0.5)));
      const step = delta / steps;
      for (let i = 0; i < steps; i++) {
        const before = pos[axis];
        pos[axis] = before + step;
        if (this.collides(pos)) {
          pos[axis] = before;
          if (axis === 'y') {
            if (step < 0) s.onGround = true;
            s.velocity.y = 0;
          } else {
            s.velocity[axis] = 0;
          }
          return;
        }
      }
    };

    s.onGround = false;
    tryAxis('y', s.velocity.y * dt);
    tryAxis('x', s.velocity.x * dt);
    tryAxis('z', s.velocity.z * dt);

    // Standing check: a block directly under the feet.
    if (!s.onGround && this.isSolidAt(pos.x, pos.y - 0.08, pos.z)) s.onGround = true;

    if (s.onGround) this.lastSafe.copy(pos);

    // Falling into a gap is recoverable, not lethal: there is no death here.
    if (pos.y < VOID_Y) {
      pos.copy(this.lastSafe);
      s.velocity.set(0, 0, 0);
    }
  }

  jump(): void {
    if (this.state.onGround) {
      this.state.velocity.y = JUMP_SPEED;
      this.state.onGround = false;
    }
  }

  /** Instantly move the player (teleporters). */
  teleportTo(x: number, y: number, z: number): void {
    this.state.position.set(x, y, z);
    this.state.velocity.set(0, 0, 0);
    this.lastSafe.set(x, y, z);
  }

  /** Apply the player's transform to the camera. */
  applyToCamera(camera: THREE.PerspectiveCamera): void {
    const { position, yaw, pitch } = this.state;
    camera.position.set(position.x, position.y + EYE_HEIGHT, position.z);
    camera.rotation.set(0, 0, 0, 'YXZ');
    camera.rotation.y = yaw;
    camera.rotation.x = pitch;
  }

  /** Unit vector the player is facing, on the horizontal plane. */
  forwardVector(): THREE.Vector3 {
    return new THREE.Vector3(-Math.sin(this.state.yaw), 0, -Math.cos(this.state.yaw));
  }
}

export { PLAYER_HEIGHT, EYE_HEIGHT, PLAYER_RADIUS };
