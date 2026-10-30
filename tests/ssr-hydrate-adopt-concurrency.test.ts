import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientOnly } from "../src/core/rendering/clientOnly";
import { div, p, span } from "../src/core/rendering/html";
import {
  afterHydration,
  type HydrationSession,
  hydrationOwners,
  isHydrating,
} from "../src/core/rendering/hydrationHooks";
import { lazy } from "../src/core/rendering/lazy";
import { islandComponent } from "../src/platform/componentIsland";
import type { AdoptResult } from "../src/platform/hydrateAdopt";
import { mountIslands, registerIsland, unregisterIsland } from "../src/platform/islands";
import { hydrate, island } from "../src/platform/ssr";
import { renderToStringAsync } from "../src/platform/ssrAsync";

// Concurrent adopting hydrations (islands activating together, or several
// roots) each run their own session. Completion is observed through promises
// the tests control; every wait is bounded by a generous watchdog, so a lost
// wake-up fails the test instead of hanging it, and no assertion depends on a
// narrow timing window. Hydration timeouts are set far above the watchdog
// wherever a test expects completion from settled work rather than a timeout.

const LONG = 60_000;
const WATCHDOG = 5_000;

type Mod = { default: () => HTMLElement };

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Settle within the watchdog, or fail. */
async function within<T>(promise: Promise<T>, ms = WATCHDOG): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`watchdog: not settled within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, watchdog]);
  } finally {
    clearTimeout(timer);
  }
}

/** Whether `promise` has settled, observed without waiting for it. */
function track<T>(promise: Promise<T>): { readonly done: boolean; promise: Promise<T> } {
  const state = { done: false, promise };
  promise.then(
    () => {
      state.done = true;
    },
    () => {
      state.done = true;
    },
  );
  return state;
}

/** A few macrotasks: long enough for any settled work to propagate. */
const turns = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

/**
 * A lazy component the server renders at once and the browser loads when the
 * test says so (`load`), or never (`never: true`).
 */
function lazyPair(cls: string, never = false) {
  const Comp = () => p({ class: cls }, cls);
  const chunk = deferred<Mod>();
  return {
    server: lazy<HTMLElement>(() => Promise.resolve({ default: Comp })),
    client: lazy<HTMLElement>(() => (never ? new Promise<Mod>(() => {}) : chunk.promise)),
    load: () => chunk.resolve({ default: Comp }),
  };
}

const sessionSlot = () =>
  (globalThis as unknown as Record<symbol, { a: Set<HydrationSession>; c: HydrationSession | null }>)[
    Symbol.for("sibujs.hydration.v2")
  ];

const containers: HTMLElement[] = [];

async function serverRoot(app: () => Node): Promise<HTMLElement> {
  const { html } = await renderToStringAsync(app, { hydration: "adopt" });
  const c = document.createElement("div");
  c.innerHTML = html;
  document.body.appendChild(c);
  containers.push(c);
  return c;
}

/** A root holding one lazy component; returns the server root and a hydration starter. */
async function lazyRoot(
  cls: string,
  opts: { never?: boolean; timeout?: number; onSession?: (s: HydrationSession) => void } = {},
) {
  const pair = lazyPair(cls, opts.never);
  const container = await serverRoot(() => div({ class: `root-${cls}` }, [pair.server()]));
  const serverNode = container.querySelector(`.${cls}`);
  const start = () =>
    track(
      hydrate(
        () => {
          const [own] = hydrationOwners();
          opts.onSession?.(own);
          return div({ class: `root-${cls}` }, [pair.client()]);
        },
        container,
        { strategy: "adopt", timeout: opts.timeout ?? LONG },
      ),
    );
  return { container, serverNode, load: pair.load, start };
}

afterEach(() => {
  for (const c of containers.splice(0)) c.remove();
  vi.restoreAllMocks();
});

/** The shared runtime state is back to idle. */
function expectIdle(): void {
  expect(isHydrating()).toBe(false);
  expect(sessionSlot().a.size).toBe(0);
  expect(sessionSlot().c).toBeNull();
}

describe("concurrent adopting hydrations", () => {
  it("two roots: each completes when its OWN lazy chunk lands, not when the other's does", async () => {
    const a = await lazyRoot("a");
    const b = await lazyRoot("b");
    const ha = a.start();
    const hb = b.start();
    await turns();
    expect(ha.done).toBe(false);
    expect(hb.done).toBe(false);

    a.load();
    const ra = (await within(ha.promise)) as AdoptResult;
    // B's chunk is still loading: B must still be waiting, A must not have been held by it.
    expect(hb.done).toBe(false);
    expect(ra.mismatches).toEqual([]);
    expect(a.container.querySelector(".a")).toBe(a.serverNode);
    expect(isHydrating()).toBe(true);

    b.load();
    const rb = (await within(hb.promise)) as AdoptResult;
    expect(rb.mismatches).toEqual([]);
    expect(b.container.querySelector(".b")).toBe(b.serverNode);
    expectIdle();
  });

  it("the reverse completion order behaves the same", async () => {
    const a = await lazyRoot("a");
    const b = await lazyRoot("b");
    const ha = a.start();
    const hb = b.start();
    await turns();

    b.load();
    await within(hb.promise);
    expect(ha.done).toBe(false);

    a.load();
    const ra = (await within(ha.promise)) as AdoptResult;
    expect(ra.mismatches).toEqual([]);
    expect(a.container.querySelector(".a")).toBe(a.serverNode);
    expectIdle();
  });

  it("several hydrations complete one by one, each as its own work settles", async () => {
    const roots = await Promise.all(["r0", "r1", "r2", "r3", "r4"].map((c) => lazyRoot(c)));
    const runs = roots.map((r) => r.start());
    await turns();
    for (const order of [3, 0, 4, 1, 2]) {
      roots[order].load();
      const result = (await within(runs[order].promise)) as AdoptResult;
      expect(result.mismatches).toEqual([]);
      expect(roots[order].container.querySelector(`.r${order}`)).toBe(roots[order].serverNode);
      // Every hydration whose chunk has not landed is still waiting.
      runs.forEach((run, i) => {
        if (!roots[i].container.hasAttribute("data-sibu-hydrated")) expect(run.done).toBe(false);
      });
    }
    expectIdle();
  });

  it("a fast hydration completes while another's lazy import never resolves", async () => {
    const fast = await lazyRoot("fast");
    const stuck = await lazyRoot("stuck", { never: true, timeout: 400 });
    const hs = stuck.start();
    const hf = fast.start();
    await turns();

    fast.load();
    const rf = (await within(hf.promise)) as AdoptResult;
    expect(rf.mismatches).toEqual([]);
    expect(hs.done).toBe(false);
    // The stuck one still ends, through its own timeout.
    await within(hs.promise);
    expectIdle();
  });

  it("one hydration timing out does not disturb another finishing normally after it", async () => {
    const late = lazyPair("late");
    const contentRuns = vi.fn(() => span({ class: "co" }, "client"));
    const app = (L: () => HTMLElement) => () => div({ class: "root-late" }, [L(), ClientOnly(contentRuns)]);
    const lateContainer = await serverRoot(app(late.server));
    const lateNode = lateContainer.querySelector(".late");
    const stuck = await lazyRoot("stuck2", { never: true, timeout: 50 });
    const hs = stuck.start();
    const hl = track(hydrate(app(late.client), lateContainer, { strategy: "adopt", timeout: LONG }));

    // The stuck one times out first, while the late one is still open.
    await within(hs.promise);
    expect(hl.done).toBe(false);
    expect(isHydrating()).toBe(true);
    expect(contentRuns).not.toHaveBeenCalled();

    late.load();
    const r = (await within(hl.promise)) as AdoptResult;
    expect(r.mismatches).toEqual([]);
    expect(lateContainer.querySelector(".late")).toBe(lateNode);
    expect(contentRuns).toHaveBeenCalledTimes(1);
    expectIdle();
  });

  it("a hydration opened inside another's build is its child: the parent waits for it", async () => {
    const inner = lazyPair("inner");
    const innerContainer = await serverRoot(() => div({ class: "root-inner" }, [inner.server()]));
    const innerServerNode = innerContainer.querySelector(".inner");
    const outerContainer = await serverRoot(() => div({ class: "root-outer" }, [p("outer")]));
    const innerContent = vi.fn(() => span("inner-client"));
    let innerRun: { readonly done: boolean; promise: Promise<unknown> } | null = null;
    let innerSession: HydrationSession | undefined;
    let outerSession: HydrationSession | undefined;

    const outer = track(
      hydrate(
        () => {
          [outerSession] = hydrationOwners();
          innerRun = track(
            hydrate(
              () => {
                [innerSession] = hydrationOwners();
                return div({ class: "root-inner" }, [inner.client(), ClientOnly(innerContent)]);
              },
              innerContainer,
              { strategy: "adopt", timeout: LONG },
            ),
          );
          return div({ class: "root-outer" }, [p("outer")]);
        },
        outerContainer,
        { strategy: "adopt", timeout: LONG },
      ),
    );
    await turns();
    expect(innerSession).toBeDefined();
    expect(innerSession?.up).toBe(outerSession);
    // The outer root has nothing of its own pending, yet waits for its child.
    expect(outer.done).toBe(false);

    inner.load();
    await within((innerRun as unknown as { promise: Promise<unknown> }).promise);
    await within(outer.promise);
    expect(innerContainer.querySelector(".inner")).toBe(innerServerNode);
    // The child's end callbacks ran once, at the end of the outermost session.
    expect(innerContent).toHaveBeenCalledTimes(1);
    expectIdle();
  });

  it("runs each root's ClientOnly content once, when that root ends; an unattributed callback once, after all", async () => {
    const a = lazyPair("ca");
    const b = lazyPair("cb");
    const aContent = vi.fn(() => span({ class: "a-client" }, "a"));
    const bContent = vi.fn(() => span({ class: "b-client" }, "b"));
    const appA = (L: () => HTMLElement) => () => div([L(), ClientOnly(aContent, { fallback: () => span("fa") })]);
    const appB = (L: () => HTMLElement) => () => div([L(), ClientOnly(bContent, { fallback: () => span("fb") })]);
    const ca = await serverRoot(appA(a.server));
    const cb = await serverRoot(appB(b.server));
    const ha = track(hydrate(appA(a.client), ca, { strategy: "adopt", timeout: LONG }));
    const hb = track(hydrate(appB(b.client), cb, { strategy: "adopt", timeout: LONG }));
    await turns();
    // Registered outside any hydration's code: waits for every open session.
    const both = vi.fn();
    afterHydration(both);

    a.load();
    await within(ha.promise);
    expect(aContent).toHaveBeenCalledTimes(1);
    expect(ca.querySelector(".a-client")).not.toBeNull();
    expect(bContent).not.toHaveBeenCalled();
    expect(cb.querySelector(".b-client")).toBeNull();
    expect(both).not.toHaveBeenCalled();

    b.load();
    await within(hb.promise);
    expect(bContent).toHaveBeenCalledTimes(1);
    expect(both).toHaveBeenCalledTimes(1);
    await turns();
    expect(aContent).toHaveBeenCalledTimes(1);
    expect(bContent).toHaveBeenCalledTimes(1);
    expectIdle();
  });

  it("a hydration whose build throws closes only its own session", async () => {
    const ok = await lazyRoot("ok");
    const broken = await serverRoot(() => div([p("x")]));
    const hok = ok.start();
    const failure = track(
      hydrate(
        () => {
          throw new Error("render failed");
        },
        broken,
        { strategy: "adopt", timeout: LONG },
      ),
    );
    await expect(within(failure.promise)).rejects.toThrow("render failed");
    // The failed one left nothing behind; the other is still open and waiting.
    expect(broken.querySelector("[data-sibu-h]")).not.toBeNull();
    expect(isHydrating()).toBe(true);
    expect(sessionSlot().a.size).toBe(1);
    expect(hok.done).toBe(false);

    ok.load();
    const r = (await within(hok.promise)) as AdoptResult;
    expect(r.mismatches).toEqual([]);
    expectIdle();
  });

  it("a throwing end callback does not keep the others from running", async () => {
    const root = await lazyRoot("cb-throw");
    const later = vi.fn();
    const run = track(
      hydrate(
        () => {
          afterHydration(() => {
            throw new Error("callback failed");
          });
          afterHydration(later);
          return div({ class: "root-cb-throw" }, [p("x")]);
        },
        root.container,
        { strategy: "adopt", timeout: LONG },
      ),
    );
    await expect(within(run.promise)).rejects.toThrow("callback failed");
    expect(later).toHaveBeenCalledTimes(1);
    expectIdle();
  });

  it("leaves no waiter, timer, pending entry or open session behind", async () => {
    const sessions: HydrationSession[] = [];
    const a = await lazyRoot("la", { onSession: (s) => sessions.push(s) });
    const b = await lazyRoot("lb", { onSession: (s) => sessions.push(s), never: true, timeout: 100 });
    const setSpy = vi.spyOn(globalThis, "setTimeout");
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const ha = a.start();
    const hb = b.start();
    await turns();
    a.load();
    await within(ha.promise);
    await within(hb.promise);

    expect(sessions).toHaveLength(2);
    for (const s of sessions) {
      expect(s.open).toBe(false);
      expect(s.wake.size).toBe(0);
      expect(s.pending.size).toBe(0);
      expect(s.done).toEqual([]);
      expect(s.up).toBeNull();
    }
    // Every waiter timer (the long A one and the short B one) was cleared or fired.
    const waiterTimers = setSpy.mock.calls
      .map((call, i) => ({ delay: Number(call[1] ?? 0), id: setSpy.mock.results[i].value }))
      .filter((t) => t.delay >= 50 && t.delay !== WATCHDOG);
    expect(waiterTimers.length).toBeGreaterThan(0);
    const cleared = new Set(clearSpy.mock.calls.map((c) => c[0]));
    for (const t of waiterTimers) {
      if (t.delay > 1000) expect(cleared.has(t.id)).toBe(true);
    }
    expectIdle();
  });
});

describe("concurrent component islands", () => {
  afterEach(() => {
    unregisterIsland("fast-island");
    unregisterIsland("slow-island");
  });

  function islandPage(fastL: () => HTMLElement, slowL: () => HTMLElement) {
    const Fast = () => div({ class: "fast-root" }, [fastL()]);
    const Slow = () => div({ class: "slow-root" }, [slowL()]);
    return {
      Fast,
      Slow,
      page: () =>
        div([island("fast-island", Fast, null, { load: "load" }), island("slow-island", Slow, null, { load: "load" })]),
    };
  }

  async function setup() {
    const fast = lazyPair("fast-c");
    const slow = lazyPair("slow-c");
    const server = islandPage(fast.server, slow.server);
    const { html } = await renderToStringAsync(server.page);
    const root = document.createElement("div");
    root.innerHTML = html;
    document.body.appendChild(root);
    containers.push(root);
    const client = islandPage(fast.client, slow.client);
    registerIsland("fast-island", islandComponent(client.Fast));
    registerIsland("slow-island", islandComponent(client.Slow));
    const fastEl = root.querySelector('[data-sibu-island="fast-island"]') as HTMLElement;
    const slowEl = root.querySelector('[data-sibu-island="slow-island"]') as HTMLElement;
    return { root, fast, slow, fastEl, slowEl };
  }

  /** Resolves once the island's adopting hydration has ended. */
  const adopted = (el: Element) =>
    new Promise<void>((resolve) => {
      const check = () => {
        if (el.getAttribute("data-sibu-hydrated") === "adopt") {
          observer.disconnect();
          resolve();
        }
      };
      const observer = new MutationObserver(check);
      observer.observe(el, { attributes: true, attributeFilter: ["data-sibu-hydrated"] });
      check();
    });

  it("activates both through mountIslands; the fast island ends without waiting for the slow one", async () => {
    const { root, fast, slow, fastEl, slowEl } = await setup();
    const fastNode = fastEl.querySelector(".fast-c");
    const slowNode = slowEl.querySelector(".slow-c");
    const cleanup = mountIslands(root);
    await turns();
    // Both are activated and both hydrations are open at once.
    expect(fastEl.getAttribute("data-sibu-enhanced")).toBe("true");
    expect(slowEl.getAttribute("data-sibu-enhanced")).toBe("true");
    expect(sessionSlot().a.size).toBe(2);

    fast.load();
    await within(adopted(fastEl));
    expect(slowEl.getAttribute("data-sibu-hydrated")).not.toBe("adopt");
    expect(fastEl.querySelector(".fast-c")).toBe(fastNode);

    slow.load();
    await within(adopted(slowEl));
    expect(slowEl.querySelector(".slow-c")).toBe(slowNode);
    expectIdle();
    cleanup();
  });

  it("an island disposed while its hydration is pending is released safely when it ends", async () => {
    const { root, fast, slow, fastEl, slowEl } = await setup();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const cleanup = mountIslands(root);
    await turns();
    cleanup();
    fast.load();
    slow.load();
    await within(adopted(fastEl));
    await within(adopted(slowEl));
    await turns();
    expect(error).not.toHaveBeenCalled();
    expectIdle();
  });
});
