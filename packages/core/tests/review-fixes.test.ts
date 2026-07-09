import { describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../src/components/ErrorBoundary";
import { match, when } from "../src/core/rendering/directives";
import { each } from "../src/core/rendering/each";
import { Fragment } from "../src/core/rendering/fragment";
import { html } from "../src/core/rendering/htm";
import { div, math, p } from "../src/core/rendering/html";
import { asyncDerived } from "../src/core/signals/asyncDerived";
import { derived } from "../src/core/signals/derived";
import { signal } from "../src/core/signals/signal";
import { enhance } from "../src/platform/enhance";

const tick = () => new Promise<void>((r) => setTimeout(r, 10));

// ── C1: primitives must not orphan managed DOM when the anchor is swapped ────
describe("C1 — when/match/each dispose their managed DOM on anchor disposal", () => {
  it("nested when: swapping the outer branch removes the inner branch content", async () => {
    const [outer, setOuter] = signal(true);
    const container = document.createElement("div");
    container.appendChild(
      when(
        () => outer(),
        () =>
          when(
            () => true,
            () => p("INNER"),
          ),
        () => p("ELSE"),
      ),
    );
    document.body.appendChild(container);
    await tick();
    expect(container.textContent).toBe("INNER");

    setOuter(false);
    await tick();
    // Must be exactly "ELSE" — not "ELSEINNER" (stale orphaned inner content).
    expect(container.textContent).toBe("ELSE");

    document.body.removeChild(container);
  });

  it("each swapped out by a when leaves no stale rows behind", async () => {
    const [show, setShow] = signal(true);
    const items = [1, 2];
    const container = document.createElement("div");
    container.appendChild(
      when(
        () => show(),
        () =>
          each(
            () => items,
            (it) => p(String(it())),
            { key: (i) => i },
          ),
        () => p("EMPTY"),
      ),
    );
    document.body.appendChild(container);
    await tick();
    expect(container.textContent).toBe("12");

    setShow(false);
    await tick();
    // Must be exactly "EMPTY" — not "EMPTY12".
    expect(container.textContent).toBe("EMPTY");

    document.body.removeChild(container);
  });

  it("match swapped out by a when removes its matched content", async () => {
    const [show, setShow] = signal(true);
    const [key] = signal("a");
    const container = document.createElement("div");
    container.appendChild(
      when(
        () => show(),
        () => match(() => key(), { a: () => p("MATCHED") }),
        () => p("GONE"),
      ),
    );
    document.body.appendChild(container);
    await tick();
    expect(container.textContent).toBe("MATCHED");

    setShow(false);
    await tick();
    expect(container.textContent).toBe("GONE");

    document.body.removeChild(container);
  });
});

// ── CO-1: DocumentFragment reactive child must be removable ──────────────────
describe("CO-1 — DocumentFragment reactive child is fully removable", () => {
  it("toggling Fragment([A,B]) <-> C does not leave orphans", async () => {
    const [toggle, setToggle] = signal(true);
    const container = div([() => (toggle() ? Fragment([p("A"), p("B")]) : p("C"))]) as HTMLElement;
    document.body.appendChild(container);
    await tick();
    expect(container.textContent).toBe("AB");

    setToggle(false);
    await tick();
    // The two fragment children must be gone — not "CAB" / "ABC".
    expect(container.textContent).toBe("C");

    setToggle(true);
    await tick();
    expect(container.textContent).toBe("AB");

    document.body.removeChild(container);
  });
});

// ── CO-2: htm boolean expression attributes ─────────────────────────────────
describe("CO-2 — html boolean attributes follow HTML semantics", () => {
  it("disabled=${false} does not set the disabled attribute", () => {
    const el = html`<button disabled=${false}>Hi</button>` as HTMLButtonElement;
    expect(el.hasAttribute("disabled")).toBe(false);
    expect(el.disabled).toBe(false);
  });

  it("disabled=${true} sets/enables the disabled state", () => {
    const el = html`<button disabled=${true}>Hi</button>` as HTMLButtonElement;
    expect(el.disabled).toBe(true);
  });
});

// ── CO-3: ErrorBoundary fallback must not cross-wire between instances ───────
describe("CO-3 — ErrorBoundary fallback bound to its own error", () => {
  it("two boundaries sharing one fallback fn with same message keep distinct errors", async () => {
    const fallback = (err: Error) => p(String((err as Error & { id?: string }).id));
    const errA = new Error("boom") as Error & { id: string };
    errA.id = "A";
    const errB = new Error("boom") as Error & { id: string };
    errB.id = "B";

    const a = ErrorBoundary({ fallback }, () => {
      throw errA;
    });
    document.body.appendChild(a);
    await tick();

    const b = ErrorBoundary({ fallback }, () => {
      throw errB;
    });
    document.body.appendChild(b);
    await tick();

    expect(a.textContent).toContain("A");
    expect(b.textContent).toContain("B");

    document.body.removeChild(a);
    document.body.removeChild(b);
  });
});

// ── CO-4: derived equals caches value identity but does not gate effects ─────
describe("CO-4 — derived equals caches the value (documented behavior)", () => {
  it("preserves the previous value reference when equals reports unchanged", () => {
    const [n, setN] = signal(1);
    const boxed = derived(() => ({ v: n() > 0 }), { equals: (a, b) => a.v === b.v });
    const first = boxed();
    setN(2); // n changes but the derived's .v is still true
    const second = boxed();
    // Value identity is preserved by equals (this is what equals controls).
    expect(second).toBe(first);
  });
});

// ── CO-5: asyncDerived must be disposable ────────────────────────────────────
describe("CO-5 — asyncDerived exposes dispose", () => {
  it("stops re-running after dispose", async () => {
    const [n, setN] = signal(0);
    let calls = 0;
    const ad = asyncDerived(async () => {
      calls++;
      return n();
    }, -1);
    expect(calls).toBe(1); // initial run is synchronous

    ad.dispose();
    setN(5);
    await tick();
    expect(calls).toBe(1); // no re-fetch after dispose
  });
});

// ── CO-6: enhance().attr must honor the shared sanitization policy ───────────
describe("CO-6 — enhance().attr sanitizes like bindAttribute", () => {
  it("blocks javascript: URLs and refuses on* handler attributes", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = document.createElement("a");
    document.body.appendChild(root);

    enhance(root, (ctx) => {
      ctx.attr(null, "href", () => "javascript:alert(1)");
      ctx.attr(null, "onclick", () => "alert(1)");
    });

    // javascript: URL is rejected (sanitizeUrl returns "").
    expect(root.getAttribute("href")).toBe("");
    // Event-handler attribute is never written.
    expect(root.hasAttribute("onclick")).toBe(false);

    document.body.removeChild(root);
    warn.mockRestore();
  });
});

// ── Minors ───────────────────────────────────────────────────────────────────
describe("minor fixes", () => {
  it("#4 html refuses to build blocked tags (<script>)", () => {
    expect(() => html`<script src=${"/x.js"}></script>`).toThrow(/blocked/);
  });

  it("#10 math() is created in the MathML namespace", () => {
    const el = math();
    expect(el.namespaceURI).toBe("http://www.w3.org/1998/Math/MathML");
  });
});
