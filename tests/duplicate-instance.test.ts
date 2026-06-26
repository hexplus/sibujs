// @vitest-environment node
import { build } from "esbuild";
import { beforeAll, describe, expect, test } from "vitest";

// ---------------------------------------------------------------------------
// Duplicate-module-instance resilience.
//
// Under bundler dependency pre-bundling (Vite optimizeDeps / esbuild), the
// reactive core module can be materialized TWICE on one page — once with the
// optimizer's `?v=<hash>` query and once raw. Each copy gets its own
// module-scoped state (currentSubscriber, pendingQueue, nodePool, batch
// depth, ...), so a `signal()` write routed through copy A never reaches a
// binding that tracked itself through copy B. Reactivity silently dies.
//
// We reproduce that here without a real bundler: esbuild bundles the reactive
// core into a self-contained CommonJS string, and we evaluate it TWICE. Each
// evaluation gets a fresh module scope (two reactive "worlds") while sharing
// the same `globalThis` — exactly the shape of the Vite duplication. The fix
// (shared state behind `Symbol.for`) makes the two worlds coordinate; without
// it, these tests fail.
// ---------------------------------------------------------------------------

interface Instance {
  signal: <T>(v: T) => [() => T, (n: T | ((p: T) => T)) => void];
  reactiveBinding: (commit: () => void) => () => void;
  batch: <T>(fn: () => T) => T;
}

const REGISTRY_KEY = Symbol.for("sibujs.reactive.v1");

let bundleCode = "";

function loadInstance(): Instance {
  const module = { exports: {} as Record<string, unknown> };
  // eslint-disable-next-line no-new-func
  const fn = new Function("module", "exports", "require", bundleCode);
  fn(module, module.exports, require);
  return module.exports as unknown as Instance;
}

beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `
        export { signal } from "./src/core/signals/signal";
        export { reactiveBinding } from "./src/reactivity/track";
        export { batch } from "./src/reactivity/batch";
      `,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    logLevel: "silent",
  });
  bundleCode = result.outputFiles[0].text;
});

describe("duplicate reactive runtime instances", () => {
  test("two evaluations produce genuinely separate module instances", () => {
    const a = loadInstance();
    const b = loadInstance();
    // Different function identities prove two independent module scopes.
    expect(a.signal).not.toBe(b.signal);
  });

  test("a signal from instance A drives a reactiveBinding from instance B", () => {
    const a = loadInstance();
    const b = loadInstance();

    const [s, setS] = a.signal("A");
    let observed: string | null = null;
    const dispose = b.reactiveBinding(() => {
      observed = s();
    });

    // Initial run establishes the dependency edge.
    expect(observed).toBe("A");

    // The write goes through instance A's notify path; the binding tracked
    // itself through instance B. With split state this update is lost.
    setS("B");
    expect(observed).toBe("B");

    dispose();
  });

  test("batch() in instance A coalesces a signal driving a binding in instance B", () => {
    const a = loadInstance();
    const b = loadInstance();

    const [s, setS] = a.signal(0);
    let runs = 0;
    let observed = 0;
    b.reactiveBinding(() => {
      runs++;
      observed = s();
    });

    const runsAfterInit = runs;
    a.batch(() => {
      setS(1);
      setS(2);
      setS(3);
    });

    // Shared batch depth + pending set: the three writes coalesce into a
    // single re-run of the cross-instance binding, which observes the final
    // value. Split batch state would either miss the update or re-run thrice.
    expect(observed).toBe(3);
    expect(runs - runsAfterInit).toBe(1);
  });

  test("warns exactly once per duplicate-instance scenario, gated by dev", () => {
    // Reset the shared registry so the very next load is treated as the
    // first (creating) instance and the one after as the duplicate.
    delete (globalThis as Record<symbol, unknown>)[REGISTRY_KEY];

    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(String(args[0]));
    };
    try {
      loadInstance(); // creates the registry — no warning
      loadInstance(); // duplicate — warns once
      loadInstance(); // duplicate again — guarded, no second warning
    } finally {
      console.warn = original;
    }

    const dupWarnings = warnings.filter((w) => w.includes("Multiple instances of the reactive runtime"));
    expect(dupWarnings).toHaveLength(1);
  });
});
