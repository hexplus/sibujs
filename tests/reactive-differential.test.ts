import { describe, expect, it } from "vitest";
import { setRuntimeErrorHandler } from "../src/core/errors";
import { derived } from "../src/core/signals/derived";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";
import { batch } from "../src/reactivity/batch";
import { makeRng, ReferenceWorld } from "./support/reference-reactive";

// ---------------------------------------------------------------------------
// Differential / property testing.
//
// Randomized reactive graphs are executed against BOTH the production engine
// and the naive reference engine in tests/support/reference-reactive.ts, and
// their observable behaviour is compared.
//
// This matters because the production engine is heavily optimized — linked
// dependency edges, epochs, edge reuse, node pooling, dirty propagation, queue
// dedup, reentrancy guards — and every one of those is a place where an
// optimization could quietly stop being semantics-preserving. The reference
// engine shares none of that machinery, so agreement between the two is real
// evidence rather than the same bug reproduced twice.
//
// WHAT IS COMPARED, AND WHY NOT MORE:
//
//  - Final values of every signal and derived. This is the core contract and
//    is compared exactly.
//  - Whether each effect ran during a transaction. This is what catches both a
//    missed update and a spurious re-run — the stabilization property.
//
//  - NOT the interleaved execution order, and NOT exact re-run counts. SibuJS
//    documents that sibling subscribers fire in reverse-subscription order and
//    converge to a fixpoint rather than guaranteeing a single pass, so exact
//    counts and orderings are explicitly not part of the contract. Asserting
//    them would test the implementation, not the semantics.
//
// ONE KNOWN CONSERVATIVE DEVIATION, asserted rather than hidden: the production
// engine decides "did this change?" from a monotonic per-source version, so a
// signal written to a new value and then written BACK to its original value
// inside a single batch counts as changed and its subscribers re-run, even
// though the net value is identical. The reference engine compares values and
// suppresses that run. This direction is safe — an extra run, never a missed
// one — and predates this suite. It is covered explicitly by the
// `write-and-revert` test at the bottom rather than being generated at random,
// so the randomized suites can require exact agreement.
//
// Every case is driven by a seeded PRNG; a failure prints the seed to replay.
// ---------------------------------------------------------------------------

type Op =
  | { kind: "set"; target: number; value: number }
  | { kind: "batch"; ops: Array<{ target: number; value: number }> };

interface Plan {
  signalCount: number;
  /** Each derived is defined over previously-created nodes. */
  deriveds: Array<{
    inputs: Array<{ layer: "signal" | "derived"; index: number }>;
    /** 0 = sum, 1 = parity of sum (stabilizing), 2 = max, 3 = object with custom equals */
    shape: number;
  }>;
  effects: Array<{ inputs: Array<{ layer: "signal" | "derived"; index: number }>; conditional: boolean }>;
  ops: Op[];
}

