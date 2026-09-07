import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enhance, enhanceAll } from "../src/platform/enhance";

// ---------------------------------------------------------------------------
// A setup that returns a thenable is rejected at the primitive, not at one
// caller.
//
// The first version of this guard lived in `mountIslands`, which meant it only
// covered islands. `enhance()` and `enhanceAll()` are public and are the most
// direct way to hit the same defect: an `async` setup registers whatever
// bindings run before its first `await`, silently abandons the rest outside the
// transaction, and — because it returns normally — gets `data-sibu-enhanced`
// stamped on the root. The marker then claims an enhancement that never
// completed, which is the whole thing the marker exists to be trusted about.
//
// `enhance()` records ownership and sets the marker only after the setup
// returns, so throwing from inside the setup rolls the transaction back and
// leaves no marker behind.
// ---------------------------------------------------------------------------

let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  error = vi.spyOn(console, "error").mockImplementation(() => {});
  document.body.innerHTML = "";
});
afterEach(() => {
  error.mockRestore();
  document.body.innerHTML = "";
});

describe("enhance() rejects a setup that returns a thenable", () => {
  it("throws for an async setup and leaves no enhanced marker", () => {
    document.body.innerHTML = `<div id="r"><span data-ref="x">0</span></div>`;
    const root = document.getElementById("r") as HTMLElement;

    expect(() => enhance(root, (async () => {}) as never)).toThrow(/promise/i);
    expect(root.getAttribute("data-sibu-enhanced")).not.toBe("true");
  });

  it("names both causes so the message is actionable either way", () => {
    document.body.innerHTML = `<div id="r"></div>`;
    const root = document.getElementById("r") as HTMLElement;

    let message = "";
    try {
      enhance(root, (() => Promise.resolve()) as never);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/lazyIsland|async/i);
  });

  it("does not leave the setup's promise unhandled", async () => {
    // An unwrapped loader whose import() rejects would otherwise produce an
    // unhandled rejection on top of the error we throw: the thenable is
    // discarded at the moment we bail, with nobody left to observe it.
    document.body.innerHTML = `<div id="r"></div>`;
    const root = document.getElementById("r") as HTMLElement;

    const unhandled: unknown[] = [];
    const onUnhandled = (e: PromiseRejectionEvent | { reason?: unknown }) =>
      unhandled.push((e as { reason?: unknown }).reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      expect(() => enhance(root, (() => Promise.reject(new Error("import 404"))) as never)).toThrow();
      // Give the microtask queue and the rejection callback a chance to run.
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("still enhances a normal synchronous setup", () => {
    document.body.innerHTML = `<div id="r"><span data-ref="x">0</span></div>`;
    const root = document.getElementById("r") as HTMLElement;

    let ran = false;
    const dispose = enhance(root, () => {
      ran = true;
    });

    expect(ran).toBe(true);
    expect(root.getAttribute("data-sibu-enhanced")).toBe("true");
    dispose();
  });

  it("still honours a setup that returns a cleanup function", () => {
    document.body.innerHTML = `<div id="r"></div>`;
    const root = document.getElementById("r") as HTMLElement;

    let cleaned = false;
    const dispose = enhance(root, () => () => {
      cleaned = true;
    });
    dispose();
    expect(cleaned).toBe(true);
  });

  it("enhanceAll() rolls back rather than leaving half the collection marked", () => {
    document.body.innerHTML = `<div class="e"></div><div class="e"></div>`;
    const els = Array.from(document.querySelectorAll<HTMLElement>(".e"));

    expect(() => enhanceAll(".e", (async () => {}) as never)).toThrow(/promise/i);
    for (const el of els) {
      expect(el.getAttribute("data-sibu-enhanced")).not.toBe("true");
    }
  });
});
