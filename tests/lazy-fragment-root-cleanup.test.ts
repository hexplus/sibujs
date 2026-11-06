import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AdoptScope, inScope } from "../src/core/rendering/adoptScope";
import { when } from "../src/core/rendering/directives";
import { dispose, registerDisposer } from "../src/core/rendering/dispose";
import { span } from "../src/core/rendering/html";
import { lazy } from "../src/core/rendering/lazy";
import { pendingCount } from "../src/core/rendering/range";
import { type LifecycleScope, lifecycleScope } from "../src/core/signals/lifecycleScope";
import { signal } from "../src/core/signals/signal";
import { heldListenerCount, heldRootCount, structuralBinding } from "../src/reactivity/track-core";

// ---------------------------------------------------------------------------
// A `lazy()` component may return a DocumentFragment, with cleanup registered
// on the fragment object itself. The instance is rendered in a container (a
// fragment is no root it could be disposed with), its children moved there —
// and the fragment's own cleanup is still the instance's: it runs when the
// instance is disposed, after its children's, once. Cold, cached and adopted
// instances alike, whether the instance is inserted, held, cancelled or fails.
// ---------------------------------------------------------------------------

let host: HTMLElement;
let base = 0;
let listeners = 0;
let roots = 0;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  base = pendingCount();
  listeners = heldListenerCount();
  roots = heldRootCount();
});

afterEach(() => {
  dispose(host);
  host.remove();
  vi.restoreAllMocks();
});

