import { afterEach, describe, expect, it, vi } from "vitest";
import { type RuntimeErrorContext, setRuntimeErrorHandler } from "../src/core/errors";
import { signal } from "../src/core/signals/signal";
import { disableSSR, enableSSR } from "../src/core/ssr-context";
import type { EnhanceContext } from "../src/platform/enhance";
import { enhance } from "../src/platform/enhance";
import type { ReactiveSignal } from "../src/reactivity/signal";
import { forEachSubscriber, getSubscriberCount, reactiveBinding } from "../src/reactivity/track";

// ---------------------------------------------------------------------------
// A binding whose FIRST evaluation throws must leave nothing behind.
//
// `reactiveBinding()` performs its initial `run()` before it constructs or
// returns the disposer. If that run reads a signal and then throws:
//
//   * `retrack()` has already linked the subscriber to the signal;
//   * the throw escapes before a disposer exists, so no caller can ever hold
//     one;
//   * `enhance()` catches the setup error, but its teardown list never received
//     the binding — there is nothing to roll back.
//
// The result is a zombie: a later write to that signal re-runs the commit and
// mutates DOM belonging to an enhancement that never completed. That directly
// contradicts the documented transaction guarantee ("a failed setup claims
// nothing"), so the guarantee — not just the symptom — is what these tests pin.
// ---------------------------------------------------------------------------

/** Reach a signal's internal state object, which is what the core links against. */
function stateOf<T>(accessor: () => T): ReactiveSignal {
  return (accessor as unknown as { __signal: ReactiveSignal }).__signal;
}

function render(markup: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = markup.trim();
  document.body.appendChild(host);
  return host.firstElementChild as HTMLElement;
}

