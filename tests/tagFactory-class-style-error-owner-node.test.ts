import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../src/components/ErrorBoundary";
import { type RuntimeErrorContext, setRuntimeErrorHandler } from "../src/core/errors";
import { dispose } from "../src/core/rendering/dispose";
import { div } from "../src/core/rendering/html";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";
import { getSubscriberCount, inspectSignal } from "../src/devtools/introspect";
import { forEachSubscriber } from "../src/reactivity/track";

// ---------------------------------------------------------------------------
// Owner-node metadata for reactive `class` / `style` bindings created by
// tagFactory.
//
// THE DEFECT: `applyClass` / `applyStyle` registered their commits with a bare
// `track(commit)`. A one-argument `track` delegates to `reactiveBinding(commit)`
// — the same self-retracking subscriber a two-argument call builds, correctly
// stamped `_errorPhase = "binding"` — but with NO owner node, so `_errorNode`
// stayed `undefined`. When such a getter threw on a LATER scheduled run, the
// drain reported it with `node: undefined`; `reportError` then had no DOM
// position to dispatch its boundary-propagation event from, so the nearest
// enclosing `ErrorBoundary` could never be located and the failure fell straight
// through to the global runtime handler / console. Every other reactive
// attribute goes through `bindAttribute`, which passes the element, so class
// and style were the only reactive props with unroutable errors.
//
// Baseline (commit 6a87ced, before the fix) for all four affected forms:
//     context.phase === "binding"   ✓ already correct
//     context.node  === undefined   ✗ the defect
// and a class getter failing inside a MOUNTED ErrorBoundary rendered no
// fallback while the global handler was called once.
//
// The fix passes the owning element: `reactiveBinding(commit, el)`. These tests
// pin the metadata, the boundary routing it unlocks, the unchanged disposal
// behaviour, and — critically — that carrying a node does NOT make an unclaimed
// error disappear.
// ---------------------------------------------------------------------------

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

let host: HTMLElement | null = null;

function mount(node: Node): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  container.appendChild(node);
  host = container;
  return container;
}

afterEach(() => {
  setRuntimeErrorHandler(null);
  host?.remove();
  host = null;
  vi.restoreAllMocks();
});

/** Collect every (error, context) pair the runtime handler receives. */
function capture(): Array<{ error: unknown; context: RuntimeErrorContext }> {
  const reports: Array<{ error: unknown; context: RuntimeErrorContext }> = [];
  setRuntimeErrorHandler((error, context) => reports.push({ error, context }));
  return reports;
}

// The four affected forms, each as a factory that builds an element whose
// reactive class/style getter succeeds initially and throws once `setBad()` is
// called. `runs` counts getter evaluations so disposal can be proven.
interface Form {
  name: string;
  /** The commit target the failing getter writes to, for "value survives" checks. */
  read: (el: Element) => string | null;
  expectedInitial: string;
  build: (boom: Error, bad: () => boolean, onRun: () => void) => Element;
}

const FORMS: Form[] = [
  {
    name: "reactive class getter",
    read: (el) => el.getAttribute("class"),
    expectedInitial: "start",
    build: (boom, bad, onRun) =>
      div({
        class: () => {
          onRun();
          if (bad()) throw boom;
          return "start";
        },
      }),
  },
  {
    name: "reactive class object entry",
    read: (el) => el.getAttribute("class"),
    expectedInitial: "start",
    build: (boom, bad, onRun) =>
      div({
        class: {
          start: () => {
            onRun();
            if (bad()) throw boom;
            return true;
          },
        },
      }),
  },
  {
    name: "reactive whole-style getter",
    read: (el) => el.getAttribute("style"),
    expectedInitial: "color: red",
    build: (boom, bad, onRun) =>
      div({
        style: () => {
          onRun();
          if (bad()) throw boom;
          return "color: red";
        },
      }),
  },
  {
    name: "reactive style property",
    read: (el) => (el as HTMLElement).style.getPropertyValue("color"),
    expectedInitial: "red",
    build: (boom, bad, onRun) =>
      div({
        style: {
          color: () => {
            onRun();
            if (bad()) throw boom;
            return "red";
          },
        },
      }),
  },
];

