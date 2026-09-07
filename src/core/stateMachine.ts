/**
 * A tiny, DOM-free finite state machine.
 *
 * States own their own entry and exit; the machine owns *which* state is
 * current and *which* transitions are legal. Nothing else in the codebase gets
 * to flip a screen on and another off by hand — that hand-rolled bookkeeping is
 * what this replaces.
 *
 * Like the rest of `core/`, this file is free of DOM and Three.js so it stays
 * testable under plain tsx.
 */

/** What a state is handed on every transition into it. */
export interface StateContext<S extends string, E extends string, Ctx> {
  /** The shared context object passed to the machine at construction. */
  readonly shared: Ctx;
  /** The state we came from, or `null` for the very first entry. */
  readonly from: S | null;
  /** The event that caused the transition, or `null` for the initial state. */
  readonly event: E | null;
  /** Payload carried by `send()`, untyped on purpose — states cast it. */
  readonly payload: unknown;
}

export interface State<S extends string, E extends string, Ctx> {
  readonly id: S;
  /**
   * Which events this state answers, and where they lead. An event absent from
   * the map is ignored — that is the point: an end screen simply has no
   * `pause`, so a stray key cannot desync the UI.
   */
  readonly on?: Partial<Record<E, S>>;
  enter?(ctx: StateContext<S, E, Ctx>): void;
  exit?(next: S): void;
  /** Per-frame tick, only called while this state is current. */
  update?(dt: number): void;
}

export class StateMachine<S extends string, E extends string, Ctx> {
  private readonly states = new Map<S, State<S, E, Ctx>>();
  private current: State<S, E, Ctx> | null = null;
  /** Guards against a state sending an event from inside its own `enter()`. */
  private transitioning = false;
  private queued: { event: E; payload: unknown }[] = [];

  constructor(
    private readonly shared: Ctx,
    states: State<S, E, Ctx>[],
  ) {
    for (const s of states) this.states.set(s.id, s);
  }

  get state(): S | null {
    return this.current?.id ?? null;
  }

  is(id: S): boolean {
    return this.current?.id === id;
  }

  /** Enter the initial state. Call once, before any `send()`. */
  start(id: S, payload?: unknown): void {
    this.transition(id, null, payload ?? null);
  }

  /**
   * Feed an event in. Returns whether it was accepted — an event the current
   * state does not declare is a no-op, not an error.
   */
  send(event: E, payload?: unknown): boolean {
    if (this.transitioning) {
      // A transition triggered by `enter()` must run *after* that entry has
      // finished, or the two states would both be half-entered.
      this.queued.push({ event, payload: payload ?? null });
      return true;
    }
    const next = this.current?.on?.[event];
    if (!next) return false;
    this.transition(next, event, payload ?? null);
    return true;
  }

  update(dt: number): void {
    this.current?.update?.(dt);
  }

  private transition(id: S, event: E | null, payload: unknown): void {
    const next = this.states.get(id);
    if (!next) throw new Error(`unknown state: ${id}`);

    const from = this.current?.id ?? null;
    this.transitioning = true;
    try {
      this.current?.exit?.(id);
      this.current = next;
      next.enter?.({ shared: this.shared, from, event, payload });
    } finally {
      this.transitioning = false;
    }

    const pending = this.queued;
    this.queued = [];
    for (const q of pending) this.send(q.event, q.payload);
  }
}