function buildPlan(rng: () => number): Plan {
  const signalCount = 2 + Math.floor(rng() * 3); // 2..4
  const derivedCount = 1 + Math.floor(rng() * 4); // 1..4
  const effectCount = 1 + Math.floor(rng() * 3); // 1..3

  const deriveds: Plan["deriveds"] = [];
  for (let d = 0; d < derivedCount; d++) {
    const inputCount = 1 + Math.floor(rng() * 2);
    const inputs: Array<{ layer: "signal" | "derived"; index: number }> = [];
    for (let i = 0; i < inputCount; i++) {
      // Only reference already-created deriveds, so the graph stays acyclic.
      const useDerived = d > 0 && rng() < 0.45;
      inputs.push(
        useDerived
          ? { layer: "derived", index: Math.floor(rng() * d) }
          : { layer: "signal", index: Math.floor(rng() * signalCount) },
      );
    }
    deriveds.push({ inputs, shape: Math.floor(rng() * 4) });
  }

  const effects: Plan["effects"] = [];
  for (let e = 0; e < effectCount; e++) {
    const inputCount = 1 + Math.floor(rng() * 2);
    const inputs: Array<{ layer: "signal" | "derived"; index: number }> = [];
    for (let i = 0; i < inputCount; i++) {
      const useDerived = rng() < 0.6;
      inputs.push(
        useDerived
          ? { layer: "derived", index: Math.floor(rng() * derivedCount) }
          : { layer: "signal", index: Math.floor(rng() * signalCount) },
      );
    }
    effects.push({ inputs, conditional: rng() < 0.3 });
  }

  const opCount = 3 + Math.floor(rng() * 6);
  const ops: Op[] = [];
  for (let o = 0; o < opCount; o++) {
    if (rng() < 0.3) {
      const n = 2 + Math.floor(rng() * 2);
      const inner: Array<{ target: number; value: number }> = [];
      const used = new Set<number>();
      for (let i = 0; i < n; i++) {
        const target = Math.floor(rng() * signalCount);
        // Distinct targets per batch. Writing the SAME signal twice inside one
        // batch is a deliberately excluded shape: see `writeAndRevert` below.
        if (used.has(target)) continue;
        used.add(target);
        inner.push({ target, value: Math.floor(rng() * 6) });
      }
      ops.push({ kind: "batch", ops: inner });
    } else {
      ops.push({ kind: "set", target: Math.floor(rng() * signalCount), value: Math.floor(rng() * 6) });
    }
  }

  return { signalCount, deriveds, effects, ops };
}

/** Shape of a derived's computation, shared by both engines. */
function applyShape(shape: number, values: number[]): number {
  const sum = values.reduce((a, b) => a + b, 0);
  switch (shape) {
    case 0:
      return sum;
    case 1:
      return sum % 2; // stabilizing: many inputs map to the same output
    case 2:
      return Math.max(...values);
    default:
      return sum % 3;
  }
}

interface Observation {
  values: number[];
  ranPerOp: boolean[][];
}

function runProduction(plan: Plan): Observation {
  const signals = Array.from({ length: plan.signalCount }, () => signal(0));

  const deriveds: Array<() => number> = [];
  for (const spec of plan.deriveds) {
    const read = (): number[] =>
      spec.inputs.map((input) => (input.layer === "signal" ? signals[input.index][0]() : deriveds[input.index]()));

    if (spec.shape === 3) {
      // Object-valued derived with a custom comparator: exercises the path
      // where a fresh object is produced but treated as equal.
      const objectDerived = derived(() => ({ v: applyShape(3, read()) }), { equals: (a, b) => a.v === b.v });
      deriveds.push(() => objectDerived().v);
    } else {
      const d = derived(() => applyShape(spec.shape, read()));
      deriveds.push(d);
    }
  }

  const ranFlags: boolean[] = plan.effects.map(() => false);
  const disposers: Array<() => void> = [];
  plan.effects.forEach((spec, index) => {
    disposers.push(
      effect(() => {
        ranFlags[index] = true;
        if (spec.conditional) {
          // Dynamic dependency: the read set changes with the first input.
          const first = spec.inputs[0];
          const gate = first.layer === "signal" ? signals[first.index][0]() : deriveds[first.index]();
          if (gate % 2 === 0) return;
        }
        for (const input of spec.inputs) {
          if (input.layer === "signal") signals[input.index][0]();
          else deriveds[input.index]();
        }
      }),
    );
  });

  const ranPerOp: boolean[][] = [];
  for (const op of plan.ops) {
    ranFlags.fill(false);
    if (op.kind === "set") {
      signals[op.target][1](op.value);
    } else {
      batch(() => {
        for (const inner of op.ops) signals[inner.target][1](inner.value);
      });
    }
    ranPerOp.push([...ranFlags]);
  }

  const values = [...signals.map((s) => s[0]()), ...deriveds.map((d) => d())];
  for (const d of disposers) d();
  return { values, ranPerOp };
}

