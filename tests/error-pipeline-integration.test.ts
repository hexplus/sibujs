import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../src/components/ErrorBoundary";
import { setRuntimeErrorHandler } from "../src/core/errors";
import { each } from "../src/core/rendering/each";
import { div } from "../src/core/rendering/html";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";

// ---------------------------------------------------------------------------
// End-to-end error pipeline: ErrorBoundary -> runtime handler -> console.
//
// THE INVARIANT UNDER TEST: exactly ONE of those three runs for any contained
// error, and which one runs depends on whether a boundary EXPLICITLY claimed
// it — never on the incidental fact that the error carried a DOM node.
//
// Regression origin: `reportError` returned as soon as it had dispatched the
// boundary event. With a node but no boundary mounted, the dispatch went
// nowhere, the function returned, and the global handler and console fallback
// were both skipped. A production render failure became silence.
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

describe("each() renderer failures use the central pipeline", () => {
  it("reaches the runtime handler when no ErrorBoundary is mounted", async () => {
    const handler = vi.fn();
    setRuntimeErrorHandler(handler);

    const [items] = signal([{ id: 1 }]);
    const anchor = each(
      () => items(),
      () => {
        throw new Error("row failed");
      },
      { key: (i) => i.id },
    );
    mount(anchor);
    await flush();

    expect(handler).toHaveBeenCalledTimes(1);
    expect((handler.mock.calls[0][0] as Error).message).toBe("row failed");
    expect(handler.mock.calls[0][1].phase).toBe("render");
  });

  it("reaches console.error when there is neither a boundary nor a handler", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const [items] = signal([{ id: 1 }]);
    const anchor = each(
      () => items(),
      () => {
        throw new Error("unclaimed row");
      },
      { key: (i) => i.id },
    );
    mount(anchor);
    await flush();

    const messages = errSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.filter((m) => m.includes("unclaimed row"))).toHaveLength(1);
  });

  it("is handled by an enclosing ErrorBoundary, and NOT reported globally", async () => {
    const handler = vi.fn();
    setRuntimeErrorHandler(handler);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const [items] = signal([{ id: 1 }]);
    const boundary = ErrorBoundary(
      { fallback: () => div({ class: "fallback", nodes: "recovered" }) },
      () =>
        each(
          () => items(),
          () => {
            throw new Error("row failed inside boundary");
          },
          { key: (i) => i.id },
        ) as unknown as Element,
    );
    const container = mount(boundary);
    await flush();

    // The boundary claimed it: fallback rendered, global channels untouched.
    expect(container.querySelector(".fallback")?.textContent).toBe("recovered");
    expect(handler).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("row failed inside boundary");
  });
});

