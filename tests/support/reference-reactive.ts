/**
 * A deliberately naive reactive engine, for TESTS ONLY.
 *
 * Its single job is to be obviously correct so that the production engine's
 * observable behaviour can be checked against something that shares none of its
 * optimizations. It reuses nothing from `src/` — no linked dependency edges, no
 * epochs, no node pool, no queue dedup, no reentrancy bookkeeping. Just plain
 * arrays, `Set`s, `Map`s, and recomputation from scratch.
 *
 * Semantics modelled (the contract, not the implementation):
 *
 *  - A derived is a pure function of its dependencies, recomputed on demand.
 *  - A derived's value is the PREVIOUS value when its comparator says the fresh
 *    result is equal, so equality preserves reference identity.
 *  - An effect re-runs only when at least one value it actually observed on its
 *    last run now differs. Invalidation alone is never enough.
 *  - A transaction settles to a fixpoint: effects that write re-trigger
 *    dependents until nothing more changes.
 *
 * Performance is irrelevant here; clarity is the entire point.
 */

type Equals<T> = (a: T, b: T) => boolean;

const defaultEquals = <T>(a: T, b: T): boolean => Object.is(a, b);

/** Anything an effect can observe. */
interface RefNode<T = unknown> {
  kind: "signal" | "derived";
  read(): T;
  /** Comparator used to decide whether this node's value changed. */
  equals: Equals<T>;
}

interface RefSignalNode<T> extends RefNode<T> {
  kind: "signal";
  value: T;
  write(next: T): void;
}

interface RefDerivedNode<T> extends RefNode<T> {
  kind: "derived";
  compute: () => T;
  /** Last settled value, or `EMPTY` before the first evaluation. */
  last: T | typeof EMPTY;
  /** Generation at which `last` was settled. */
  settledAt: number;
}

const EMPTY = Symbol("empty");

/**
 * One reactive world. Isolated per test so cases cannot leak into each other.
 */
export class ReferenceWorld {
  /** Bumped on every signal write; invalidates all memoized derived values. */
  private generation = 0;
  private effects: RefEffect[] = [];
  private batchDepth = 0;
  private dirty = false;
  /** Set while an effect body runs, so reads can be recorded. */
  private observer: RefEffect | null = null;
  /** Guard against a pathological test graph spinning forever. */
  private maxSettlePasses = 10_000;

  signal<T>(initial: T, equals: Equals<T> = defaultEquals): RefSignalNode<T> {
    const world = this;
    const node: RefSignalNode<T> = {
      kind: "signal",
      value: initial,
      equals,
      read(): T {
        world.observer?.observed.set(node as RefNode, node.value);
        return node.value;
      },
      write(next: T): void {
        if (equals(node.value, next)) return;
        node.value = next;
        world.generation++;
        world.dirty = true;
        if (world.batchDepth === 0) world.settle();
      },
    };
    return node;
  }

  derived<T>(compute: () => T, equals: Equals<T> = defaultEquals): RefDerivedNode<T> {
    const world = this;
    const node: RefDerivedNode<T> = {
      kind: "derived",
      compute,
      last: EMPTY,
      settledAt: -1,
      equals,
      read(): T {
        const value = world.valueOf(node);
        world.observer?.observed.set(node as RefNode, value);
        return value;
      },
    };
    return node;
  }

  /**
   * Settled value of a derived at the current generation.
   *
   * Recomputed from scratch whenever the generation moved. If the comparator
   * says the fresh result equals the previous one, the PREVIOUS value is kept —
   * that is what makes `equals` preserve identity and stop propagation.
   */
  private valueOf<T>(node: RefDerivedNode<T>): T {
    if (node.settledAt === this.generation && node.last !== EMPTY) {
      return node.last as T;
    }
    // A derived ENCAPSULATES its inputs: reading it creates a dependency on
    // its VALUE, not on the signals it happens to consult. Leaving the observer
    // installed here would record those inputs on the observing effect, which
    // re-creates the exact bug this harness exists to detect — an effect
    // re-running because an upstream source moved even though the derived it
    // actually reads produced an equal value.
    const previousObserver = this.observer;
    this.observer = null;
    let fresh: T;
    try {
      fresh = node.compute();
    } finally {
      this.observer = previousObserver;
    }
    const previous = node.last;
    const settled = previous !== EMPTY && node.equals(previous as T, fresh) ? (previous as T) : fresh;
    node.last = settled;
    node.settledAt = this.generation;
    return settled;
  }

  effect(body: () => void): { dispose(): void; runs: number } {
    const eff = new RefEffect(body);
    this.effects.push(eff);
    this.run(eff);
    const world = this;
    return {
      get runs() {
        return eff.runs;
      },
      dispose(): void {
        eff.disposed = true;
        const i = world.effects.indexOf(eff);
        if (i >= 0) world.effects.splice(i, 1);
      },
    };
  }

  batch<T>(fn: () => T): T {
    this.batchDepth++;
    try {
      return fn();
    } finally {
      this.batchDepth--;
      if (this.batchDepth === 0 && this.dirty) this.settle();
    }
  }

  private run(eff: RefEffect): void {
    if (eff.disposed) return;
    const previousObserver = this.observer;
    this.observer = eff;
    eff.observed = new Map();
    eff.runs++;
    try {
      eff.body();
    } catch {
      // The reference engine contains errors the same way the production one
      // does; the differential harness only compares successful observations.
    } finally {
      this.observer = previousObserver;
    }
  }

  /** Does this effect observe a value that differs from what it last saw? */
  private needsRun(eff: RefEffect): boolean {
    if (eff.disposed) return false;
    if (eff.observed.size === 0) return false;
    for (const [node, seen] of eff.observed) {
      const current = node.kind === "derived" ? this.valueOf(node as RefDerivedNode<unknown>) : node.read();
      if (!node.equals(seen, current)) return true;
    }
    return false;
  }

  /** Run effects until no observed value differs from what its effect saw. */
  private settle(): void {
    this.dirty = false;
    let passes = 0;
    let progressed = true;
    while (progressed) {
      if (++passes > this.maxSettlePasses) return;
      progressed = false;
      // Snapshot: an effect may dispose or create effects while running.
      for (const eff of [...this.effects]) {
        if (this.needsRun(eff)) {
          this.run(eff);
          progressed = true;
        }
      }
    }
  }
}

class RefEffect {
  runs = 0;
  disposed = false;
  /** Node -> value observed on the most recent run. */
  observed = new Map<RefNode, unknown>();
  constructor(readonly body: () => void) {}
}

/**
 * Deterministic PRNG (mulberry32). Seeded so any mismatch the differential
 * suite reports can be replayed exactly from the seed alone.
 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
