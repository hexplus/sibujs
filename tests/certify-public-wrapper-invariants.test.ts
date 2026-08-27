/**
 * CERTIFICATION — public peripheral API invariants.
 *
 * The reactive core enforces four guarantees internally. This suite asserts the
 * REST of the public surface obeys them too, because the bugs this pass closed
 * were not seventeen unrelated defects — they were four invariants that stopped
 * at the core's edge:
 *
 *   1. SECURITY PARITY   equivalent attribute APIs reach the same verdict
 *   2. LIFECYCLE PARITY  removing an owned tree disposes it
 *   3. ASYNC OWNERSHIP   a completion after disposal is a no-op
 *   4. WRAPPER PARITY    a convenience wrapper keeps the primitive's guarantees
 *
 * Where the detailed per-module regressions live in `hardening-*.test.ts`, this
 * file is the cross-cutting statement: it compares APIs AGAINST EACH OTHER, so
 * a future writer/wrapper that quietly reintroduces a divergence fails here even
 * if its own module's tests pass.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clipboard } from "../src/browser/clipboard";
import { permissions } from "../src/browser/permissions";
import { title } from "../src/browser/title";
import { dispose, registerDisposer } from "../src/core/rendering/dispose";
import { div } from "../src/core/rendering/html";
import { svgElement } from "../src/platform/customElement";
import { Head } from "../src/platform/head";
import { createMicroApp } from "../src/platform/microfrontend";
import { clearWasmCache, loadWasmModule, loadWasmModuleWithOptions, wasm } from "../src/platform/wasm";
import { bindAttribute } from "../src/reactivity/bindAttribute";
import { bindAttrs } from "../src/ui/reactiveAttr";
import { setSafeAttribute } from "../src/utils/setSafeAttribute";

// ---------------------------------------------------------------------------
// 1. SECURITY PARITY
// ---------------------------------------------------------------------------

/** Every public way to commit an attribute, as a uniform (name, value) writer. */
const WRITERS: Array<{ name: string; write: (name: string, value: unknown) => Element }> = [
  {
    name: "tagFactory static prop",
    write: (n, v) => div({ [n]: v }) as HTMLElement,
  },
  {
    name: "bindAttrs static value",
    write: (n, v) => {
      const el = document.createElement("a");
      bindAttrs(el, { [n]: v as string });
      return el;
    },
  },
  {
    name: "bindAttrs reactive getter",
    write: (n, v) => {
      const el = document.createElement("a");
      bindAttrs(el, { [n]: () => v as string });
      return el;
    },
  },
  {
    name: "bindAttribute",
    write: (n, v) => {
      const el = document.createElement("a");
      bindAttribute(el, n, () => v);
      return el;
    },
  },
  {
    name: "setSafeAttribute",
    write: (n, v) => {
      const el = document.createElement("a");
      setSafeAttribute(el, n, v);
      return el;
    },
  },
];

const DANGEROUS: Array<{ attr: string; value: string; mustNotContain: string }> = [
  { attr: "href", value: "javascript:alert(1)", mustNotContain: "javascript:" },
  { attr: "href", value: "JaVaScRiPt:alert(1)", mustNotContain: "script:" },
  { attr: "href", value: "vbscript:msgbox(1)", mustNotContain: "vbscript:" },
  { attr: "href", value: "data:text/html,<script>alert(1)</script>", mustNotContain: "data:text/html" },
  { attr: "src", value: "javascript:alert(1)", mustNotContain: "javascript:" },
  { attr: "formaction", value: "javascript:alert(1)", mustNotContain: "javascript:" },
  { attr: "ping", value: "javascript:alert(1)", mustNotContain: "javascript:" },
  { attr: "poster", value: "javascript:alert(1)", mustNotContain: "javascript:" },
  { attr: "style", value: "background: url(https://attacker.example/x)", mustNotContain: "url(" },
  { attr: "srcset", value: "javascript:alert(1) 1x", mustNotContain: "javascript:" },
];

describe("certification: security parity across attribute writers", () => {
  for (const { attr, value, mustNotContain } of DANGEROUS) {
    it(`every writer blocks ${attr}=${JSON.stringify(value.slice(0, 28))}`, () => {
      const verdicts = WRITERS.map((w) => ({
        writer: w.name,
        result: w.write(attr, value).getAttribute(attr) ?? "",
      }));

      for (const v of verdicts) {
        expect(v.result, `${v.writer} let a dangerous ${attr} through`).not.toContain(mustNotContain);
      }
      // …and they must all agree, not merely all be "safe enough".
      const distinct = new Set(verdicts.map((v) => v.result));
      expect(distinct.size, `writers disagreed: ${JSON.stringify(verdicts)}`).toBe(1);
    });
  }

  const SAFE = [
    { attr: "href", value: "https://example.com/a?b=1#c" },
    { attr: "href", value: "/relative/path" },
    { attr: "href", value: "mailto:a@b.com?subject=Hello World" },
    { attr: "aria-label", value: "Close dialog" },
    { attr: "data-payload", value: "<not-html>" },
    { attr: "title", value: "a & b < c" },
  ];

  for (const { attr, value } of SAFE) {
    it(`every writer preserves a safe ${attr}`, () => {
      const results = WRITERS.map((w) => w.write(attr, value).getAttribute(attr));
      for (const r of results) expect(r).toBe(value);
    });
  }

  it("every writer refuses on* event-handler attributes", () => {
    for (const name of ["onclick", "onerror", "onload", "ONCLICK", "onFocus"]) {
      for (const w of WRITERS) {
        const el = w.write(name, "alert(1)");
        expect(el.hasAttribute(name), `${w.name} allowed ${name}`).toBe(false);
        expect(el.hasAttribute(name.toLowerCase()), `${w.name} allowed ${name}`).toBe(false);
      }
    }
  });

  it("the SVG helper agrees with the HTML writers", () => {
    for (const { attr, value, mustNotContain } of DANGEROUS) {
      // `poster`/`srcset` are HTML-only sinks; the shared policy still applies.
      const svg = svgElement("a", { [attr]: value });
      expect(svg.getAttribute(attr) ?? "", `svgElement let ${attr} through`).not.toContain(mustNotContain);
    }
  });

  it("the SVG helper routes xlink:href through the URL policy in its namespace", () => {
    const blocked = svgElement("use", { "xlink:href": "javascript:alert(1)" });
    expect(blocked.getAttributeNS("http://www.w3.org/1999/xlink", "href") ?? "").not.toContain("javascript:");

    const allowed = svgElement("use", { "xlink:href": "#icon" });
    expect(allowed.getAttributeNS("http://www.w3.org/1999/xlink", "href")).toBe("#icon");
  });
});

