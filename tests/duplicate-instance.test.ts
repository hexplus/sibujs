// @vitest-environment node
import { build } from "esbuild";
import { afterEach, beforeAll, describe, expect, test } from "vitest";

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

type ErrorHandler = (error: unknown, context: { phase: string; name?: string }) => void;

interface Instance {
  signal: <T>(v: T) => [() => T, (n: T | ((p: T) => T)) => void];
  reactiveBinding: (commit: () => void, ownerNode?: unknown) => () => void;
  batch: <T>(fn: () => T) => T;
  createId: (prefix?: string) => string;
  enableSSR: () => void;
  disableSSR: () => void;
  isSSR: () => boolean;
  setRuntimeErrorHandler: (handler: ErrorHandler | null) => ErrorHandler | null;
  getRuntimeErrorHandler: () => ErrorHandler | null;
  reportError: (error: unknown, context: { phase: string; name?: string }) => void;
}

const REGISTRY_KEY = Symbol.for("sibujs.reactive.v1");
const ERROR_STATE_KEY = Symbol.for("sibujs.runtime-errors.v1");

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
        export { createId } from "./src/core/rendering/createId";
        export { enableSSR, disableSSR, isSSR } from "./src/core/ssr-context";
        export { setRuntimeErrorHandler, getRuntimeErrorHandler, reportError } from "./src/core/errors";
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

describe("duplicate instance — runtime error handler", () => {
  // The handler lives in shared `globalThis` state, so it must be cleared or it
  // leaks into every later test in this file.
  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[ERROR_STATE_KEY];
  });

  test("a handler installed through instance B receives an error contained by the shared engine", () => {
    const a = loadInstance();
    const b = loadInstance();

    const received: Array<{ error: unknown; phase: string }> = [];
    // Configured through B...
    b.setRuntimeErrorHandler((error, context) => {
      received.push({ error, phase: context.phase });
    });

    // ...while the failing subscriber is created and driven through A. Only one
    // copy owns the shared reactive engine, so with module-local handler state
    // the drain would look up a null handler and the application's telemetry
    // would never fire.
    const [s, setS] = a.signal("ok");
    let runs = 0;
    const dispose = a.reactiveBinding(() => {
      const value = s();
      runs++;
      if (value === "bad") throw new Error("cross-instance boom");
    });
    expect(runs).toBe(1);

    setS("bad");

    expect(received).toHaveLength(1);
    expect((received[0].error as Error).message).toBe("cross-instance boom");
    expect(received[0].phase).toBe("binding");
    dispose();
  });

  test("works in the reverse direction — handler on A, failure driven through B", () => {
    const a = loadInstance();
    const b = loadInstance();

    const received: unknown[] = [];
    a.setRuntimeErrorHandler((error) => received.push(error));

    const [s, setS] = b.signal("ok");
    const dispose = b.reactiveBinding(() => {
      if (s() === "bad") throw new Error("reverse boom");
    });
    setS("bad");

    expect(received).toHaveLength(1);
    expect((received[0] as Error).message).toBe("reverse boom");
    dispose();
  });

  test("both instances observe the same handler state", () => {
    const a = loadInstance();
    const b = loadInstance();

    const handler: ErrorHandler = () => {};
    a.setRuntimeErrorHandler(handler);
    expect(b.getRuntimeErrorHandler()).toBe(handler);
    expect(a.getRuntimeErrorHandler()).toBe(handler);

    // Clearing through the OTHER copy must clear it for both.
    b.setRuntimeErrorHandler(null);
    expect(a.getRuntimeErrorHandler()).toBeNull();
    expect(b.getRuntimeErrorHandler()).toBeNull();
  });

  test("setRuntimeErrorHandler returns the previous handler across instances", () => {
    const a = loadInstance();
    const b = loadInstance();

    const first: ErrorHandler = () => {};
    const second: ErrorHandler = () => {};

    expect(a.setRuntimeErrorHandler(first)).toBeNull();
    // B replaces A's handler and is handed A's back.
    expect(b.setRuntimeErrorHandler(second)).toBe(first);
    expect(a.getRuntimeErrorHandler()).toBe(second);
  });

  test("only the most recently installed handler receives errors", () => {
    const a = loadInstance();
    const b = loadInstance();

    const firstCalls: unknown[] = [];
    const secondCalls: unknown[] = [];
    a.setRuntimeErrorHandler((e) => firstCalls.push(e));
    b.setRuntimeErrorHandler((e) => secondCalls.push(e));

    a.reportError(new Error("only-latest"), { phase: "effect" });

    expect(firstCalls).toHaveLength(0);
    expect(secondCalls).toHaveLength(1);
  });
});

describe("duplicate instance — other coordination singletons", () => {
  test("createId yields a continuous, non-colliding sequence across instances", () => {
    const a = loadInstance();
    const b = loadInstance();

    // A shared counter means the two copies never hand out the same id —
    // critical for a11y pairing (aria-labelledby / for+id) and SSR hydration.
    // Independent module-local counters would both start at 1 and collide.
    const ids = [a.createId("x"), b.createId("x"), a.createId("x"), b.createId("x")];
    expect(new Set(ids).size).toBe(ids.length); // all unique
  });

  test("enableSSR() in instance A is observed by isSSR() in instance B", () => {
    const a = loadInstance();
    const b = loadInstance();

    expect(b.isSSR()).toBe(false);
    a.enableSSR();
    try {
      // Split SSR state would let an effect created via instance B run on the
      // server (B still thinks it's the client), or leak request state.
      expect(b.isSSR()).toBe(true);
    } finally {
      a.disableSSR();
    }
    expect(b.isSSR()).toBe(false);
  });
});
