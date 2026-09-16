import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispose } from "../src/core/rendering/dispose";
import { div } from "../src/core/rendering/html";
import { signal } from "../src/core/signals/signal";
import { type AdapterConfig, componentAdapter } from "../src/ecosystem/ui/componentAdapter";
import { checkA11y, checkKeyboardAccess, checkLandmarks } from "../src/testing/a11y";
import { createCypressAdapter, createPlaywrightAdapter } from "../src/testing/adapters";
import { assertDOMEquals, createDOMSnapshot, createHttpMock } from "../src/testing/e2e";
import { snapshotComponent } from "../src/testing/snapshot";
import { captureFingerprint, compareFingerprints } from "../src/testing/visualRegression";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = "";
  for (const s of document.head.querySelectorAll("style[data-batch9]")) s.remove();
});

const config: AdapterConfig = {
  name: "test-ui",
  prefix: "tui",
  components: {
    Button: {
      tag: "button",
      baseClass: "tui-button",
      variants: { primary: "tui-button--primary" },
      sizes: { sm: "tui-button--sm" },
    },
  },
};

// ---------------------------------------------------------------------------
// 96. Adapted components accept positional children.
// ---------------------------------------------------------------------------
describe("componentAdapter positional children", () => {
  const { Button } = componentAdapter(config).components;

  it("renders text, arrays, nodes and reactive children", () => {
    expect(Button({ variant: "primary" }, "Save").textContent).toBe("Save");

    const icon = document.createElement("i");
    icon.textContent = "*";
    const withArray = Button({}, [icon, " Label"]);
    expect(withArray.firstChild).toBe(icon);
    expect(withArray.textContent).toBe("* Label");

    const [label, setLabel] = signal("one");
    const reactive = Button({}, () => label());
    expect(reactive.textContent).toBe("one");
    setLabel("two");
    expect(reactive.textContent).toBe("two");
    dispose(reactive);
  });

  it("falls back to `nodes` when no positional children are given", () => {
    expect(Button({ nodes: "from nodes" }).textContent).toBe("from nodes");
  });

  it("positional children take precedence over `nodes`", () => {
    const el = Button({ nodes: "ignored" }, "positional");
    expect(el.textContent).toBe("positional");
  });

  it("still applies variant and size classes with children", () => {
    const el = Button({ variant: "primary", size: "sm" }, "x");
    expect(el.className).toBe("tui-button tui-button--primary tui-button--sm");
  });
});

// ---------------------------------------------------------------------------
// 97. The adapter's theme drives its components.
// ---------------------------------------------------------------------------
describe("componentAdapter theme wiring", () => {
  it("class overrides set before creation apply", () => {
    const adapter = componentAdapter(config);
    adapter.theme.setTheme({ classOverrides: { "Button-primary": "custom-primary" } });
    const el = adapter.components.Button({ variant: "primary" });
    expect(el.className).toBe("tui-button custom-primary");
  });

  it("theme updates after creation update existing components", () => {
    const adapter = componentAdapter(config);
    const el = adapter.components.Button({ variant: "primary" }, "x");
    expect(el.className).toBe("tui-button tui-button--primary");

    adapter.theme.setTheme({ classOverrides: { Button: "my-button" } });
    expect(el.className).toBe("my-button tui-button--primary");

    adapter.theme.setTheme({ prefix: "new", classOverrides: {} });
    expect(el.className).toBe("new-button new-button--primary");
    dispose(el);
  });

  it("user classes are kept alongside theme classes", () => {
    const adapter = componentAdapter(config);
    const el = adapter.components.Button({ variant: "primary", class: "extra" });
    adapter.theme.setTheme({ prefix: "p" });
    expect(el.className).toBe("p-button p-button--primary extra");
    dispose(el);
  });

  it("applyTo() installs and removes CSS variables reactively", () => {
    const adapter = componentAdapter(config);
    const root = document.createElement("div");
    root.style.setProperty("--keep", "1");
    adapter.theme.setTheme({ variables: { "--accent": "red", "--radius": "4px" } });

    const release = adapter.theme.applyTo(root);
    expect(root.style.getPropertyValue("--accent")).toBe("red");
    expect(root.style.getPropertyValue("--radius")).toBe("4px");

    adapter.theme.setTheme({ variables: { "--accent": "blue" } });
    expect(root.style.getPropertyValue("--accent")).toBe("blue");
    expect(root.style.getPropertyValue("--radius")).toBe("");

    release();
    expect(root.style.getPropertyValue("--accent")).toBe("");
    expect(root.style.getPropertyValue("--keep")).toBe("1");

    adapter.theme.setTheme({ variables: { "--accent": "green" } });
    expect(root.style.getPropertyValue("--accent")).toBe("");
  });

  it("disposing a component releases its reactive class binding", () => {
    const adapter = componentAdapter(config);
    const el = adapter.components.Button({ variant: "primary" });
    dispose(el);
    adapter.theme.setTheme({ prefix: "after" });
    expect(el.className).toBe("tui-button tui-button--primary");
  });
});