const flush = async (turns = 6) => {
  for (let i = 0; i < turns; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

const adopting = (): AdoptScope => ({ p: "", n: 0, s: { on: true, el: () => null } });

/**
 * A lazy component returning a fragment of two spans; cleanup recorded on the
 * fragment and on each child, plus scoped work on `tick`.
 */
function fragmentPage(opts: { pause?: () => void; fail?: () => boolean } = {}) {
  const [tick, setTick] = signal(0);
  const log: string[] = [];
  const rec = { scopes: [] as LifecycleScope[], effectRuns: 0, watchRuns: 0, builds: 0 };
  const Page = () => {
    const n = ++rec.builds;
    const scope = lifecycleScope();
    rec.scopes.push(scope);
    scope.effect(() => {
      tick();
      rec.effectRuns++;
    });
    scope.watch(tick, () => {
      rec.watchRuns++;
    });
    const fragment = document.createDocumentFragment();
    const one = span({ class: "one" }, "one");
    const two = span({ class: "two" }, "two");
    registerDisposer(one, () => log.push(`one#${n}`));
    registerDisposer(two, () => log.push(`two#${n}`));
    fragment.append(one, two);
    registerDisposer(fragment, () => log.push(`fragment#${n}`));
    opts.pause?.();
    if (opts.fail?.()) throw new Error("page failed");
    return fragment;
  };
  const Lazy = lazy(() => Promise.resolve({ default: Page }));
  /**
   * Every instance built so far was cleaned up once — children before the
   * fragment, unless `ordered` is false — and its work stopped.
   */
  const expectCleaned = async (instances = rec.builds, ordered = true) => {
    const expected: string[] = [];
    for (let n = 1; n <= instances; n++) expected.push(`one#${n}`, `two#${n}`, `fragment#${n}`);
    expect([...log].sort()).toEqual([...expected].sort());
    for (let n = 1; n <= instances && ordered; n++) {
      const at = (name: string) => log.indexOf(`${name}#${n}`);
      expect(at("fragment")).toBeGreaterThan(at("one"));
      expect(at("fragment")).toBeGreaterThan(at("two"));
    }
    expect(rec.scopes.every((s) => s.state() === "ended")).toBe(true);
    const effects = rec.effectRuns;
    const watches = rec.watchRuns;
    setTick((v) => v + 1);
    await flush();
    expect(rec.effectRuns).toBe(effects);
    expect(rec.watchRuns).toBe(watches);
  };
  return { Lazy, log, rec, expectCleaned };
}

/** Load the module once through a cold instance, then forget that instance. */
async function warm(page: ReturnType<typeof fragmentPage>) {
  const first = page.Lazy() as HTMLElement;
  host.appendChild(first);
  await flush();
  dispose(first);
  first.remove();
  page.log.length = 0;
  page.rec.scopes.length = 0;
  page.rec.builds = 0;
}

type Mode = "cold" | "cached" | "adopted";
const modes: Mode[] = ["cold", "cached", "adopted"];

async function mount(page: ReturnType<typeof fragmentPage>, mode: Mode): Promise<HTMLElement> {
  if (mode !== "cold") await warm(page);
  const root = (mode === "adopted" ? inScope(adopting(), () => page.Lazy()) : page.Lazy()) as HTMLElement;
  host.appendChild(root);
  if (mode === "cold") await flush();
  return root;
}

describe.each(modes)("a %s fragment instance", (mode) => {
  it("is rendered in its container, the children moved there", async () => {
    const page = fragmentPage();
    const root = await mount(page, mode);
    expect(root.className).toBe("sibu-lazy");
    expect(root.textContent).toBe("onetwo");
  });

  it("disposing the container runs the fragment's cleanup after its children's, once", async () => {
    const page = fragmentPage();
    const root = await mount(page, mode);
    dispose(root);
    await page.expectCleaned(1);
    dispose(root);
    expect(page.log.length).toBe(3);
  });

  it("switching a when() branch away runs it, once", async () => {
    const page = fragmentPage();
    if (mode !== "cold") await warm(page);
    const [on, setOn] = signal(true);
    host.appendChild(
      when(
        on,
        () => (mode === "adopted" ? inScope(adopting(), () => page.Lazy()) : page.Lazy()),
        () => span({ class: "off" }, "off"),
      ),
    );
    await flush();
    expect(host.querySelector(".one")).not.toBeNull();
    setOn(false);
    await flush();
    expect(host.querySelector(".one")).toBeNull();
    await page.expectCleaned(1);
  });

  it("repeated mounts each run it once", async () => {
    const page = fragmentPage();
    if (mode !== "cold") await warm(page);
    for (let i = 0; i < 4; i++) {
      const root = (mode === "adopted" ? inScope(adopting(), () => page.Lazy()) : page.Lazy()) as HTMLElement;
      host.appendChild(root);
      await flush();
      dispose(root);
      root.remove();
    }
    await page.expectCleaned(4);
    expect(heldRootCount()).toBe(roots);
    expect(heldListenerCount()).toBeLessThanOrEqual(listeners);
    expect(pendingCount() - base).toBe(0);
  });
});

describe("a fragment instance never inserted", () => {
  function held() {
    const owner = structuralBinding(() => {});
    const page = fragmentPage({ pause: () => owner.freeze?.() });
    const root = owner.run(() => page.Lazy()) as HTMLElement;
    host.appendChild(root);
    return { owner, page, root };
  }

  it("held, then its lifecycle ends: the fragment is disposed whole, children first, once", async () => {
    const { owner, page, root } = held();
    await flush();
    expect(page.rec.builds).toBe(1);
    expect(root.querySelector(".one")).toBeNull();
    owner.stop();
    await flush();
    await page.expectCleaned(1);
    dispose(root);
    expect(page.log.length).toBe(3);
    expect(heldRootCount()).toBe(roots);
    expect(pendingCount() - base).toBe(0);
  });

  it("held, then its container is disposed: the same, once", async () => {
    const { page, root } = held();
    await flush();
    dispose(root);
    await page.expectCleaned(1);
    expect(heldRootCount()).toBe(roots);
    expect(pendingCount() - base).toBe(0);
  });

  // A failed build is rolled back in reverse registration order, the
  // fragment's cleanup with the rest (see `withDisposerRollback`).
  it("a cached component that throws: its fragment cleanup is rolled back with the rest, once", async () => {
    let failing = false;
    const page = fragmentPage({ fail: () => failing });
    await warm(page);
    failing = true;
    for (const adopt of [false, true]) {
      expect(() => (adopt ? inScope(adopting(), () => page.Lazy()) : page.Lazy())).toThrow("page failed");
    }
    await page.expectCleaned(2, false);
    expect(pendingCount() - base).toBe(0);
  });

  it("a cold component that throws: the error view shows; its fragment cleanup ran once", async () => {
    const page = fragmentPage({ fail: () => true });
    const root = page.Lazy() as HTMLElement;
    host.appendChild(root);
    await flush();
    expect(root.querySelector(".sibu-lazy-error")).not.toBeNull();
    await page.expectCleaned(1, false);
    dispose(root);
    expect(page.log.length).toBe(3);
  });
});

describe("fragments the instance does not own", () => {
  it("a fragment appended inside the component's element root keeps its caller's contract", async () => {
    const inner = vi.fn();
    const rootCleanup = vi.fn();
    const Lazy = lazy(() =>
      Promise.resolve({
        default: () => {
          const fragment = document.createDocumentFragment();
          fragment.append(span("a"));
          registerDisposer(fragment, inner);
          const root = span({ class: "root" }, "");
          root.appendChild(fragment);
          registerDisposer(root, rootCleanup);
          return root;
        },
      }),
    );
    const container = Lazy() as HTMLElement;
    host.appendChild(container);
    await flush();
    dispose(container);
    expect(rootCleanup).toHaveBeenCalledTimes(1);
    expect(inner).not.toHaveBeenCalled();
  });
});
