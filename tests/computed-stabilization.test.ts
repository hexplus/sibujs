import { describe, expect, it } from "vitest";
import { derived } from "../src/core/signals/derived";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";
import { batch } from "../src/reactivity/batch";

// ---------------------------------------------------------------------------
// Computed stabilization contract.
//
// THE INVARIANT UNDER TEST: a computed causes downstream observable work only
// when its VALUE changes according to its equality policy. An upstream source
// changing means "something needs validating", not "the downstream value
// changed" — invalidation is not notification.
//
// Regression origin: downstream effects were enqueued by propagateDirty at
// write time, before the computed had recomputed, so `derived({ equals })`
// deduplicated notifications but never actually stopped propagation.
// ---------------------------------------------------------------------------

describe("derived stabilization — primitive equality", () => {
  it("does not rerun a downstream effect when the derived output is unchanged", () => {
    const [value, setValue] = signal(1);
    const parity = derived(() => value() % 2);

    let runs = 0;
    const dispose = effect(() => {
      parity();
      runs++;
    });

    expect(runs).toBe(1);

    // source 1 -> 3, derived 1 -> 1. The effect's only relevant dependency
    // did not change value, so it must not re-run.
    setValue(3);
    expect(runs).toBe(1);
    expect(parity()).toBe(1);

    dispose();
  });

  it("reruns when the derived output does change", () => {
    const [value, setValue] = signal(1);
    const parity = derived(() => value() % 2);

    let runs = 0;
    const dispose = effect(() => {
      parity();
      runs++;
    });

    setValue(2); // derived 1 -> 0
    expect(runs).toBe(2);
    expect(parity()).toBe(0);

    dispose();
  });

  it("still reruns an effect that reads the changing source directly", () => {
    const [value, setValue] = signal(1);
    const parity = derived(() => value() % 2);

    let runs = 0;
    const dispose = effect(() => {
      value(); // direct dependency on the source
      parity();
      runs++;
    });

    setValue(3); // source really changed, even though parity did not
    expect(runs).toBe(2);

    dispose();
  });
});

describe("derived stabilization — custom equals", () => {
  it("suppresses downstream work when the comparator says nothing changed", () => {
    const [source, setSource] = signal<{ x: number; ignored: string }>({ x: 1, ignored: "a" });
    const selected = derived(() => ({ x: source().x }), { equals: (a, b) => a?.x === b?.x });

    let runs = 0;
    const dispose = effect(() => {
      selected();
      runs++;
    });

    expect(runs).toBe(1);

    setSource({ x: 1, ignored: "b" }); // only the ignored field moved
    expect(runs).toBe(1);

    setSource({ x: 2, ignored: "b" }); // the selected field moved
    expect(runs).toBe(2);

    dispose();
  });

  it("keeps the previous reference identity when the comparator says equal", () => {
    const [source, setSource] = signal({ x: 1, ignored: "a" });
    const selected = derived(() => ({ x: source().x }), { equals: (a, b) => a?.x === b?.x });

    const first = selected();
    setSource({ x: 1, ignored: "b" });
    expect(selected()).toBe(first); // same object, not a fresh equal one
  });

  it("treats a legitimate undefined previous value as initialized", () => {
    const [n, setN] = signal(0);
    const maybe = derived<number | undefined>(() => (n() === 0 ? undefined : n()), {
      equals: (a, b) => a === b,
    });

    let runs = 0;
    const dispose = effect(() => {
      maybe();
      runs++;
    });

    expect(maybe()).toBeUndefined();
    setN(0); // no-op write
    expect(runs).toBe(1);

    dispose();
  });
});

describe("derived stabilization — linear chain", () => {
  it("a stable intermediate stops propagation before the effect", () => {
    // signal -> A -> B -> effect
    const [n, setN] = signal(1);
    let aRuns = 0;
    let bRuns = 0;

    const a = derived(() => {
      aRuns++;
      return n() % 2; // 1 -> 1 for n: 1 -> 3
    });
    const b = derived(() => {
      bRuns++;
      return a() * 10;
    });

    let effectRuns = 0;
    const dispose = effect(() => {
      b();
      effectRuns++;
    });

    expect(effectRuns).toBe(1);
    const aBefore = aRuns;
    const bBefore = bRuns;

    setN(3);

    // The guaranteed contract is about OBSERVABLE work: the user effect does
    // not run, because B's value is unchanged.
    expect(effectRuns).toBe(1);

    // Recomputation of the pure intermediates is NOT part of that guarantee.
    // Stabilization is decided lazily at drain time, so B must recompute once
    // to discover that its own value is unchanged. `derived` getters are
    // required to be pure, so this is not observable work — but it is real,
    // and each link revalidates at most once per update, never once per path.
    expect(aRuns).toBe(aBefore + 1);
    expect(bRuns).toBe(bBefore + 1);

    dispose();
  });

  it("propagates through the chain when the value genuinely changes", () => {
    const [n, setN] = signal(1);
    const a = derived(() => n() * 2);
    const b = derived(() => a() + 1);

    let effectRuns = 0;
    let seen = 0;
    const dispose = effect(() => {
      seen = b();
      effectRuns++;
    });

    expect(seen).toBe(3);
    setN(5);
    expect(effectRuns).toBe(2);
    expect(seen).toBe(11);

    dispose();
  });
});