// ---------------------------------------------------------------------------
// 2. LIFECYCLE PARITY
// ---------------------------------------------------------------------------

describe("certification: DOM removal implies disposal", () => {
  it("a micro-app remount disposes the outgoing tree exactly once", () => {
    let disposals = 0;
    const app = createMicroApp({ name: "cert" });
    const a = div("A") as HTMLElement;
    registerDisposer(a, () => {
      disposals++;
    });

    app.mount(() => a);
    app.mount(() => div("B") as HTMLElement);
    app.unmount();

    expect(disposals).toBe(1);
  });

  it("a Head releases the document title it owned", () => {
    const before = document.title;
    const head = Head({ title: "Owned" });
    expect(document.title).toBe("Owned");
    dispose(head);
    expect(document.title).toBe(before);
  });

  it("overlapping title owners hand back in stack order", () => {
    const before = document.title;
    const a = title("A");
    const b = title("B");
    const c = title("C");

    b(); // release a NON-active owner
    expect(document.title).toBe("C");
    c();
    expect(document.title).toBe("A");
    a();
    expect(document.title).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 3. ASYNC OWNERSHIP
// ---------------------------------------------------------------------------

describe("certification: async completion after disposal is a no-op", () => {
  const originalNavigator = globalThis.navigator;

  afterEach(() => {
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      configurable: true,
      writable: true,
    });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function installNavigator(value: unknown) {
    Object.defineProperty(globalThis, "navigator", { value, configurable: true, writable: true });
  }

  it("clipboard: a write resolving after dispose writes no state", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    installNavigator({ clipboard: { writeText: () => gate } });

    const cb = clipboard();
    const pending = cb.copy("secret");
    cb.dispose();
    release();
    await pending;

    expect(cb.text()).toBe("");
    expect(cb.copied()).toBe(false);
  });

  it("permissions: a query rejecting after dispose writes no state", async () => {
    let reject!: (e: unknown) => void;
    const query = new Promise((_r, rj) => {
      reject = rj;
    });
    installNavigator({ permissions: { query: () => query } });

    const p = permissions("camera");
    p.dispose();
    reject(new Error("nope"));
    await query.catch(() => {});
    await Promise.resolve();

    expect(p.state()).toBe("prompt");
  });
});

// ---------------------------------------------------------------------------
// 4. WRAPPER PARITY + CONCURRENCY
// ---------------------------------------------------------------------------

describe("certification: wrapper parity", () => {
  beforeEach(() => {
    clearWasmCache();
    (globalThis as Record<string, unknown>).WebAssembly = {} as unknown;
  });

  afterEach(() => {
    clearWasmCache();
    vi.restoreAllMocks();
  });

  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("wasm() can express every origin policy loadWasmModule() requires", async () => {
    // Refused identically with no policy…
    const noPolicy = wasm("https://cdn.example.com/a.wasm");
    await flush();
    expect(noPolicy.error()?.message).toMatch(/refused to fetch/);
    await expect(loadWasmModule("https://cdn.example.com/a.wasm")).rejects.toThrow(/refused to fetch/);

    // …and satisfiable identically with one.
    (globalThis as Record<string, unknown>).WebAssembly = {
      compile: vi.fn(async () => ({}) as WebAssembly.Module),
      instantiate: vi.fn(async () => ({ exports: {} }) as unknown as WebAssembly.Instance),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(8) })),
    );

    const withPolicy = wasm("https://cdn.example.com/b.wasm", {
      allowedOrigins: ["https://cdn.example.com"],
    });
    await flush();
    expect(withPolicy.error()).toBeNull();
    expect(withPolicy.ready()).toBe(true);
  });

  it("a keyed WASM load is one instance under concurrency", async () => {
    let instantiations = 0;
    (globalThis as Record<string, unknown>).WebAssembly = {
      compile: vi.fn(async () => ({}) as WebAssembly.Module),
      instantiate: vi.fn(async () => {
        instantiations++;
        await new Promise((r) => setTimeout(r, 5));
        return { exports: { n: instantiations } } as unknown as WebAssembly.Instance;
      }),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(8) })),
    );

    const opts = { allowedOrigins: ["https://cdn.example.com"], cacheKey: "cert-key" };
    const results = await Promise.all([
      loadWasmModuleWithOptions("https://cdn.example.com/c.wasm", opts),
      loadWasmModuleWithOptions("https://cdn.example.com/c.wasm", opts),
      loadWasmModuleWithOptions("https://cdn.example.com/c.wasm", opts),
    ]);

    expect(instantiations).toBe(1);
    expect(new Set(results).size).toBe(1);
  });
});