afterEach(() => {
  disableSSR();
  setRuntimeErrorHandler(null);
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Every EnhanceContext helper that goes through `bindNode()`.
// ---------------------------------------------------------------------------

interface BindingCase {
  name: string;
  markup: string;
  /** Wire the binding under test using `getter` as its reactive body. */
  wire(ctx: EnhanceContext, getter: () => unknown): void;
  /** Everything about the target a binding of this kind could have changed. */
  snapshot(root: HTMLElement): string;
  /**
   * Two values this binding renders DIFFERENTLY, used to prove a later
   * generation is genuinely live. They differ per case because a boolean
   * binding cannot be driven by two distinct strings.
   */
  liveValues: [unknown, unknown];
}

const TARGET = '[data-ref="target"]';

const CASES: BindingCase[] = [
  {
    name: "ctx.text()",
    markup: `<div><b data-ref="target">server value</b></div>`,
    wire: (ctx, getter) => ctx.text("@target", getter),
    snapshot: (root) => root.querySelector(TARGET)?.textContent ?? "",
    liveValues: ["live", "changed"],
  },
  {
    name: "ctx.attr()",
    markup: `<div><a data-ref="target" data-state="server value">x</a></div>`,
    wire: (ctx, getter) => ctx.attr("@target", "data-state", getter),
    snapshot: (root) => root.querySelector(TARGET)?.getAttribute("data-state") ?? "",
    liveValues: ["live", "changed"],
  },
  {
    name: "ctx.classed()",
    markup: `<div><span data-ref="target" class="server value">x</span></div>`,
    wire: (ctx, getter) => ctx.classed("@target", "active", () => Boolean(getter())),
    snapshot: (root) => root.querySelector(TARGET)?.className ?? "",
    liveValues: [true, false],
  },
  {
    name: "ctx.show()",
    markup: `<div><p data-ref="target" hidden>server value</p></div>`,
    wire: (ctx, getter) => ctx.show("@target", () => Boolean(getter())),
    snapshot: (root) => String((root.querySelector(TARGET) as HTMLElement).hidden),
    liveValues: [true, false],
  },
  {
    name: "ctx.model()",
    markup: `<form><input data-ref="target" value="server value" /></form>`,
    wire: (ctx, getter) =>
      ctx.model("@target", [getter as () => unknown, () => {}] as const as readonly [
        () => unknown,
        (value: unknown) => void,
      ]),
    snapshot: (root) => (root.querySelector(TARGET) as HTMLInputElement).value,
    liveValues: ["live", "changed"],
  },
  {
    name: "ctx.each() descriptor",
    markup: `<div><b data-ref="target">server value</b></div>`,
    wire: (ctx, getter) => ctx.each("@target", () => ({ text: getter })),
    snapshot: (root) => root.querySelector(TARGET)?.textContent ?? "",
    liveValues: ["live", "changed"],
  },
];

describe.each(CASES)("$name — a throwing initial evaluation leaves nothing live", (testCase) => {
  /**
   * The exact sequence from the defect report: read a signal, throw, then write
   * that signal and prove the binding is gone rather than merely quiet.
   */
  function runFailedEnhancement() {
    const [value, setValue] = signal(0);
    const failure = new Error("initial binding failure");
    let evaluations = 0;
    let stillInitial = true;

    const root = render(testCase.markup);
    const before = testCase.snapshot(root);

    let caught: unknown;
    try {
      enhance(root, (ctx) => {
        testCase.wire(ctx, () => {
          evaluations++;
          // The read happens BEFORE the throw — that is what subscribes the
          // binding, and therefore what makes the zombie reachable.
          const current = value();
          if (stillInitial) {
            stillInitial = false;
            throw failure;
          }
          return current;
        });
      });
    } catch (err) {
      caught = err;
    }

    return { root, before, caught, failure, value, setValue, evaluations: () => evaluations };
  }

  it("rethrows the original error object by identity", () => {
    const { caught, failure } = runFailedEnhancement();
    expect(caught).toBe(failure);
  });

  it("leaves the root unmarked, so it was never claimed", () => {
    const { root } = runFailedEnhancement();
    expect(root.hasAttribute("data-sibu-enhanced")).toBe(false);
  });

  it("leaves the signal with zero subscribers", () => {
    const { value } = runFailedEnhancement();
    expect(getSubscriberCount(stateOf(value))).toBe(0);
  });

  it("does not re-run the getter when the signal it read is written", () => {
    const { setValue, evaluations } = runFailedEnhancement();
    expect(evaluations()).toBe(1);
    setValue(1);
    setValue(2);
    expect(evaluations()).toBe(1);
  });

  it("does not mutate the DOM after the failed enhancement", () => {
    const { root, before, setValue } = runFailedEnhancement();
    setValue(1);
    expect(testCase.snapshot(root)).toBe(before);
  });

  it("lets the same root be enhanced successfully afterwards", () => {
    const { root, setValue, value } = runFailedEnhancement();
    const [first, second] = testCase.liveValues;
    const [ok, setOk] = signal<unknown>(first);

    const stop = enhance(root, (ctx) => testCase.wire(ctx, () => ok()));
    expect(root.getAttribute("data-sibu-enhanced")).toBe("true");

    // The second generation is the ONLY thing driving the node now: the signal
    // the FAILED binding read moves it not at all…
    const after = testCase.snapshot(root);
    setValue(99);
    expect(testCase.snapshot(root)).toBe(after);

    // …while the signal the LIVE binding reads moves it.
    setOk(second);
    expect(testCase.snapshot(root)).not.toBe(after);

    stop();
    expect(root.hasAttribute("data-sibu-enhanced")).toBe(false);
    expect(getSubscriberCount(stateOf(ok))).toBe(0);
    expect(getSubscriberCount(stateOf(value))).toBe(0);
  });
});

describe("transaction rollback around a failing initial binding", () => {
  it("rolls back bindings, listeners and runs cleanups registered before the failure", () => {
    const [label, setLabel] = signal("first");
    const [value, setValue] = signal(0);
    const cleanups: string[] = [];
    let clicks = 0;
    const failure = new Error("initial binding failure");

    const root = render(`
      <div>
        <b data-ref="label">server label</b>
        <button data-ref="btn">go</button>
        <b data-ref="target">server value</b>
      </div>`);

    expect(() =>
      enhance(root, (ctx) => {
        ctx.text("@label", () => label());
        ctx.on("@btn", "click", () => {
          clicks++;
        });
        ctx.cleanup(() => cleanups.push("registered cleanup"));
        ctx.text("@target", () => {
          value();
          throw failure;
        });
      }),
    ).toThrow(failure);

    // The cleanup the setup registered ran during rollback…
    expect(cleanups).toEqual(["registered cleanup"]);

    // …the earlier binding is dead…
    const labelNode = root.querySelector('[data-ref="label"]') as HTMLElement;
    expect(labelNode.textContent).toBe("first"); // it did commit once, before the throw
    setLabel("second");
    expect(labelNode.textContent).toBe("first");

    // …the listener is gone…
    (root.querySelector('[data-ref="btn"]') as HTMLButtonElement).click();
    expect(clicks).toBe(0);

    // …and the failing binding left no subscription of its own.
    expect(getSubscriberCount(stateOf(value))).toBe(0);
    expect(getSubscriberCount(stateOf(label))).toBe(0);
    setValue(1);
    expect(root.querySelector('[data-ref="target"]')?.textContent).toBe("server value");
    expect(root.hasAttribute("data-sibu-enhanced")).toBe(false);
  });
});

describe("reactiveBinding() — the primitive itself", () => {
  it("unlinks the dependency it recorded when the initial commit throws", () => {
    const [value, setValue] = signal(0);
    const sig = stateOf(value);
    const failure = new Error("initial commit failure");
    let commits = 0;

    expect(getSubscriberCount(sig)).toBe(0);

    expect(() =>
      reactiveBinding(() => {
        commits++;
        value();
        throw failure;
      }),
    ).toThrow(failure);

    expect(commits).toBe(1);
    expect(getSubscriberCount(sig)).toBe(0);

    setValue(1);
    expect(commits).toBe(1);
  });

  it("marks the failed subscriber disposed and drops its owner node", () => {
    const [value] = signal(0);
    const sig = stateOf(value);
    const owner = document.createElement("div");
    const failure = new Error("initial commit failure");
    let captured: Record<string, unknown> | undefined;

    expect(() =>
      reactiveBinding(() => {
        value();
        // While the commit is mid-flight the edge exists, so the subscriber is
        // reachable — capture it here to inspect what the failure path did.
        forEachSubscriber(sig, (sub) => {
          captured = sub as unknown as Record<string, unknown>;
        });
        throw failure;
      }, owner),
    ).toThrow(failure);

    expect(captured, "the subscriber was linked during the commit").toBeDefined();
    expect(captured?._disposed).toBe(true);
    expect(captured?._errorNode).toBeUndefined();
    expect(captured?.depsHead ?? null).toBe(null);
  });

  it("still returns a working, idempotent disposer when the initial commit succeeds", () => {
    const [value, setValue] = signal(0);
    const sig = stateOf(value);
    const seen: number[] = [];

    const stop = reactiveBinding(() => {
      seen.push(value());
    });

    expect(seen).toEqual([0]);
    expect(getSubscriberCount(sig)).toBe(1);

    setValue(1);
    expect(seen).toEqual([0, 1]);

    stop();
    stop();
    expect(getSubscriberCount(sig)).toBe(0);
    setValue(2);
    expect(seen).toEqual([0, 1]);
  });

  it("still routes a LATER failure through the runtime error pipeline with its node", () => {
    const reports: Array<{ error: unknown; context: RuntimeErrorContext }> = [];
    setRuntimeErrorHandler((error, context) => reports.push({ error, context }));

    const root = render(`<div><b data-ref="target">server value</b></div>`);
    const target = root.querySelector(TARGET) as HTMLElement;
    const [value, setValue] = signal(0);

    enhance(root, (ctx) => {
      ctx.text("@target", () => {
        const current = value();
        if (current > 0) throw new Error("later binding failure");
        return current;
      });
    });

    setValue(1);

    expect(reports).toHaveLength(1);
    expect((reports[0].error as Error).message).toBe("later binding failure");
    expect(reports[0].context.phase).toBe("binding");
    expect(reports[0].context.node).toBe(target);
  });

  it("lets sibling bindings keep updating after another binding fails later", () => {
    setRuntimeErrorHandler(() => {});
    const root = render(`
      <div>
        <b data-ref="a">a</b>
        <b data-ref="b">b</b>
      </div>`);
    const [value, setValue] = signal(0);

    enhance(root, (ctx) => {
      ctx.text("@a", () => {
        if (value() > 0) throw new Error("boom");
        return "a0";
      });
      ctx.text("@b", () => `b${value()}`);
    });

    setValue(1);
    expect(root.querySelector('[data-ref="a"]')?.textContent).toBe("a0");
    expect(root.querySelector('[data-ref="b"]')?.textContent).toBe("b1");
  });
});

describe("SSR is unchanged", () => {
  it("creates no binding at all, so a throwing getter never runs", () => {
    const root = render(`<div><b data-ref="target">server value</b></div>`);
    const [value] = signal(0);
    let evaluations = 0;

    enableSSR();
    try {
      // No throw: under SSR the helper never evaluates the getter, exactly as
      // it behaved when these bindings were built with `effect()`.
      const stop = enhance(root, (ctx) => {
        ctx.text("@target", () => {
          evaluations++;
          value();
          throw new Error("must never run under SSR");
        });
      });
      expect(evaluations).toBe(0);
      expect(getSubscriberCount(stateOf(value))).toBe(0);
      expect(root.querySelector(TARGET)?.textContent).toBe("server value");
      stop();
    } finally {
      disableSSR();
    }
  });
});