describe("derived stabilization — diamond", () => {
  //        source
  //        /    \
  //       A      B
  //        \    /
  //          C
  //          |
  //        effect
  it("runs the effect once per genuine change, not once per path", () => {
    const [source, setSource] = signal(1);
    const a = derived(() => source() + 1);
    const b = derived(() => source() * 2);
    let _cRuns = 0;
    const c = derived(() => {
      _cRuns++;
      return a() + b();
    });

    let effectRuns = 0;
    let seen = 0;
    const dispose = effect(() => {
      seen = c();
      effectRuns++;
    });

    expect(seen).toBe(4); // (1+1) + (1*2)
    expect(effectRuns).toBe(1);

    setSource(2);
    expect(seen).toBe(7); // (2+1) + (2*2)
    // Exactly one effect run despite the value arriving via two paths.
    expect(effectRuns).toBe(2);

    dispose();
  });

  it("a stable diamond sink suppresses the effect entirely", () => {
    // C is constructed so that both branches move but C's value does not.
    const [source, setSource] = signal(1);
    const a = derived(() => source() + 1);
    const b = derived(() => -source());
    const c = derived(() => a() + b()); // always 1

    let effectRuns = 0;
    const dispose = effect(() => {
      c();
      effectRuns++;
    });

    expect(c()).toBe(1);
    expect(effectRuns).toBe(1);

    setSource(5); // a: 2->6, b: -1->-5, c: 1->1
    expect(c()).toBe(1);
    expect(effectRuns).toBe(1);

    setSource(9);
    expect(effectRuns).toBe(1);

    dispose();
  });
});

describe("derived stabilization — batching", () => {
  it("suppresses the effect when a batch nets out to an unchanged derived", () => {
    const [a, setA] = signal(1);
    const [b, setB] = signal(1);
    const sum = derived(() => a() + b());

    let runs = 0;
    const dispose = effect(() => {
      sum();
      runs++;
    });

    expect(runs).toBe(1);

    // Both sources change; the sum does not.
    batch(() => {
      setA(2);
      setB(0);
    });
    expect(sum()).toBe(2);
    expect(runs).toBe(1);

    dispose();
  });

  it("runs the effect exactly once when a batch does change the derived", () => {
    const [a, setA] = signal(1);
    const [b, setB] = signal(1);
    const sum = derived(() => a() + b());

    let runs = 0;
    const dispose = effect(() => {
      sum();
      runs++;
    });

    batch(() => {
      setA(5);
      setB(5);
    });
    expect(sum()).toBe(10);
    expect(runs).toBe(2); // one initial + one for the batch

    dispose();
  });

  it("stabilizes correctly through nested batches", () => {
    const [a, setA] = signal(1);
    const [b, setB] = signal(1);
    const sum = derived(() => a() + b());

    let runs = 0;
    const dispose = effect(() => {
      sum();
      runs++;
    });

    batch(() => {
      setA(4);
      batch(() => {
        setB(-2);
      });
    });
    expect(sum()).toBe(2);
    expect(runs).toBe(1); // 4 + (-2) === 1 + 1

    dispose();
  });
});

describe("derived stabilization — conditional dependencies", () => {
  it("unsubscribes the stale branch and stops reacting to it", () => {
    const [toggle, setToggle] = signal(true);
    const [a, setA] = signal(1);
    const [b, setB] = signal(100);

    const picked = derived(() => (toggle() ? a() : b()));

    let runs = 0;
    let seen = 0;
    const dispose = effect(() => {
      seen = picked();
      runs++;
    });

    expect(seen).toBe(1);

    // b is not a dependency while toggle is true.
    setB(200);
    expect(runs).toBe(1);

    setToggle(false);
    expect(seen).toBe(200);
    expect(runs).toBe(2);

    // a is now the stale branch.
    setA(50);
    expect(runs).toBe(2);

    setB(201);
    expect(seen).toBe(201);
    expect(runs).toBe(3);

    dispose();
  });

  it("suppresses the effect when a branch switch lands on an equal value", () => {
    const [toggle, setToggle] = signal(true);
    const [a] = signal(7);
    const [b] = signal(7);
    const picked = derived(() => (toggle() ? a() : b()));

    let runs = 0;
    const dispose = effect(() => {
      picked();
      runs++;
    });

    expect(runs).toBe(1);
    setToggle(false); // different branch, same value
    expect(runs).toBe(1);

    dispose();
  });
});

describe("derived stabilization — writes from effects", () => {
  it("a downstream write during the drain still converges", () => {
    const [a, setA] = signal(0);
    const [mirror, setMirror] = signal(-1);

    const doubled = derived(() => a() * 2);

    const d1 = effect(() => {
      setMirror(doubled());
    });

    let observed = -99;
    let runs = 0;
    const d2 = effect(() => {
      observed = mirror();
      runs++;
    });

    expect(observed).toBe(0);
    const baseline = runs;

    setA(3);
    expect(observed).toBe(6);
    expect(runs).toBe(baseline + 1);

    d1();
    d2();
  });

  it("an effect writing a source whose derived is stable does not spin", () => {
    const [n, setN] = signal(1);
    const parity = derived(() => n() % 2);

    let runs = 0;
    const dispose = effect(() => {
      parity();
      runs++;
    });

    // Each write moves the source by 2, so parity is invariant.
    for (let i = 0; i < 20; i++) setN(n() + 2);

    expect(runs).toBe(1);
    dispose();
  });
});

describe("derived stabilization — laziness is preserved", () => {
  it("does not recompute a derived that nothing is observing", () => {
    const [n, setN] = signal(1);
    let computeCount = 0;
    const d = derived(() => {
      computeCount++;
      return n() * 2;
    });

    expect(computeCount).toBe(1); // initial evaluation establishes deps
    setN(2);
    setN(3);
    setN(4);
    // No observer, so no recompute was forced by the writes.
    expect(computeCount).toBe(1);

    expect(d()).toBe(8); // pulled on read
    expect(computeCount).toBe(2);
  });
});