// ---------------------------------------------------------------------------
// 1. Runtime metadata
// ---------------------------------------------------------------------------

describe("reactive class/style bindings report the element they belong to", () => {
  for (const form of FORMS) {
    describe(form.name, () => {
      it('reports phase "binding" WITH the owning element as context.node', () => {
        const reports = capture();
        const boom = new Error(`${form.name} failed`);
        const [phase, setPhase] = signal("ok");
        const el = form.build(
          boom,
          () => phase() === "bad",
          () => {},
        );

        // The defect is about a LATER scheduled rerun, so the initial render
        // must succeed and report nothing at all.
        expect(reports).toHaveLength(0);
        expect(form.read(el)).toBe(form.expectedInitial);

        setPhase("bad");

        expect(reports).toHaveLength(1);
        expect(reports[0].context.phase).toBe("binding");
        // Baseline stamped `undefined` here — that is the whole defect.
        expect(reports[0].context.node).toBe(el);
      });

      it("reports exactly once, with the original Error object unchanged", () => {
        const reports = capture();
        const boom = new Error(`${form.name} identity`);
        const [phase, setPhase] = signal("ok");
        form.build(
          boom,
          () => phase() === "bad",
          () => {},
        );

        setPhase("bad");

        // A single failing rerun must not be double-reported (e.g. once by the
        // boundary hop and once by the handler).
        expect(reports).toHaveLength(1);
        // Reference identity: stack, cause, custom props and instanceof survive.
        expect(reports[0].error).toBe(boom);
      });

      it("leaves the previously committed class/style value intact", () => {
        capture();
        const boom = new Error(`${form.name} retains`);
        const [phase, setPhase] = signal("ok");
        const el = form.build(
          boom,
          () => phase() === "bad",
          () => {},
        );
        expect(form.read(el)).toBe(form.expectedInitial);

        setPhase("bad");

        // The getter threw before its commit ran, so nothing was written.
        expect(form.read(el)).toBe(form.expectedInitial);
      });

      it("does not stop unrelated subscribers of the same signal", () => {
        capture();
        const boom = new Error(`${form.name} containment`);
        const [phase, setPhase] = signal("ok");
        form.build(
          boom,
          () => phase() === "bad",
          () => {},
        );

        const seen: string[] = [];
        const stop = effect(() => {
          seen.push(phase());
        });
        seen.length = 0;

        setPhase("bad");

        expect(seen).toEqual(["bad"]);
        stop();
      });
    });
  }
});

// ---------------------------------------------------------------------------
// 2. ErrorBoundary integration — the behaviour the node metadata exists for.
//
// These genuinely mount the boundary and the failing child into the document:
// boundary routing walks `parentNode`, so an assertion on `context.node` alone
// would not prove any of it.
// ---------------------------------------------------------------------------

interface BoundaryCase {
  name: string;
  child: (bad: () => boolean) => Element;
}

const BOUNDARY_CASES: BoundaryCase[] = [
  {
    name: "reactive class getter",
    child: (bad) =>
      div({
        class: () => {
          if (bad()) throw new Error("class getter exploded inside boundary");
          return "healthy";
        },
      }),
  },
  {
    name: "reactive whole-style getter",
    child: (bad) =>
      div({
        style: () => {
          if (bad()) throw new Error("style getter exploded inside boundary");
          return "color: red";
        },
      }),
  },
  {
    name: "reactive class object entry",
    child: (bad) =>
      div({
        class: {
          healthy: () => {
            if (bad()) throw new Error("class object exploded inside boundary");
            return true;
          },
        },
      }),
  },
  {
    name: "reactive style property",
    child: (bad) =>
      div({
        style: {
          color: () => {
            if (bad()) throw new Error("style property exploded inside boundary");
            return "red";
          },
        },
      }),
  },
];

