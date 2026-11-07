import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AdoptScope, inScope } from "../src/core/rendering/adoptScope";
import { dispose } from "../src/core/rendering/dispose";
import { div, span } from "../src/core/rendering/html";
import { lazy } from "../src/core/rendering/lazy";
import { pendingCount } from "../src/core/rendering/range";
import { type LifecycleScope, lifecycleScope } from "../src/core/signals/lifecycleScope";
import { signal } from "../src/core/signals/signal";
import { heldListenerCount, heldRootCount, structuralBinding } from "../src/reactivity/track-core";

// ---------------------------------------------------------------------------
// Every `lazy()` instance has the same lifetime, whether its module was loaded
// already (rendered synchronously, or in the container under adoption) or not:
// built under its own lifecycle nested in its parent's, paused with the
// parent, and ended — scoped effects and watches disposed — when the instance
// is disposed, while the parent lives on.
// ---------------------------------------------------------------------------

let host: HTMLElement;
let base = 0;
let listeners = 0;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  base = pendingCount();
  listeners = heldListenerCount();
});

afterEach(() => {
  dispose(host);
  host.remove();
  vi.restoreAllMocks();
});

const flush = async (turns = 6) => {
  for (let i = 0; i < turns; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

// An adoption scope whose sink claims nothing: builders create elements
// normally, but `lazy()` takes its adoption path.
const adopting = (): AdoptScope => ({ p: "", n: 0, s: { on: true, el: () => null } });

/** A lazy component that captures a scope with a scoped effect and watch on `tick`. */
function instrumented() {
  const [tick, setTick] = signal(0);
  const record = { scopes: [] as LifecycleScope[], effectRuns: 0, watchRuns: 0, fail: false };
  const Page = () => {
    const scope = lifecycleScope();
    record.scopes.push(scope);
    scope.effect(() => {
      tick();
      record.effectRuns++;
    });
    scope.watch(tick, () => {
      record.watchRuns++;
    });
    if (record.fail) throw new Error("page failed");
    return span({ class: "page" }, "page");
  };
  const Lazy = lazy(() => Promise.resolve({ default: Page }));
  return { Lazy, setTick, record };
}

type Mode = "cold" | "cached" | "adopted";

/** Render one instance of `Lazy` in `parent`'s lifecycle, as `mode` asks. */
async function render(Lazy: () => Node, parent: ReturnType<typeof structuralBinding>, mode: Mode) {
  const root = parent.run(() => (mode === "adopted" ? inScope(adopting(), () => Lazy()) : Lazy()));
  host.appendChild(root);
  if (mode === "cold") await flush();
  return root;
}

async function warmed() {
  const page = instrumented();
  // Load the module once (a cold instance), then drop that instance.
  const first = await render(
    page.Lazy,
    structuralBinding(() => {}),
    "cold",
  );
  dispose(first);
  page.record.scopes.length = 0;
  page.record.effectRuns = 0;
  page.record.watchRuns = 0;
  return page;
}

describe.each<Mode>(["cold", "cached", "adopted"])("a %s instance", (mode) => {
  const setup = async () => (mode === "cold" ? instrumented() : await warmed());

  it("renders the expected shape", async () => {
    const { Lazy } = await setup();
    const root = (await render(
      Lazy,
      structuralBinding(() => {}),
      mode,
    )) as HTMLElement;
    if (mode === "cached") expect(root.className).toBe("page");
    else {
      expect(root.className).toBe("sibu-lazy");
      expect(root.querySelector(".page")).not.toBeNull();
    }
  });

  it("is disposed with its root while the parent lives on: scope ended, effect and watch released", async () => {
    const { Lazy, setTick, record } = await setup();
    const parent = structuralBinding(() => {});
    const root = await render(Lazy, parent, mode);
    const [scope] = record.scopes;
    expect(scope.state()).toBe("active");
    setTick(1);
    await flush();
    expect(record.effectRuns).toBe(2);
    expect(record.watchRuns).toBe(1);
    dispose(root);
    expect(scope.state()).toBe("ended");
    setTick(2);
    await flush();
    expect(record.effectRuns).toBe(2);
    expect(record.watchRuns).toBe(1);
    // The parent is untouched.
    expect(parent.run(() => lifecycleScope()).state()).toBe("active");
  });

  it("pauses and resumes with its parent", async () => {
    const { Lazy, setTick, record } = await setup();
    const parent = structuralBinding(() => {});
    await render(Lazy, parent, mode);
    const [scope] = record.scopes;
    parent.freeze?.();
    expect(scope.state()).toBe("paused");
    setTick(1);
    setTick(2);
    await flush();
    expect(record.effectRuns).toBe(1);
    parent.thaw?.();
    await flush();
    expect(scope.state()).toBe("active");
    expect(record.effectRuns).toBe(2);
    expect(record.watchRuns).toBe(1);
  });

  it("ends with its parent", async () => {
    const { Lazy, record } = await setup();
    const parent = structuralBinding(() => {});
    await render(Lazy, parent, mode);
    parent.stop();
    expect(record.scopes[0].state()).toBe("ended");
  });

  it("repeated mount and dispose leaves nothing behind", async () => {
    const { Lazy, setTick, record } = await setup();
    const parent = structuralBinding(() => {});
    for (let i = 0; i < 5; i++) dispose(await render(Lazy, parent, mode));
    expect(record.scopes.every((s) => s.state() === "ended")).toBe(true);
    const runs = record.effectRuns;
    setTick(9);
    await flush();
    expect(record.effectRuns).toBe(runs);
    expect(heldListenerCount()).toBeLessThanOrEqual(listeners);
    expect(heldRootCount()).toBe(0);
    expect(pendingCount() - base).toBe(0);
  });
});

describe("a cached factory that throws", () => {
  it.each<Mode>([
    "cached",
    "adopted",
  ])("%s: propagates; its scope ends and its registrations are rolled back", async (mode) => {
    const { Lazy, setTick, record } = await warmed();
    record.fail = true;
    const parent = structuralBinding(() => {});
    for (let i = 0; i < 3; i++) {
      expect(() => parent.run(() => (mode === "adopted" ? inScope(adopting(), () => Lazy()) : Lazy()))).toThrow(
        "page failed",
      );
    }
    expect(record.scopes.every((s) => s.state() === "ended")).toBe(true);
    const runs = record.effectRuns;
    setTick(1);
    await flush();
    expect(record.effectRuns).toBe(runs);
    expect(heldListenerCount()).toBeLessThanOrEqual(listeners);
    expect(pendingCount() - base).toBe(0);
  });

  it("cold: shows the error view; the instance's scope ends at once", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { Lazy, record } = instrumented();
    record.fail = true;
    const root = (await render(
      Lazy,
      structuralBinding(() => {}),
      "cold",
    )) as HTMLElement;
    expect(root.querySelector(".sibu-lazy-error")).not.toBeNull();
    expect(record.scopes[0].state()).toBe("ended");
  });
});

describe("a cached component returning a fragment", () => {
  it("is rendered in a container its lifetime is tied to", async () => {
    let scope!: LifecycleScope;
    const Lazy = lazy(() =>
      Promise.resolve({
        default: () => {
          scope = lifecycleScope();
          const fragment = document.createDocumentFragment();
          fragment.append(span("one"), span("two"));
          return fragment;
        },
      }),
    );
    dispose(
      await render(
        Lazy,
        structuralBinding(() => {}),
        "cold",
      ),
    );
    const root = Lazy() as HTMLElement;
    host.appendChild(root);
    expect(root.className).toBe("sibu-lazy");
    expect(root.textContent).toBe("onetwo");
    dispose(root);
    expect(scope.state()).toBe("ended");
  });
});

describe("caller-owned roots", () => {
  it("a cached instance's root keeps its own disposers; disposing it ends the instance only", async () => {
    const outer = div();
    let scope!: LifecycleScope;
    const Lazy = lazy(() =>
      Promise.resolve({
        default: () => {
          scope = lifecycleScope();
          return span("x");
        },
      }),
    );
    dispose(
      await render(
        Lazy,
        structuralBinding(() => {}),
        "cold",
      ),
    );
    const root = Lazy() as HTMLElement;
    outer.append(root);
    host.append(outer);
    dispose(outer);
    expect(scope.state()).toBe("ended");
  });
});