describe("reactive binding failures use the central pipeline", () => {
  it('reports a binding that throws on a later scheduled run, with phase "binding"', () => {
    const contexts: Array<{ phase: string }> = [];
    setRuntimeErrorHandler((_error, context) => contexts.push(context));

    const [value, setValue] = signal("ok");
    const el = div({ nodes: () => (value() === "bad" ? raise() : value()) });
    mount(el);

    function raise(): string {
      throw new Error("binding failed");
    }

    expect(contexts).toHaveLength(0);
    setValue("bad");

    expect(contexts).toHaveLength(1);
    expect(contexts[0].phase).toBe("binding");
  });

  it("routes a binding failure to the enclosing ErrorBoundary", async () => {
    const handler = vi.fn();
    setRuntimeErrorHandler(handler);

    const [value, setValue] = signal("ok");
    const boundary = ErrorBoundary({ fallback: () => div({ class: "bfb", nodes: "caught" }) }, () =>
      div({
        nodes: () => {
          if (value() === "bad") throw new Error("binding failed in boundary");
          return value();
        },
      }),
    );
    const container = mount(boundary);
    await flush();

    setValue("bad");
    await flush();

    // The binding subscriber retained its owning node, so the drain could find
    // the boundary above it. Without that metadata this is unreachable.
    expect(container.querySelector(".bfb")?.textContent).toBe("caught");
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("nested boundaries", () => {
  it("the innermost capable boundary claims the error", async () => {
    const handler = vi.fn();
    setRuntimeErrorHandler(handler);

    const [items] = signal([{ id: 1 }]);
    const tree = ErrorBoundary({ fallback: () => div({ class: "outer-fb", nodes: "outer" }) }, () =>
      ErrorBoundary(
        { fallback: () => div({ class: "inner-fb", nodes: "inner" }) },
        () =>
          each(
            () => items(),
            () => {
              throw new Error("nested row");
            },
            { key: (i) => i.id },
          ) as unknown as Element,
      ),
    );
    const container = mount(tree);
    await flush();

    expect(container.querySelector(".inner-fb")).toBeTruthy();
    expect(container.querySelector(".outer-fb")).toBeNull();
    expect(handler).not.toHaveBeenCalled();
  });

  it("an inner boundary already showing a fallback declines, and the outer one claims", async () => {
    const handler = vi.fn();
    setRuntimeErrorHandler(handler);

    const [value, setValue] = signal("ok");

    // The inner boundary's own fallback throws, so it cannot show anything for
    // the second error and must let it continue outward.
    const tree = ErrorBoundary({ fallback: () => div({ class: "outer-fb", nodes: "outer caught" }) }, () =>
      ErrorBoundary(
        {
          fallback: () => {
            throw new Error("inner fallback broken");
          },
        },
        () =>
          div({
            nodes: () => {
              if (value() === "bad") throw new Error("child failed");
              return "fine";
            },
          }),
      ),
    );
    const container = mount(tree);
    await flush();

    setValue("bad");
    await flush();

    // The inner boundary could not render; the outer boundary took over rather
    // than the error being stranded at the broken inner one.
    expect(container.querySelector(".outer-fb")?.textContent).toBe("outer caught");
    expect(handler).not.toHaveBeenCalled();
  });

  it("a broken boundary with no parent still reports through the runtime handler", async () => {
    const handler = vi.fn();
    setRuntimeErrorHandler(handler);

    const [value, setValue] = signal("ok");
    const boundary = ErrorBoundary(
      {
        fallback: () => {
          throw new Error("fallback exploded");
        },
      },
      () =>
        div({
          nodes: () => {
            if (value() === "bad") throw new Error("child failed");
            return "fine";
          },
        }),
    );
    mount(boundary);
    await flush();

    setValue("bad");
    await flush();

    // Nothing above can claim the fallback's own failure, so it must not vanish.
    const messages = handler.mock.calls.map((c) => (c[0] as Error).message);
    expect(messages).toContain("fallback exploded");
  });
});

describe("exactly-once reporting", () => {
  it("an effect failure reaches the handler exactly once", () => {
    const handler = vi.fn();
    setRuntimeErrorHandler(handler);

    const [n, setN] = signal(0);
    const dispose = effect(() => {
      if (n() === 1) throw new Error("once only");
    });
    setN(1);

    expect(handler).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("a boundary-handled error does not also reach console.error", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const [items] = signal([{ id: 1 }]);
    const boundary = ErrorBoundary(
      { fallback: () => div({ class: "fb2", nodes: "ok" }) },
      () =>
        each(
          () => items(),
          () => {
            throw new Error("claimed once");
          },
          { key: (i) => i.id },
        ) as unknown as Element,
    );
    mount(boundary);
    await flush();

    expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("claimed once");
  });
});

describe("scheduler continues after a contained error", () => {
  it("unrelated subscribers still run when one throws", () => {
    setRuntimeErrorHandler(() => {});
    const [n, setN] = signal(0);
    const order: string[] = [];

    const dB = effect(() => {
      n();
      order.push("B");
    });
    const dC = effect(() => {
      n();
      order.push("C");
    });
    const dA = effect(() => {
      if (n() === 1) throw new Error("A throws");
    });

    order.length = 0;
    setN(1);

    expect(order).toContain("B");
    expect(order).toContain("C");
    dA();
    dB();
    dC();
  });
});
