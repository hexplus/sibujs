// @vitest-environment node
//
// The built-in server DOM (`sibujs/ssr/dom`): renders with no DOM library
// registered, matches jsdom's output byte for byte, and names the API (and the
// caller) when a component reaches for something only a browser has.

import { Window as HappyWindow } from "happy-dom";
// @ts-expect-error — jsdom ships no types here; this is a test-only import.
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { match, when } from "../src/core/rendering/directives";
import { each } from "../src/core/rendering/each";
import {
  a,
  button,
  canvas,
  div,
  h1,
  input,
  label,
  li,
  linearGradient,
  option,
  p,
  path,
  select,
  span,
  svg,
  textarea,
  ul,
  use,
} from "../src/core/rendering/html";
import { signal } from "../src/core/signals/signal";
import { query } from "../src/data/query";
import { installServerDom, isServerDom, type ServerDocument } from "../src/platform/serverDom";
import { renderToString } from "../src/platform/ssr";
import { renderToStringAsync } from "../src/platform/ssrAsync";

const DOM_GLOBALS = [
  "window",
  "document",
  "Node",
  "Element",
  "HTMLElement",
  "DocumentFragment",
  "SVGElement",
  "Text",
  "Comment",
  "MutationObserver",
  "NodeFilter",
  "CustomEvent",
];

function withJsdom<T>(fn: () => Promise<T>): Promise<T> {
  return withWindow(new JSDOM("").window, fn);
}

function withHappyDom<T>(fn: () => Promise<T>): Promise<T> {
  return withWindow(new HappyWindow() as unknown as Record<string, unknown>, fn);
}