describe("a scheduled class/style failure is claimed by the enclosing ErrorBoundary", () => {
  for (const scenario of BOUNDARY_CASES) {
    it(`${scenario.name}: renders the fallback and reports nowhere else`, async () => {
      const handler = vi.fn();
      setRuntimeErrorHandler(handler);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const [phase, setPhase] = signal("ok");
      const bad = () => phase() === "bad";

      const boundary = ErrorBoundary({ fallback: () => div({ class: "boundary-fallback", nodes: "caught" }) }, () =>
        scenario.child(bad),
      );

      // An unrelated binding on the SAME signal, outside the boundary, so the
      // fallback swap cannot dispose it.
      const sibling = div({ class: () => `sibling-${phase()}` });

      const container = mount(boundary);
      container.appendChild(sibling);
      await flush();

      // Initial render succeeded: no fallback, nothing reported.
      expect(container.querySelector(".boundary-fallback")).toBeNull();
      expect(handler).not.toHaveBeenCalled();

      setPhase("bad");
      await flush();

      // The boundary claimed it and is showing its fallback.
      expect(container.querySelector(".boundary-fallback")?.textContent).toBe("caught");
      // …so neither of the later stages in the pipeline ran.
      expect(handler).not.toHaveBeenCalled();
      expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("exploded inside boundary");
      // Containment: an unrelated reactive binding still updates.
      expect(sibling.getAttribute("class")).toBe("sibling-bad");
    });
  }

  it("the innermost boundary claims a class failure, leaving the outer one untouched", async () => {
    const handler = vi.fn();
    setRuntimeErrorHandler(handler);

    const [phase, setPhase] = signal("ok");
    const tree = ErrorBoundary({ fallback: () => div({ class: "outer-fb", nodes: "outer" }) }, () =>
      ErrorBoundary({ fallback: () => div({ class: "inner-fb", nodes: "inner" }) }, () =>
        div({
          class: () => {
            if (phase() === "bad") throw new Error("nested class failure");
            return "healthy";
          },
        }),
      ),
    );
    const container = mount(tree);
    await flush();

    setPhase("bad");
    await flush();

    expect(container.querySelector(".inner-fb")).toBeTruthy();
    expect(container.querySelector(".outer-fb")).toBeNull();
    expect(handler).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. Fallback when nothing claims the error.
//
// Carrying a DOM node must not make a failure vanish: an unclaimed error still
// has to reach the runtime handler, and the console when no handler is set.
// This is the failure mode `reportError` was previously fixed for, re-pinned
// here because these bindings only started carrying a node with this change.
// ---------------------------------------------------------------------------

describe("an unclaimed class/style failure still falls through the pipeline", () => {
  for (const form of FORMS) {
    it(`${form.name}: reaches the runtime handler when mounted with no boundary above`, async () => {
      const reports = capture();
      const boom = new Error(`${form.name} unclaimed`);
      const [phase, setPhase] = signal("ok");
      const el = form.build(
        boom,
        () => phase() === "bad",
        () => {},
      );
      mount(el);
      await flush();

      setPhase("bad");
      await flush();

      expect(reports).toHaveLength(1);
      expect(reports[0].error).toBe(boom);
      expect(reports[0].context.node).toBe(el);
    });

    it(`${form.name}: reaches console.error when there is no handler either`, async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const boom = new Error(`${form.name} console fallback`);
      const [phase, setPhase] = signal("ok");
      const el = form.build(
        boom,
        () => phase() === "bad",
        () => {},
      );
      mount(el);
      await flush();

      setPhase("bad");
      await flush();

      const messages = errSpy.mock.calls.map((c) => String(c[0]));
      expect(messages.filter((m) => m.includes("console fallback"))).toHaveLength(1);
    });
  }

  it("a DETACHED element with no boundary still reports rather than being swallowed", () => {
    const reports = capture();
    const boom = new Error("detached class failure");
    const [phase, setPhase] = signal("ok");
    const el = div({
      class: () => {
        if (phase() === "bad") throw boom;
        return "healthy";
      },
    });

    setPhase("bad");

    expect(reports).toHaveLength(1);
    expect(reports[0].context.node).toBe(el);
  });
});

// ---------------------------------------------------------------------------
// 4. Cleanup and retention — `registerDisposer` behaviour must be untouched.
// ---------------------------------------------------------------------------

describe("disposal still tears the binding down completely", () => {
  for (const form of FORMS) {
    it(`${form.name}: dispose() removes the subscriber and stops the getter`, async () => {
      const reports = capture();
      const boom = new Error(`${form.name} after dispose`);
      const [phase, setPhase] = signal("ok");
      let runs = 0;
      const el = form.build(
        boom,
        () => phase() === "bad",
        () => {
          runs++;
        },
      );
      mount(el);
      await flush();

      expect(runs).toBe(1);
      expect(getSubscriberCount(phase)).toBe(1);

      dispose(el);

      expect(getSubscriberCount(phase)).toBe(0);

      setPhase("bad");
      await flush();

      // The getter never ran again, so nothing could have been reported.
      expect(runs).toBe(1);
      expect(reports).toHaveLength(0);
    });
  }

  it("removing a mounted subtree through dispose() releases every class/style binding at once", async () => {
    const [phase, setPhase] = signal("ok");
    let classRuns = 0;
    let styleRuns = 0;
    const child = div({
      class: () => {
        classRuns++;
        return `c-${phase()}`;
      },
      style: {
        color: () => {
          styleRuns++;
          return phase() === "ok" ? "red" : "blue";
        },
      },
    });
    const parent = div({}, [child]);
    mount(parent);
    await flush();

    expect(getSubscriberCount(phase)).toBe(2);

    dispose(parent);
    parent.remove();

    expect(getSubscriberCount(phase)).toBe(0);
    setPhase("bad");
    expect(classRuns).toBe(1);
    expect(styleRuns).toBe(1);
  });

  it("the disposed binding drops its stored owner node so it cannot retain the subtree", async () => {
    const [phase, setPhase] = signal("ok");
    const el = div({ class: () => `c-${phase()}` });
    mount(el);
    await flush();

    // Capture the binding subscriber through the existing devtools seams — no
    // production internals are added for this assertion.
    const info = inspectSignal(phase);
    expect(info).not.toBeNull();
    let binding: ((...args: unknown[]) => void) | null = null;
    forEachSubscriber(info!.signal, (sub) => {
      binding = sub as unknown as (...args: unknown[]) => void;
    });
    expect(binding).not.toBeNull();
    expect((binding as unknown as Record<string, unknown>)._errorNode).toBe(el);

    dispose(el);

    expect((binding as unknown as Record<string, unknown>)._errorNode).toBeUndefined();
    setPhase("bad");
    expect(el.getAttribute("class")).toBe("c-ok");
  });
});

// ---------------------------------------------------------------------------
// 5. Normal rendering — unchanged successful behaviour, including sanitization.
// ---------------------------------------------------------------------------

describe("successful class and style rendering is unchanged", () => {
  it("a reactive class string keeps updating", () => {
    const [name, setName] = signal("a");
    const el = div({ class: () => `box ${name()}` });
    expect(el.getAttribute("class")).toBe("box a");
    setName("b");
    expect(el.getAttribute("class")).toBe("box b");
  });

  it("conditional class-object entries keep updating", () => {
    const [active, setActive] = signal(false);
    const el = div({ class: { base: true, active: () => active() } });
    expect(el.getAttribute("class")).toBe("base");
    setActive(true);
    expect(el.getAttribute("class")).toBe("base active");
    setActive(false);
    expect(el.getAttribute("class")).toBe("base");
  });

  it("a reactive whole style string is still sanitized on every run", () => {
    const [risky, setRisky] = signal(false);
    const el = div({
      style: () => (risky() ? "color: red; background: url(javascript:alert(1))" : "color: red"),
    });
    expect(el.getAttribute("style")).toBe("color: red");
    setRisky(true);
    // The `url(...)` declaration is dropped; the safe one survives.
    expect(el.getAttribute("style")).toBe("color: red");
    expect(el.getAttribute("style")).not.toContain("javascript");
  });

  it("a reactive individual style property is still sanitized on every run", () => {
    const [risky, setRisky] = signal(false);
    const el = div({
      style: { backgroundImage: () => (risky() ? "url(javascript:alert(1))" : "none") },
    });
    expect((el as HTMLElement).style.getPropertyValue("background-image")).toBe("none");
    setRisky(true);
    // sanitizeCSSValue collapses the blocked value to "", which clears it.
    expect((el as HTMLElement).style.getPropertyValue("background-image")).toBe("");
  });

  it("static class and style values are written without creating a subscriber", () => {
    const el = div({ class: "static-class", style: "color: red" });
    expect(el.getAttribute("class")).toBe("static-class");
    expect(el.getAttribute("style")).toBe("color: red");

    const objEl = div({ class: { on: true, off: false }, style: { color: "red" } });
    expect(objEl.getAttribute("class")).toBe("on");
    expect((objEl as HTMLElement).style.getPropertyValue("color")).toBe("red");
  });

  it("per-run dependency switching subscribes to newly read signals and prunes stale ones", () => {
    const [useA, setUseA] = signal(true);
    const [a, setA] = signal("A1");
    const [b, setB] = signal("B1");

    const el = div({ class: () => (useA() ? a() : b()) });
    expect(el.getAttribute("class")).toBe("A1");
    expect(getSubscriberCount(a)).toBe(1);
    expect(getSubscriberCount(b)).toBe(0);

    // Switch branches: `b` must become a dependency, `a` must be pruned.
    setUseA(false);
    expect(el.getAttribute("class")).toBe("B1");
    expect(getSubscriberCount(b)).toBe(1);
    expect(getSubscriberCount(a)).toBe(0);

    // The newly-read signal really is live…
    setB("B2");
    expect(el.getAttribute("class")).toBe("B2");
    // …and the pruned one really is not.
    setA("A2");
    expect(el.getAttribute("class")).toBe("B2");
  });

  it("the same per-run switching holds for a reactive style property", () => {
    const [useA, setUseA] = signal(true);
    const [a, setA] = signal("red");
    const [b, setB] = signal("blue");

    const el = div({ style: { color: () => (useA() ? a() : b()) } });
    expect((el as HTMLElement).style.getPropertyValue("color")).toBe("red");

    setUseA(false);
    expect((el as HTMLElement).style.getPropertyValue("color")).toBe("blue");
    expect(getSubscriberCount(a)).toBe(0);

    setB("green");
    expect((el as HTMLElement).style.getPropertyValue("color")).toBe("green");
    setA("purple");
    expect((el as HTMLElement).style.getPropertyValue("color")).toBe("green");
  });

  it("a getter that throws during the SYNCHRONOUS initial render still propagates to the caller", () => {
    // Initial-render semantics are deliberately untouched: `reactiveBinding`'s
    // first run is not wrapped by the drain's `safeInvoke`, so construction
    // throws exactly as it did before.
    expect(() =>
      div({
        class: () => {
          throw new Error("initial render class failure");
        },
      }),
    ).toThrow("initial render class failure");

    expect(() =>
      div({
        style: () => {
          throw new Error("initial render style failure");
        },
      }),
    ).toThrow("initial render style failure");
  });
});
