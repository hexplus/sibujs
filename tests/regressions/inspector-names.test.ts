import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { derived } from "../../src/core/signals/derived";
import { effect } from "../../src/core/signals/effect";
import { signal } from "../../src/core/signals/signal";
import { getActiveDevTools, initDevTools } from "../../src/devtools/devtools";

// This file's name deliberately avoids the words the stack filter skips
// ("signal", "devtools", "effect" ...): a frame whose path holds one is ignored,
// which would hide the enclosing function these tests look for.

type Node = { name: string; type: string };
type Hook = { emit: (event: string, payload: unknown) => void; nodes: Map<number, Node> };

const hook = () => (globalThis as unknown as Record<string, Hook>).__SIBU_DEVTOOLS_GLOBAL_HOOK__;
const lastNode = () => [...hook().nodes.values()].at(-1) as Node;

function cleanup(): void {
  getActiveDevTools()?.destroy();
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.__SIBU_DEVTOOLS_GLOBAL_HOOK__;
  delete g.__SIBU__;
}

beforeEach(cleanup);
afterEach(cleanup);

/** Run `fn` with `new Error().stack` returning exactly these frames. */
function withStack(frames: string[], fn: () => void): void {
  const RealError = globalThis.Error;
  function FakeError() {
    return { stack: ["Error", ...frames.map((f) => `    at ${f}`)].join("\n") };
  }
  (globalThis as unknown as { Error: unknown }).Error = FakeError;
  try {
    fn();
  } finally {
    (globalThis as unknown as { Error: unknown }).Error = RealError;
  }
}

// What Chromium reports when the runtime and the app share one bundled file, so
// no frame's path holds a word the filter skips.
const bundleFrames = (caller: string) => [
  "inferName (http://localhost/bundle.js:1:1)",
  "http://localhost/bundle.js:2:2",
  "Map.forEach (<anonymous>)",
  "Object.emit (http://localhost/bundle.js:3:3)",
  "emitDevtools (http://localhost/bundle.js:4:4)",
  "signal (http://localhost/bundle.js:5:5)",
  caller,
];

const createdFrom = (caller: string): string => {
  initDevTools();
  withStack(bundleFrames(caller), () => hook().emit("signal:create", { signal: { value: 1, __sc: 0 }, initial: 1 }));
  return lastNode().name;
};

describe("devtools names what the application named", () => {
  it("uses the name given to signal()", () => {
    initDevTools();
    signal(0, { name: "count" });
    expect(lastNode()).toMatchObject({ type: "signal", name: "count" });
  });

  it("uses the name given to derived()", () => {
    initDevTools();
    derived(() => 1, { name: "doubled" });
    expect(lastNode()).toMatchObject({ type: "computed", name: "doubled" });
  });

  it("prefers the given name over the call stack in a single-file bundle", () => {
    initDevTools();
    withStack(bundleFrames("App (http://localhost/bundle.js:6:6)"), () =>
      hook().emit("signal:create", { signal: { value: 1, __sc: 0 }, name: "count", initial: 1 }),
    );
    expect(lastNode().name).toBe("count");
  });
});

describe("devtools infers a name from the application's own frame", () => {
  it("names an unnamed signal after its enclosing function", () => {
    initDevTools();
    function CounterStore() {
      signal(0);
    }
    CounterStore();
    expect(lastNode().name).toBe("CounterStore");
  });

  it("names an unnamed effect after its enclosing function", () => {
    initDevTools();
    let stop = () => {};
    function Watcher() {
      stop = effect(() => {});
    }
    Watcher();
    const name = lastNode().name;
    stop();
    expect(name).toBe("Watcher");
  });

  it("skips its own frame and the listener in a single-file bundle", () => {
    expect(createdFrom("App (http://localhost/bundle.js:6:6)")).toBe("App");
  });

  it("names a constructor, not the word new", () => {
    expect(createdFrom("new Store (http://localhost/bundle.js:6:6)")).toBe("Store");
  });

  it("handles an async caller", () => {
    expect(createdFrom("async load (http://localhost/bundle.js:6:6)")).toBe("load");
  });

  it("falls back to the file name for an anonymous caller, not the URL scheme", () => {
    expect(createdFrom("http://localhost/bundle.js:6:6")).toBe("bundle");
  });

  it("ignores an empty name", () => {
    initDevTools();
    withStack(bundleFrames("App (http://localhost/bundle.js:6:6)"), () =>
      hook().emit("signal:create", { signal: { value: 1, __sc: 0 }, name: "", initial: 1 }),
    );
    expect(lastNode().name).toBe("App");
  });
});
