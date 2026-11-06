import { createRequire } from "node:module";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Two copies of the SAME built CommonJS entry point on one page — what a
// bundler materializing `sibujs` twice produces. A scope captured through one
// copy and registered on through the other (`pendingContent(scope)`) is still
// recognised as the lifecycle it captured: it holds the enter of the branch it
// was captured in, settles once, is cancelled when that lifecycle ends, and
// leaves nothing registered. Both directions, and with the directive from
// either copy. Needs a build (`npm run build`), as every dist suite.
// ---------------------------------------------------------------------------

type Core = typeof import("../index");

const require = createRequire(import.meta.url);

// A fresh page: no registry left by anything else in this worker.
for (const key of Object.getOwnPropertySymbols(globalThis)) {
  if (Symbol.keyFor(key)?.startsWith("sibujs.")) delete (globalThis as Record<symbol, unknown>)[key];
}

/** The shared readiness bookkeeping (see src/core/rendering/range.ts), read for leak checks. */
interface RangeState {
  registrations: Set<unknown>;
  listeners: Set<unknown>;
}
const rangeState = () => (globalThis as Record<symbol, unknown>)[Symbol.for("sibujs.ranges.v1")] as RangeState;

const flush = async (turns = 8) => {
  for (let i = 0; i < turns; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

let A!: Core;
let B!: Core;

beforeAll(() => {
  const path = require.resolve("sibujs");
  A = require(path) as Core;
  delete require.cache[path];
  B = require(path) as Core;
});

describe("the premise", () => {
  it("the two copies are distinct module instances of the same CommonJS entry point", () => {
    expect(require.resolve("sibujs")).toMatch(/index\.cjs$/);
    expect(A).not.toBe(B);
    expect(A.pendingContent).not.toBe(B.pendingContent);
    expect(A.lifecycleScope).not.toBe(B.lifecycleScope);
    expect(A.when).not.toBe(B.when);
  });
});

const COMBOS: ReadonlyArray<readonly [string, () => Core, () => Core, () => Core]> = [
  ["when() A, captured through B, registered through A", () => A, () => B, () => A],
  ["when() A, captured through A, registered through B", () => A, () => A, () => B],
  ["when() B, captured through A, registered through B", () => B, () => A, () => B],
  ["when() B, captured through B, registered through A", () => B, () => B, () => A],
];

describe.each(COMBOS)("%s", (_, directive, capture, register) => {
  let host!: HTMLElement;
  let registrations = 0;
  let listeners = 0;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    registrations = rangeState()?.registrations.size ?? 0;
    listeners = rangeState()?.listeners.size ?? 0;
  });

  afterEach(() => {
    A.dispose(host);
    host.remove();
    vi.restoreAllMocks();
  });

  /** Nothing registered as pending or listening is left behind. */
  const expectReleased = () => {
    expect(rangeState().registrations.size).toBe(registrations);
    expect(rangeState().listeners.size).toBe(listeners);
  };

  /**
   * A `when()` (through the directive copy) with a waiting enter, whose
   * branch captures a scope (through the capture copy) and registers pending
   * content on it (through the register copy).
   */
  function setup() {
    const W = directive();
    const [on, setOn] = W.signal(false);
    const seen: boolean[] = [];
    const enter = vi.fn(() => {
      seen.push(host.querySelector(".content") !== null);
    });
    const rec = {
      scope: null as ReturnType<Core["lifecycleScope"]> | null,
      handle: null as ReturnType<Core["pendingContent"]> | null,
    };
    let body!: HTMLElement;
    host.appendChild(
      W.when(
        on,
        () => {
          const scope = capture().lifecycleScope();
          rec.scope = scope;
          rec.handle = register().pendingContent(scope);
          body = W.div({ class: "body" }, "loading…");
          return body;
        },
        () => W.span({ class: "off" }, "off"),
        { transition: { enter, waitForContent: 2000 } },
      ),
    );
    const commit = () => {
      body.replaceChildren(W.span({ class: "content" }, "content"));
    };
    return { on, setOn, enter, seen, rec, commit };
  }

  it("the scope is the branch's: the enter waits for the registration, then runs once with the content", async () => {
    const t = setup();
    await flush();
    t.setOn(true);
    await flush();
    expect(t.rec.scope?.state()).toBe("active");
    expect(t.rec.handle?.settled).toBe(false);
    expect(t.enter).not.toHaveBeenCalled();
    t.commit();
    t.rec.handle?.done();
    expect(t.rec.handle?.settled).toBe(true);
    await flush();
    expect(t.enter).toHaveBeenCalledTimes(1);
    expect(t.seen).toEqual([true]);
    // Settled once: a second settlement changes nothing.
    t.rec.handle?.done();
    t.rec.handle?.cancel();
    await flush();
    expect(t.enter).toHaveBeenCalledTimes(1);
    expectReleased();
  });

  it("cancel() releases the enter without enrolling content", async () => {
    const t = setup();
    await flush();
    t.setOn(true);
    await flush();
    expect(t.enter).not.toHaveBeenCalled();
    t.rec.handle?.cancel();
    expect(t.rec.handle?.settled).toBe(true);
    await flush();
    expect(t.enter).toHaveBeenCalledTimes(1);
    expect(t.seen).toEqual([false]);
    t.rec.handle?.done();
    await flush();
    expect(t.enter).toHaveBeenCalledTimes(1);
    expectReleased();
  });

  it("the end of the captured lifecycle cancels the registration", async () => {
    const t = setup();
    await flush();
    t.setOn(true);
    await flush();
    expect(t.rec.handle?.settled).toBe(false);
    t.setOn(false);
    await flush();
    expect(t.rec.scope?.state()).toBe("ended");
    expect(t.rec.handle?.settled).toBe(true);
    expect(host.querySelector(".off")).not.toBeNull();
    // A registration on the ended scope, through either copy, is inert.
    expect(A.pendingContent(t.rec.scope as never).settled).toBe(true);
    expect(B.pendingContent(t.rec.scope as never).settled).toBe(true);
    expectReleased();
  });

  it("a registration on an unrelated branch's scope does not hold this enter", async () => {
    const W = directive();
    let unrelated: ReturnType<Core["lifecycleScope"]> | null = null;
    host.appendChild(
      W.when(
        () => true,
        () => {
          unrelated = capture().lifecycleScope();
          return W.span({ class: "other" }, "other");
        },
      ),
    );
    await flush();
    expect(unrelated).not.toBeNull();
    const handle = register().pendingContent(unrelated as never);
    expect(handle.settled).toBe(false);
    const [on, setOn] = W.signal(false);
    const enter = vi.fn();
    host.appendChild(
      W.when(on, () => W.div({ class: "plain" }, "plain"), { transition: { enter, waitForContent: 2000 } }),
    );
    await flush();
    setOn(true);
    await flush();
    expect(enter).toHaveBeenCalledTimes(1);
    expect(handle.settled).toBe(false);
    handle.done();
    expect(handle.settled).toBe(true);
    expectReleased();
  });

  it("a scope captured outside any render holds no enter and stays until settled", async () => {
    const scope = capture().lifecycleScope();
    expect(scope.state()).toBe("active");
    const handle = register().pendingContent(scope);
    expect(handle.settled).toBe(false);
    handle.cancel();
    expect(handle.settled).toBe(true);
    expectReleased();
  });
});