// ---------------------------------------------------------------------------
// 98–100. createHttpMock handles Request inputs, cancellation, exact routes.
// ---------------------------------------------------------------------------
describe("createHttpMock fetch fidelity", () => {
  let original: typeof fetch;
  beforeEach(() => {
    original = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = original;
  });

  it("reads method, headers and body from a Request", async () => {
    const seen: Array<{ method: string; body: unknown; token: string | null }> = [];
    const mock = createHttpMock([
      {
        method: "POST",
        url: "/echo",
        response: ({ method, body, headers }) => {
          seen.push({ method, body, token: headers.get("x-token") });
          return { body: { ok: true } };
        },
      },
    ]);
    mock.install();

    const request = new Request("https://example.test/echo", {
      method: "POST",
      headers: { "x-token": "secret" },
      body: JSON.stringify({ value: 1 }),
    });
    const response = await fetch(request);

    expect(response.status).toBe(200);
    expect(seen).toEqual([{ method: "POST", body: { value: 1 }, token: "secret" }]);
    expect(request.bodyUsed).toBe(false);
    expect(mock.getRequests()[0].method).toBe("POST");
    mock.restore();
  });

  it("init overrides the Request's method, headers and body", async () => {
    const seen: unknown[] = [];
    const mock = createHttpMock([
      {
        method: "PUT",
        url: "/echo",
        response: ({ body, headers }) => {
          seen.push({ body, h: headers.get("x-mode") });
          return { body: "ok" };
        },
      },
    ]);
    mock.install();

    await fetch(new Request("https://example.test/echo", { method: "POST", body: "old", headers: { "x-mode": "a" } }), {
      method: "PUT",
      body: "new text",
      headers: { "x-mode": "b" },
    });

    expect(seen).toEqual([{ body: "new text", h: "b" }]);
    mock.restore();
  });

  // FormData, URLSearchParams and Blob bodies are covered in
  // http-mock-bodies.test.ts, which runs under Node: jsdom's implementations of
  // those classes are not accepted by the runtime's Request.

  it("rejects immediately for a pre-aborted signal", async () => {
    const handler = vi.fn(() => ({ body: "x" }));
    const mock = createHttpMock([{ url: "/slow", response: handler }]);
    mock.install();
    const controller = new AbortController();
    controller.abort();

    await expect(fetch("/slow", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(handler).not.toHaveBeenCalled();
    mock.restore();
  });

  it("rejects when aborted during a delay, via init or Request signal", async () => {
    const mock = createHttpMock([{ url: "/slow", response: { delay: 1000, body: "finished" } }]);
    mock.install();

    const viaInit = new AbortController();
    const pending1 = fetch("/slow", { signal: viaInit.signal });
    viaInit.abort();
    await expect(pending1).rejects.toMatchObject({ name: "AbortError" });

    const viaRequest = new AbortController();
    // jsdom's AbortSignal is not accepted by the runtime's Request constructor,
    // so expose it through the `signal` accessor instead.
    class SignalRequest extends Request {
      override get signal(): AbortSignal {
        return viaRequest.signal;
      }
    }
    const pending2 = fetch(new SignalRequest("https://example.test/slow"));
    viaRequest.abort();
    await expect(pending2).rejects.toMatchObject({ name: "AbortError" });
    mock.restore();
  });

  it("an abort after settlement changes nothing", async () => {
    const mock = createHttpMock([{ url: "/fast", response: { body: "done" } }]);
    mock.install();
    const controller = new AbortController();
    const response = await fetch("/fast", { signal: controller.signal });
    controller.abort();
    expect(await response.text()).toBe("done");
    mock.restore();
  });

  it("a string path route does not match a longer path that merely ends with it", async () => {
    const mock = createHttpMock([{ url: "/api/users", response: { body: "matched" } }]);
    mock.install();

    expect((await fetch("https://example.test/evil/api/users")).status).toBe(404);
    expect(await (await fetch("https://example.test/api/users")).text()).toBe("matched");
    expect(await (await fetch("/api/users?page=2#top")).text()).toBe("matched");
    expect((await fetch("/api/users/")).status).toBe(404);
    mock.restore();
  });

  it("an absolute string route matches that exact URL only", async () => {
    const mock = createHttpMock([{ url: "https://a.test/data", response: { body: "a" } }]);
    mock.install();
    expect(await (await fetch("https://a.test/data")).text()).toBe("a");
    expect((await fetch("https://b.test/data")).status).toBe(404);
    mock.restore();
  });

  it("a route with a query matches that query exactly", async () => {
    const mock = createHttpMock([{ url: "/search?q=a", response: { body: "hit" } }]);
    mock.install();
    expect(await (await fetch("/search?q=a")).text()).toBe("hit");
    expect((await fetch("/search?q=b")).status).toBe(404);
    mock.restore();
  });
});

// ---------------------------------------------------------------------------
// 101. DOM serialization is unambiguous.
// ---------------------------------------------------------------------------
describe("unambiguous DOM serialization", () => {
  function collision() {
    const a = document.createElement("div");
    a.setAttribute("a", 'x" b="y');
    const b = document.createElement("div");
    b.setAttribute("a", "x");
    b.setAttribute("b", "y");
    return { a, b };
  }

  it("createDOMSnapshot distinguishes the attribute collision", () => {
    const { a, b } = collision();
    expect(createDOMSnapshot(a)).not.toBe(createDOMSnapshot(b));
    expect(() => assertDOMEquals(a, b)).toThrow();
  });

  it("snapshotComponent distinguishes it too", () => {
    const { a, b } = collision();
    expect(snapshotComponent(() => a as HTMLElement)).not.toBe(snapshotComponent(() => b as HTMLElement));
  });

  it("visual fingerprints distinguish it too", () => {
    const { a, b } = collision();
    expect(captureFingerprint(a).hash).not.toBe(captureFingerprint(b).hash);
  });

  it("text that looks like markup does not collide with real markup", () => {
    const text = document.createElement("div");
    text.textContent = "<span>hi</span>";
    const real = document.createElement("div");
    real.innerHTML = "<span>hi</span>";
    expect(createDOMSnapshot(text)).not.toBe(createDOMSnapshot(real));
    expect(createDOMSnapshot(text)).toContain("&lt;span&gt;");
  });

  it("escapes ampersands and comment delimiters", () => {
    const el = document.createElement("div");
    el.setAttribute("title", "a & b");
    el.appendChild(document.createComment(" x --> <b> "));
    const out = snapshotComponent(() => el);
    expect(out).toContain('title="a &amp; b"');
    expect(out).not.toContain("--> <b>");
  });

  it("attribute order is deterministic", () => {
    const one = document.createElement("div");
    one.setAttribute("z", "1");
    one.setAttribute("a", "2");
    const two = document.createElement("div");
    two.setAttribute("a", "2");
    two.setAttribute("z", "1");
    expect(createDOMSnapshot(one)).toBe(createDOMSnapshot(two));
  });
});

// ---------------------------------------------------------------------------
// 102. Cypress/Playwright selector builders escape quoted values.
// ---------------------------------------------------------------------------
describe("selector builders escape values", () => {
  const TRICKY = ['save"draft', "back\\slash", "a]b", "two words", "line\nbreak"];

  for (const value of TRICKY) {
    it(`builds valid selectors that match ${JSON.stringify(value)} exactly`, () => {
      const el = document.createElement("div");
      el.setAttribute("data-testid", value);
      el.setAttribute("role", value);
      el.setAttribute("aria-label", value);
      el.setAttribute("data-kind", value);
      document.body.appendChild(el);

      const cy = createCypressAdapter().commands;
      const pw = createPlaywrightAdapter().selectors;
      for (const selector of [
        cy.getByTestId(value),
        cy.getByRole(value),
        pw.byTestId(value),
        pw.byRole(value),
        pw.byAriaLabel(value),
        pw.byDataAttr("kind", value),
      ]) {
        expect(document.querySelector(selector)).toBe(el);
      }
    });
  }

  it("an injection string cannot widen the selector", () => {
    const decoy = document.createElement("div");
    decoy.setAttribute("data-testid", "x");
    document.body.appendChild(decoy);
    const selector = createCypressAdapter().commands.getByTestId('x"], [data-testid="x');
    expect(document.querySelectorAll(selector)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 103. Accessibility checks include the root element itself.
// ---------------------------------------------------------------------------
describe("a11y checks include the root", () => {
  it("an unlabeled root input fails the forms check", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    expect(checkA11y(input, { checks: ["forms"], level: "error" }).passed).toBe(false);
  });

  it("a root img without alt is reported", () => {
    const img = document.createElement("img");
    expect(checkA11y(img, { checks: ["images"], level: "error" }).passed).toBe(false);
  });

  it("an unnamed root button is reported", () => {
    const button = document.createElement("button");
    expect(checkA11y(button, { checks: ["links"], level: "error" }).violations.length).toBeGreaterThan(0);
  });

  it("a root with an invalid role is reported", () => {
    const el = document.createElement("div");
    el.setAttribute("role", "not-a-role");
    expect(checkA11y(el, { checks: ["aria"], level: "error" }).violations.length).toBeGreaterThan(0);
  });

  it("a root positive tabindex is reported", () => {
    const el = document.createElement("div");
    el.setAttribute("tabindex", "5");
    expect(checkA11y(el, { checks: ["tabOrder"], level: "warning" }).warnings.length).toBeGreaterThan(0);
  });

  it("a root <main> satisfies the main-landmark rule", () => {
    const main = document.createElement("main");
    main.appendChild(document.createElement("p"));
    const messages = checkLandmarks(main).map((v) => v.message);
    expect(messages.some((m) => /main/i.test(m) && /no|missing|should have/i.test(m))).toBe(false);
  });

  it("descendant elements are still checked, without duplicates", () => {
    const root = document.createElement("section");
    root.appendChild(document.createElement("img"));
    const result = checkA11y(root, { checks: ["images"], level: "error" });
    expect(result.violations.filter((v) => v.rule === "img-alt" || /alt/i.test(v.message))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 104. Keyboard checks see framework-attached click handlers.
// ---------------------------------------------------------------------------
describe("keyboard access sees on.click", () => {
  it("a div with on.click and no keyboard support is reported, as root or descendant", () => {
    const clickable = div({ on: { click() {} } }, "Clickable") as HTMLElement;
    expect(checkKeyboardAccess(clickable).length).toBeGreaterThan(0);

    const root = document.createElement("section");
    root.append(div({ on: { click() {} } }, "Clickable"));
    const violations = checkKeyboardAccess(root);
    expect(violations.some((v) => v.level === "error")).toBe(true);
  });

  it("a keyboard-accessible custom control passes", () => {
    const el = div({ role: "button", tabindex: "0", on: { click() {}, keydown() {} } }, "OK") as HTMLElement;
    expect(checkKeyboardAccess(el).filter((v) => v.level === "error")).toEqual([]);
  });

  it("native controls with on.click pass", () => {
    const root = document.createElement("section");
    root.append(document.createElement("button"));
    const button = root.querySelector("button")!;
    button.textContent = "go";
    root.replaceChildren(
      (() => {
        const b = document.createElement("button");
        b.textContent = "go";
        return b;
      })(),
    );
    expect(checkKeyboardAccess(root)).toEqual([]);
  });

  it("non-activation listeners alone do not flag an element", () => {
    const el = div({ on: { mouseenter() {}, focusin() {} } }, "hover") as HTMLElement;
    expect(checkKeyboardAccess(el)).toEqual([]);
  });

  it("pointer activation counts as click activation", () => {
    const el = div({ on: { pointerdown() {} } }, "press") as HTMLElement;
    expect(checkKeyboardAccess(el).some((v) => v.level === "error")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 106. Visual fingerprints include computed appearance.
// ---------------------------------------------------------------------------
describe("visual fingerprints include computed styles", () => {
  it("a stylesheet-only change is detected", () => {
    const style = document.createElement("style");
    style.setAttribute("data-batch9", "");
    document.head.appendChild(style);
    const el = document.createElement("div");
    el.className = "card";
    document.body.appendChild(el);

    style.textContent = ".card { color: red; display: block; }";
    const before = captureFingerprint(el);
    style.textContent = ".card { color: blue; display: block; }";
    const after = captureFingerprint(el);

    expect(before.hash).not.toBe(after.hash);
    const result = compareFingerprints(before, after);
    expect(result.match).toBe(false);
    expect(result.changes.some((c) => c.type === "computed")).toBe(true);
  });

  it("identical appearance produces identical fingerprints", () => {
    const style = document.createElement("style");
    style.setAttribute("data-batch9", "");
    style.textContent = ".x { color: green; }";
    document.head.appendChild(style);
    const make = () => {
      const el = document.createElement("div");
      el.className = "x";
      document.body.appendChild(el);
      return el;
    };
    expect(captureFingerprint(make()).hash).toBe(captureFingerprint(make()).hash);
  });
});