function runReference(plan: Plan): Observation {
  const world = new ReferenceWorld();
  const signals = Array.from({ length: plan.signalCount }, () => world.signal(0));

  const deriveds: Array<() => number> = [];
  for (const spec of plan.deriveds) {
    const read = (): number[] =>
      spec.inputs.map((input) => (input.layer === "signal" ? signals[input.index].read() : deriveds[input.index]()));

    if (spec.shape === 3) {
      const objectDerived = world.derived<{ v: number }>(
        () => ({ v: applyShape(3, read()) }),
        (a, b) => a.v === b.v,
      );
      deriveds.push(() => objectDerived.read().v);
    } else {
      const d = world.derived(() => applyShape(spec.shape, read()));
      deriveds.push(() => d.read());
    }
  }

  const ranFlags: boolean[] = plan.effects.map(() => false);
  const disposers: Array<{ dispose(): void }> = [];
  plan.effects.forEach((spec, index) => {
    disposers.push(
      world.effect(() => {
        ranFlags[index] = true;
        if (spec.conditional) {
          const first = spec.inputs[0];
          const gate = first.layer === "signal" ? signals[first.index].read() : deriveds[first.index]();
          if (gate % 2 === 0) return;
        }
        for (const input of spec.inputs) {
          if (input.layer === "signal") signals[input.index].read();
          else deriveds[input.index]();
        }
      }),
    );
  });

  const ranPerOp: boolean[][] = [];
  for (const op of plan.ops) {
    ranFlags.fill(false);
    if (op.kind === "set") {
      signals[op.target].write(op.value);
    } else {
      world.batch(() => {
        for (const inner of op.ops) signals[inner.target].write(inner.value);
      });
    }
    ranPerOp.push([...ranFlags]);
  }

  const values = [...signals.map((s) => s.read()), ...deriveds.map((d) => d())];
  for (const d of disposers) d.dispose();
  return { values, ranPerOp };
}

describe("differential testing against a reference reactive engine", () => {
  it("agrees on final values and effect activation across 300 random graphs", () => {
    setRuntimeErrorHandler(() => {});
    const failures: string[] = [];

    for (let seed = 1; seed <= 300; seed++) {
      const plan = buildPlan(makeRng(seed));

      const production = runProduction(plan);
      const reference = runReference(plan);

      if (JSON.stringify(production.values) !== JSON.stringify(reference.values)) {
        failures.push(
          `seed=${seed} FINAL VALUES differ\n  production: ${JSON.stringify(production.values)}\n  reference:  ${JSON.stringify(reference.values)}`,
        );
        continue;
      }

      for (let op = 0; op < production.ranPerOp.length; op++) {
        const prod = production.ranPerOp[op];
        const ref = reference.ranPerOp[op];
        if (JSON.stringify(prod) !== JSON.stringify(ref)) {
          failures.push(
            `seed=${seed} EFFECT ACTIVATION differs at op ${op}\n  production: ${JSON.stringify(prod)}\n  reference:  ${JSON.stringify(ref)}\n  plan: ${JSON.stringify(plan)}`,
          );
          break;
        }
      }
    }

    // Print the first few mismatches with their seeds so any failure is
    // immediately reproducible rather than merely reported.
    expect(failures.slice(0, 3).join("\n\n")).toBe("");
    setRuntimeErrorHandler(null);
  });

  it("agrees on stabilization-heavy graphs (parity deriveds, 200 seeds)", () => {
    setRuntimeErrorHandler(() => {});
    const failures: string[] = [];

    for (let seed = 1000; seed < 1200; seed++) {
      const rng = makeRng(seed);
      const plan = buildPlan(rng);
      // Force every derived onto a stabilizing shape so most writes should NOT
      // reach the effects. This is the workload the old engine got wrong.
      for (const d of plan.deriveds) d.shape = 1;

      const production = runProduction(plan);
      const reference = runReference(plan);

      if (JSON.stringify(production.values) !== JSON.stringify(reference.values)) {
        failures.push(`seed=${seed} values differ`);
        continue;
      }
      if (JSON.stringify(production.ranPerOp) !== JSON.stringify(reference.ranPerOp)) {
        failures.push(
          `seed=${seed} effect activation differs\n  production: ${JSON.stringify(production.ranPerOp)}\n  reference:  ${JSON.stringify(reference.ranPerOp)}\n  plan: ${JSON.stringify(plan)}`,
        );
      }
    }

    expect(failures.slice(0, 3).join("\n\n")).toBe("");
    setRuntimeErrorHandler(null);
  });

  it("agrees on custom-equality graphs (object deriveds, 200 seeds)", () => {
    setRuntimeErrorHandler(() => {});
    const failures: string[] = [];

    for (let seed = 5000; seed < 5200; seed++) {
      const plan = buildPlan(makeRng(seed));
      for (const d of plan.deriveds) d.shape = 3; // object + custom equals

      const production = runProduction(plan);
      const reference = runReference(plan);

      if (
        JSON.stringify(production.values) !== JSON.stringify(reference.values) ||
        JSON.stringify(production.ranPerOp) !== JSON.stringify(reference.ranPerOp)
      ) {
        failures.push(
          `seed=${seed}\n  production: ${JSON.stringify(production)}\n  reference:  ${JSON.stringify(reference)}\n  plan: ${JSON.stringify(plan)}`,
        );
      }
    }

    expect(failures.slice(0, 3).join("\n\n")).toBe("");
    setRuntimeErrorHandler(null);
  });
});

