/**
 * Input abstraction.
 *
 * Game logic only ever calls getMoveVector() / getLookDelta() / consumeAction().
 * Swapping in a touch joystick later means adding another InputSource — no
 * change to the player controller, and Pointer Lock stays one option among
 * several rather than a hard dependency.
 */

export interface MoveVector {
  /** -1..1, positive = forward */
  forward: number;
  /** -1..1, positive = right */
  strafe: number;
}

export interface LookDelta {
  dx: number;
  dy: number;
}

export type GameAction = 'jump' | 'interact' | 'map' | 'inventory' | 'pause';

export interface InputSource {
  readonly id: string;
  getMoveVector(): MoveVector;
  getLookDelta(): LookDelta;
  /** Actions triggered since the last call, drained on read. */
  drainActions(): GameAction[];
  attach(): void;
  detach(): void;
  /** True when this source can drive the camera right now. */
  readonly isActive: boolean;
}

/** Keyboard + mouse with Pointer Lock. Supports both WASD and ZQSD. */
export class KeyboardMouseInput implements InputSource {
  readonly id = 'keyboard-mouse';
  private keys = new Set<string>();
  private look: LookDelta = { dx: 0, dy: 0 };
  private actions: GameAction[] = [];
  private locked = false;
  private sensitivity: number;

  constructor(
    private readonly element: HTMLElement,
    opts: { sensitivity?: number } = {},
  ) {
    this.sensitivity = opts.sensitivity ?? 0.0022;
  }

  get isActive(): boolean {
    return this.locked;
  }

  attach(): void {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    document.addEventListener('pointerlockchange', this.onLockChange);
    document.addEventListener('mousemove', this.onMouseMove);
    this.element.addEventListener('click', this.requestLock);
    window.addEventListener('blur', this.onBlur);
  }

  detach(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    document.removeEventListener('pointerlockchange', this.onLockChange);
    document.removeEventListener('mousemove', this.onMouseMove);
    this.element.removeEventListener('click', this.requestLock);
    window.removeEventListener('blur', this.onBlur);
    this.keys.clear();
  }

  requestLock = (): void => {
    if (!this.locked) void this.element.requestPointerLock?.();
  };

  releaseLock(): void {
    if (this.locked) document.exitPointerLock?.();
  }

  private onBlur = (): void => {
    this.keys.clear();
  };

  private onLockChange = (): void => {
    this.locked = document.pointerLockElement === this.element;
    if (!this.locked) this.keys.clear();
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.locked) return;
    this.look.dx += e.movementX * this.sensitivity;
    this.look.dy += e.movementY * this.sensitivity;
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    // `code` is layout-independent, so KeyW covers both QWERTY W and AZERTY Z.
    this.keys.add(e.code);
    switch (e.code) {
      case 'Space':
        this.actions.push('jump');
        e.preventDefault();
        break;
      case 'KeyE':
      case 'Enter':
        this.actions.push('interact');
        break;
      case 'KeyM':
        this.actions.push('map');
        break;
      case 'KeyI':
      case 'Tab':
        this.actions.push('inventory');
        e.preventDefault();
        break;
      case 'Escape':
        this.actions.push('pause');
        break;
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  getMoveVector(): MoveVector {
    const k = this.keys;
    // KeyW/KeyZ and KeyA/KeyQ so both QWERTY (WASD) and AZERTY (ZQSD) work.
    const fwd = (k.has('KeyW') || k.has('KeyZ') || k.has('ArrowUp') ? 1 : 0) -
      (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const str = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) -
      (k.has('KeyA') || k.has('KeyQ') || k.has('ArrowLeft') ? 1 : 0);
    return { forward: fwd, strafe: str };
  }

  getLookDelta(): LookDelta {
    const out = { ...this.look };
    this.look.dx = 0;
    this.look.dy = 0;
    return out;
  }

  drainActions(): GameAction[] {
    const out = this.actions;
    this.actions = [];
    return out;
  }

  /** True when the player is holding the sprint key. */
  get sprinting(): boolean {
    return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
  }
}

/**
 * Combines several sources: movement/look are summed, actions concatenated.
 * A touch source can simply be pushed in on mobile without further changes.
 */
export class InputManager {
  private sources: InputSource[] = [];

  add(source: InputSource): this {
    this.sources.push(source);
    source.attach();
    return this;
  }

  remove(source: InputSource): void {
    source.detach();
    this.sources = this.sources.filter((s) => s !== source);
  }

  getMoveVector(): MoveVector {
    let forward = 0;
    let strafe = 0;
    for (const s of this.sources) {
      const v = s.getMoveVector();
      forward += v.forward;
      strafe += v.strafe;
    }
    const len = Math.hypot(forward, strafe);
    if (len > 1) {
      forward /= len;
      strafe /= len;
    }
    return { forward, strafe };
  }

  getLookDelta(): LookDelta {
    let dx = 0;
    let dy = 0;
    for (const s of this.sources) {
      const l = s.getLookDelta();
      dx += l.dx;
      dy += l.dy;
    }
    return { dx, dy };
  }

  drainActions(): GameAction[] {
    return this.sources.flatMap((s) => s.drainActions());
  }

  get sprinting(): boolean {
    return this.sources.some((s) => (s as KeyboardMouseInput).sprinting === true);
  }

  dispose(): void {
    for (const s of this.sources) s.detach();
    this.sources = [];
  }
}
