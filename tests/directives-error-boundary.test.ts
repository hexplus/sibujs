import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../src/components/ErrorBoundary";
import { setRuntimeErrorHandler } from "../src/core/errors";
import { match, show, when } from "../src/core/rendering/directives";
import { div, span } from "../src/core/rendering/html";
import { signal } from "../src/core/signals/signal";

// show(), when() and match() re-run on scheduled updates. A condition, selector
// or branch factory that throws on such a run is reported from the drain, which
// can only find the enclosing ErrorBoundary through the node stamped on the
// subscriber. These pin that the directives stamp their node.

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
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

/**
 * A boundary whose fallback exposes its retry, around `content`. Returns the
 * container plus a `retry()` that clicks through the fallback.
 */
async function withBoundary(content: () => Element) {
  const handler = vi.fn();
  setRuntimeErrorHandler(handler);
  let retry: (() => void) | undefined;
  const boundary = ErrorBoundary(
    {
      fallback: (_error, reset) => {
        retry = reset;
        return div({ class: "fallback" }, "caught");
      },
    },
    content,
  );
  const container = mount(boundary);
  await flush();
  return {
    container,
    handler,
    retry: async () => {
      retry?.();
      await flush();
    },
  };
}

describe("show() on a scheduled update", () => {
  it("routes a throwing condition to the enclosing ErrorBoundary and recovers after reset", async () => {
    const [state, setState] = signal<"on" | "off" | "bad">("on");
    const { container, handler, retry } = await withBoundary(() =>
      div({ class: "content" }, [
        show(
          () => {
            if (state() === "bad") throw new Error("show condition failed");
            return state() === "on";
          },
          span({ class: "target" }, "visible"),
        ),
      ]),
    );
    expect((container.querySelector(".target") as HTMLElement).style.display).toBe("");

    setState("bad");
    await flush();
    expect(container.querySelector(".fallback")?.textContent).toBe("caught");
    expect(handler).not.toHaveBeenCalled();

    setState("off");
    await retry();
    const target = container.querySelector(".target") as HTMLElement;
    expect(container.querySelector(".fallback")).toBeNull();
    expect(target.style.display).toBe("none");
    setState("on");
    expect((container.querySelector(".target") as HTMLElement).style.display).toBe("");
  });
});

describe("when() on a scheduled update", () => {
  it("routes a throwing condition to the enclosing ErrorBoundary and recovers after reset", async () => {
    const [state, setState] = signal<"yes" | "no" | "bad">("yes");
    const { container, handler, retry } = await withBoundary(() =>
      div({ class: "content" }, [
        when(
          () => {
            if (state() === "bad") throw new Error("when condition failed");
            return state() === "yes";
          },
          () => span({ class: "yes" }, "yes"),
          () => span({ class: "no" }, "no"),
        ),
      ]),
    );
    expect(container.querySelector(".yes")).not.toBeNull();

    setState("bad");
    await flush();
    expect(container.querySelector(".fallback")?.textContent).toBe("caught");
    expect(handler).not.toHaveBeenCalled();

    setState("no");
    await retry();
    expect(container.querySelector(".fallback")).toBeNull();
    expect(container.querySelector(".no")).not.toBeNull();
    setState("yes");
    expect(container.querySelector(".yes")).not.toBeNull();
  });

  it("routes a throwing branch factory to the enclosing ErrorBoundary", async () => {
    const [on, setOn] = signal(false);
    const { container, handler } = await withBoundary(() =>
      div({ class: "content" }, [
        when(
          () => on(),
          () => {
            throw new Error("when branch failed");
          },
          () => span({ class: "off" }, "off"),
        ),
      ]),
    );
    expect(container.querySelector(".off")).not.toBeNull();

    setOn(true);
    await flush();
    expect(container.querySelector(".fallback")?.textContent).toBe("caught");
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("match() on a scheduled update", () => {
  it("routes a throwing selector to the enclosing ErrorBoundary and recovers after reset", async () => {
    const [mode, setMode] = signal<"a" | "b" | "bad">("a");
    const { container, handler, retry } = await withBoundary(() =>
      div({ class: "content" }, [
        match(
          () => {
            if (mode() === "bad") throw new Error("match selector failed");
            return mode();
          },
          { a: () => span({ class: "a" }, "a"), b: () => span({ class: "b" }, "b") },
        ),
      ]),
    );
    expect(container.querySelector(".a")).not.toBeNull();

    setMode("bad");
    await flush();
    expect(container.querySelector(".fallback")?.textContent).toBe("caught");
    expect(handler).not.toHaveBeenCalled();

    setMode("b");
    await retry();
    expect(container.querySelector(".fallback")).toBeNull();
    expect(container.querySelector(".b")).not.toBeNull();
    setMode("a");
    expect(container.querySelector(".a")).not.toBeNull();
  });

  it("routes a throwing case factory to the enclosing ErrorBoundary", async () => {
    const [mode, setMode] = signal<"ok" | "broken">("ok");
    const { container, handler } = await withBoundary(() =>
      div({ class: "content" }, [
        match(() => mode(), {
          ok: () => span({ class: "ok" }, "ok"),
          broken: () => {
            throw new Error("match case failed");
          },
        }),
      ]),
    );
    expect(container.querySelector(".ok")).not.toBeNull();

    setMode("broken");
    await flush();
    expect(container.querySelector(".fallback")?.textContent).toBe("caught");
    expect(handler).not.toHaveBeenCalled();
  });
});
