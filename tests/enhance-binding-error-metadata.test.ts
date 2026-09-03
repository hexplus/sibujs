import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RuntimeErrorContext, setRuntimeErrorHandler } from "../src/core/errors";
import { signal } from "../src/core/signals/signal";
import { enhance } from "../src/platform/enhance";

// ---------------------------------------------------------------------------
// Enhancement bindings must carry the SAME error metadata as every other DOM
// binding in the runtime (`bindTextNode`, `bindAttribute`, tagFactory's
// class/style bindings): phase `"binding"` and the owning node.
//
// They were created with `effect()`, whose subscribers are stamped
// `_errorPhase: "effect"` and deliberately carry NO `_errorNode` (a generic
// effect has no DOM position). So a binding that failed on a LATER run — the
// only path where the drain, not the caller, reports the failure — was
// reported as an effect with no node. `reportError` gives a node's enclosing
// `ErrorBoundary` first refusal, so with no node that branch was unreachable
// for every progressive-enhancement binding on the page.
// ---------------------------------------------------------------------------

function serverRender(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html.trim();
  document.body.appendChild(host);
  return host.firstElementChild as HTMLElement;
}

let reports: Array<{ error: unknown; context: RuntimeErrorContext }>;

beforeEach(() => {
  reports = [];
  setRuntimeErrorHandler((error, context) => {
    reports.push({ error, context });
  });
});

afterEach(() => {
  setRuntimeErrorHandler(null);
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("enhance() bindings report as DOM bindings, not as generic effects", () => {
  it("text() stamps phase 'binding' and the owning node", () => {
    const root = serverRender(`<div><b data-ref="n">0</b></div>`);
    const node = root.querySelector('[data-ref="n"]') as HTMLElement;
    const [n, setN] = signal(0);

    enhance(root, (ctx) => {
      ctx.text("@n", () => {
        const value = n();
        if (value > 0) throw new Error("text boom");
        return value;
      });
    });

    setN(1);

    expect(reports).toHaveLength(1);
    expect((reports[0].error as Error).message).toBe("text boom");
    expect(reports[0].context.phase).toBe("binding");
    expect(reports[0].context.node).toBe(node);
  });

  it("attr() stamps phase 'binding' and the owning node", () => {
    const root = serverRender(`<div><a data-ref="link">x</a></div>`);
    const node = root.querySelector('[data-ref="link"]') as HTMLElement;
    const [on, setOn] = signal(false);

    enhance(root, (ctx) => {
      ctx.attr("@link", "aria-expanded", () => {
        if (on()) throw new Error("attr boom");
        return false;
      });
    });

    setOn(true);

    expect(reports).toHaveLength(1);
    expect(reports[0].context.phase).toBe("binding");
    expect(reports[0].context.node).toBe(node);
  });

  it("classed() stamps phase 'binding' and the owning node", () => {
    const root = serverRender(`<div><span data-ref="s">x</span></div>`);
    const node = root.querySelector('[data-ref="s"]') as HTMLElement;
    const [on, setOn] = signal(false);

    enhance(root, (ctx) => {
      ctx.classed("@s", "active", () => {
        if (on()) throw new Error("class boom");
        return false;
      });
    });

    setOn(true);

    expect(reports).toHaveLength(1);
    expect(reports[0].context.phase).toBe("binding");
    expect(reports[0].context.node).toBe(node);
  });

  it("show() stamps phase 'binding' and the owning node", () => {
    const root = serverRender(`<div><p data-ref="p">x</p></div>`);
    const node = root.querySelector('[data-ref="p"]') as HTMLElement;
    const [on, setOn] = signal(true);

    enhance(root, (ctx) => {
      ctx.show("@p", () => {
        if (!on()) throw new Error("show boom");
        return true;
      });
    });

    setOn(false);

    expect(reports).toHaveLength(1);
    expect(reports[0].context.phase).toBe("binding");
    expect(reports[0].context.node).toBe(node);
  });

  it("model() stamps phase 'binding' and the owning node", () => {
    const root = serverRender(`<form><input data-ref="i" value="a" /></form>`);
    const node = root.querySelector('[data-ref="i"]') as HTMLElement;
    const [value, setValue] = signal("a");

    enhance(root, (ctx) => {
      ctx.model("@i", [
        () => {
          const v = value();
          if (v === "boom") throw new Error("model boom");
          return v;
        },
        setValue,
      ]);
    });

    setValue("boom");

    expect(reports).toHaveLength(1);
    expect(reports[0].context.phase).toBe("binding");
    expect(reports[0].context.node).toBe(node);
  });

  it("a disposed binding is never invalidated again", () => {
    const root = serverRender(`<div><b data-ref="n">0</b></div>`);
    const [n, setN] = signal(0);
    let runs = 0;

    const stop = enhance(root, (ctx) => {
      ctx.text("@n", () => {
        runs++;
        return n();
      });
    });

    expect(runs).toBe(1);
    setN(1);
    expect(runs).toBe(2);

    stop();
    setN(2);
    expect(runs).toBe(2);
    expect(reports).toEqual([]);
  });
});