describe("known conservative deviation — write and revert inside one batch", () => {
  it("production re-runs; the value-comparing reference does not", () => {
    // Production tracks change with a monotonic version, so two writes inside a
    // batch mean "changed" even when the second restores the original value.
    // Asserted here so the deviation is a documented, tested property rather
    // than something the randomized suites quietly avoid.
    const [n, setN] = signal(0);
    let productionRuns = 0;
    const dispose = effect(() => {
      n();
      productionRuns++;
    });
    batch(() => {
      setN(3);
      setN(0);
    });
    expect(productionRuns).toBe(2); // initial + one conservative re-run
    dispose();

    const world = new ReferenceWorld();
    const ref = world.signal(0);
    let referenceRuns = 0;
    const refEffect = world.effect(() => {
      ref.read();
      referenceRuns++;
    });
    world.batch(() => {
      ref.write(3);
      ref.write(0);
    });
    expect(referenceRuns).toBe(1); // value-based: nothing observably changed
    refEffect.dispose();

    // The deviation is always in the SAFE direction: an extra run, never a
    // missed one.
    expect(productionRuns).toBeGreaterThanOrEqual(referenceRuns);
  });
});

describe("harness self-check", () => {
  it("the reference engine suppresses a stable derived (so the harness has teeth)", () => {
    // If the reference engine did NOT model stabilization, every differential
    // assertion above would pass vacuously against a non-stabilizing engine.
    // This pins the property the harness relies on.
    const world = new ReferenceWorld();
    const source = world.signal(1);
    const parity = world.derived(() => source.read() % 2);

    let runs = 0;
    const eff = world.effect(() => {
      parity.read();
      runs++;
    });

    expect(runs).toBe(1);
    source.write(3); // parity 1 -> 1
    expect(runs).toBe(1);
    source.write(2); // parity 1 -> 0
    expect(runs).toBe(2);
    eff.dispose();
  });

  it("the reference engine honours a custom comparator", () => {
    const world = new ReferenceWorld();
    const source = world.signal({ x: 1, ignored: "a" });
    const selected = world.derived<{ x: number }>(
      () => ({ x: source.read().x }),
      (a, b) => a.x === b.x,
    );

    let runs = 0;
    const eff = world.effect(() => {
      selected.read();
      runs++;
    });

    source.write({ x: 1, ignored: "b" });
    expect(runs).toBe(1);
    source.write({ x: 2, ignored: "b" });
    expect(runs).toBe(2);
    eff.dispose();
  });
});