function withWindow<T>(window: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const saved = new Map(DOM_GLOBALS.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  for (const key of DOM_GLOBALS) {
    if (key === "CustomEvent") continue;
    Object.defineProperty(globalThis, key, {
      value: key === "window" ? window : window[key],
      configurable: true,
      writable: true,
    });
  }
  return fn().finally(() => {
    for (const [key, desc] of saved) {
      if (desc) Object.defineProperty(globalThis, key, desc);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  });
}

async function withServerDom<T>(fn: () => Promise<T>): Promise<T> {
  const uninstall = installServerDom();
  try {
    return await fn();
  } finally {
    uninstall();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

const delay = <T>(ms: number, value: T): Promise<T> => new Promise((r) => setTimeout(() => r(value), ms));

/** A page touching every serializer path: attributes, style map, SVG, forms, directives, escaping. */
function KitchenSink(options: { cssShorthand?: boolean } = {}) {
  const stringStyle =
    options.cssShorthand === false ? "padding-top: 2px" : "padding: 2px; background: url(https://evil.example/x.png)";
  const [items] = signal([
    { id: 1, name: "Mug <b>" },
    { id: 2, name: 'Cap "red"' },
  ]);
  const [mode] = signal("grid");
  const q = query("catalog", () => delay(3, { title: "Catálogo & más" }));
  return div({ class: "page", id: "root", "data-section": "landing", "aria-live": "polite" }, [
    h1(() => q.data()?.title ?? "…"),
    p({ style: { color: "red", marginTop: "4px", "--accent": "blue" } }, "styled"),
    p({ style: stringStyle }, "string style"),
    a({ href: "javascript:alert(1)", title: "x" }, "bad link"),
    a({ href: "/ok?x=1&y=2" }, "good link"),
    label({ for: "email" }, "Email"),
    input({ id: "email", type: "email", value: "a@b.c", disabled: true, placeholder: "you@example.com" }),
    input({ type: "checkbox", checked: true }),
    textarea({ name: "msg" }, "hello <world>"),
    select({ name: "service" }, [option({ value: "dtf" }, "DTF"), option({ value: "vinyl", selected: true }, "Vinyl")]),
    button({ type: "submit", disabled: false }, "Send"),
    svg({ viewBox: "0 0 10 10", class: "icon" }, [
      use({ "xlink:href": "#star", href: "#star" }),
      linearGradient({ id: "g1" }),
      path({ d: "M0 0L10 10", "stroke-width": "2" }),
    ]),
    canvas({ width: "40", height: "40" }),
    when(
      () => mode() === "grid",
      () => ul([each(items, (item) => li({ "data-id": () => String(item().id) }, item().name), { key: (x) => x.id })]),
      () => span("list"),
    ),
    match(() => mode(), { grid: () => span("grid-mode"), list: () => span("list-mode") }),
    span(() => "reactive & <text>"),
  ]);
}

describe("server DOM", () => {
  it("renders without any DOM library registered", async () => {
    expect(typeof (globalThis as { document?: unknown }).document).toBe("undefined");
    const { html } = await renderToStringAsync(() => KitchenSink());
    // renderToStringAsync installed the server DOM on demand.
    expect(isServerDom()).toBe(true);
    expect(html).toContain("Catálogo &amp; más");
    expect(html).toContain('<li data-id="1">Mug &lt;b&gt;</li>');
    (globalThis as { document?: unknown }).document = undefined;
    delete (globalThis as { document?: unknown }).document;
  });

  it("produces byte-identical output to jsdom and happy-dom", async () => {
    const server = await withServerDom(() => renderToStringAsync(() => KitchenSink()));
    const reference = await withJsdom(() => renderToStringAsync(() => KitchenSink()));
    expect(server.html).toBe(reference.html);
    // happy-dom's CSSOM expands shorthands in a string `style` (`padding: 2px`
    // becomes four longhands; jsdom keeps it): shorthand serialization is
    // CSSOM-specific in every DOM. With longhands, the output is identical.
    const plainServer = await withServerDom(() => renderToStringAsync(() => KitchenSink({ cssShorthand: false })));
    const happy = await withHappyDom(() => renderToStringAsync(() => KitchenSink({ cssShorthand: false })));
    expect(plainServer.html).toBe(happy.html);
    expect(server.stateData).toEqual(
      expect.objectContaining({ q: { catalog: expect.objectContaining({ d: { title: "Catálogo & más" } }) } }),
    );
  });

  it("keeps the attribute policy: javascript: URLs, url() in style, on* handlers", async () => {
    const { html } = await withServerDom(() => renderToStringAsync(() => KitchenSink()));
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("evil.example");
    expect(html).toContain('<p style="padding: 2px">string style</p>');
    expect(html).toContain('<p style="color: red; margin-top: 4px; --accent: blue">styled</p>');
  });

  it("matches the browser's form-control semantics", async () => {
    await withServerDom(async () => {
      const el = input({ type: "checkbox", value: "x" }) as HTMLInputElement;
      el.checked = true;
      el.value = "typed";
      // State, not markup: neither write reflects (dirty value / checkedness).
      expect(renderToString(el)).toBe('<input type="checkbox" value="x" data-sibu-ssr="true" />');
      expect(el.value).toBe("typed");
      const b = button("x") as HTMLButtonElement;
      b.disabled = true;
      expect(b.getAttribute("disabled")).toBe("");
    });
  });

  it("implements the tree operations the runtime uses", async () => {
    await withServerDom(async () => {
      const doc = document as unknown as ServerDocument;
      const root = doc.createElement("div");
      const a1 = doc.createElement("span");
      const b1 = doc.createTextNode("b");
      const c1 = doc.createComment("c");
      root.append(a1, b1, c1);
      expect(root.childNodes.length).toBe(3);
      expect(a1.nextSibling).toBe(b1);
      expect(c1.previousSibling).toBe(b1);
      root.insertBefore(c1, a1);
      expect(root.firstChild).toBe(c1);
      expect(root.compareDocumentPosition(a1) & 16).toBe(16);
      expect(c1.compareDocumentPosition(b1) & 4).toBe(4);
      const frag = doc.createDocumentFragment();
      frag.append("x", doc.createElement("i"));
      root.appendChild(frag);
      expect(frag.childNodes.length).toBe(0);
      expect(root.lastChild?.nodeName).toBe("I");
      a1.classList.add("one", "two");
      a1.classList.toggle("one");
      expect(a1.className).toBe("two");
      expect(root.querySelector("span.two")).toBe(a1);
      expect(root.querySelectorAll("div > i, span").length).toBe(2);
      expect(a1.closest("div")).toBe(root);
      a1.remove();
      expect(a1.parentNode).toBeNull();
      expect(() => root.appendChild(root)).toThrow(/contains the parent/);
    });
  });

  it("dispatches bubbling, cancelable events (ErrorBoundary claims errors through one)", async () => {
    await withServerDom(async () => {
      const outer = document.createElement("div");
      const inner = document.createElement("span");
      outer.appendChild(inner);
      const seen: string[] = [];
      outer.addEventListener("ping", (e) => {
        seen.push(`outer:${(e.target as Element).tagName}`);
        e.preventDefault();
      });
      inner.addEventListener("ping", () => seen.push("inner"));
      const result = inner.dispatchEvent(new CustomEvent("ping", { bubbles: true, cancelable: true }));
      expect(seen).toEqual(["inner", "outer:SPAN"]);
      expect(result).toBe(false);
    });
  });

  it("delivers MutationObserver records in a microtask", async () => {
    await withServerDom(async () => {
      const root = document.createElement("div");
      const records: number[] = [];
      new MutationObserver((list) => records.push(list.length)).observe(root, { childList: true, subtree: true });
      root.appendChild(document.createElement("p"));
      root.firstChild?.appendChild(document.createTextNode("x"));
      expect(records).toEqual([]);
      await Promise.resolve();
      expect(records).toEqual([2]);
    });
  });

  it("names the API and the caller when a component uses a browser-only API", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await withServerDom(async () => {
      const Fancy = () => {
        const el = div("x");
        el.animate([{ opacity: 0 }], 100);
        return el;
      };
      await expect(renderToStringAsync(() => Fancy())).rejects.toThrow(
        /Element\.animate\(\) is not available in the SibuJS server DOM \(called from .*ssr-server-dom\.node\.test\.ts/,
      );
    });
  });

  it("answers canvas and font probes as unavailable, and reports them in diagnostics", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await withServerDom(async () => {
      const { diagnostics, html } = await renderToStringAsync(() => {
        const c = canvas() as HTMLCanvasElement;
        const ctx = c.getContext("2d");
        const fonts = (document as unknown as { fonts?: unknown }).fonts;
        return p(`${ctx === null} ${fonts === undefined}`);
      });
      expect(html).toContain("true true");
      expect(diagnostics.browserApis.some((s) => s.startsWith("HTMLCanvasElement.getContext() at "))).toBe(true);
      expect(diagnostics.browserApis.some((s) => s.startsWith("document.fonts at "))).toBe(true);
    });
    expect(warn.mock.calls.some((c) => String(c[0]).includes("ClientOnly()"))).toBe(true);
  });

  it("explains a browser global that does not exist on the server", async () => {
    await withServerDom(async () => {
      const Theme = () =>
        p(
          (globalThis as unknown as { window: { matchMedia(q: string): unknown } }) &&
            window.matchMedia("(prefers-color-scheme: dark)")
            ? "dark"
            : "light",
        );
      await expect(renderToStringAsync(() => Theme())).rejects.toThrow(
        /browser-only API `window` used during a server render \(.*ssr-server-dom\.node\.test\.ts.*\)\. Move the code into onMount\(\)/,
      );
    });
  });

  it("leaves an existing DOM in place", async () => {
    await withJsdom(async () => {
      const before = document;
      const uninstall = installServerDom();
      expect(document).toBe(before);
      uninstall();
    });
  });
});
