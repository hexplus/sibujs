// ============================================================================
// ssr.ts — extra coverage: DocumentFragment + comment + text + non-HTMLElement
// rendering, script/style stripping, invalid-tag rejection, URL-attr
// sanitization, void elements, error comments, renderToDocument (meta/link/
// scripts/bodyAttrs/headExtra/title, dangerous meta-refresh), hydrate with
// diagnostics (tag/attr/child-count mismatches + onMismatch), island id
// validation, hydrateIslands / hydrateProgressively (IntersectionObserver),
// streaming (renderToStream / collectStream / renderToReadableStream),
// suspense (ssrSuspense success + timeout, renderToSuspenseStream,
// suspenseSwapScript validation, resetSSRState), serialize/deserialize state
// (escaping, maxBytes, validate guard).
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectStream,
  deserializeState,
  escapeScriptJson,
  hydrate,
  hydrateIslands,
  hydrateProgressively,
  island,
  renderToDocument,
  renderToReadableStream,
  renderToStream,
  renderToString,
  renderToSuspenseStream,
  resetSSRState,
  serializeState,
  ssrSuspense,
  suspenseSwapScript,
  trustHTML,
} from "../src/platform/ssr";

const el = (tag: string) => document.createElement(tag);

describe("ssr.ts coverage2 — renderToString node types", () => {
  it("renders a DocumentFragment by joining its children", () => {
    const frag = document.createDocumentFragment();
    const a = el("span");
    a.textContent = "one";
    const b = el("span");
    b.textContent = "two";
    frag.append(a, b);
    const html = renderToString(frag);
    expect(html).toContain("one");
    expect(html).toContain("two");
  });

  it("escapes text nodes", () => {
    const node = document.createTextNode("<b>&");
    expect(renderToString(node)).toBe("&lt;b&gt;&amp;");
  });

  it("renders comment nodes and neutralizes comment terminators", () => {
    const node = document.createComment("hi --> bye <!-- x --");
    const out = renderToString(node);
    expect(out.startsWith("<!--")).toBe(true);
    expect(out.endsWith("-->")).toBe(true);
    // The inner --> must be neutralized so it can't close the comment early.
    expect(out.slice(4, -3)).not.toContain("-->");
  });

  it("serializes an SVG element as markup (with its text content escaped)", () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.textContent = "<svg-text>";
    const out = renderToString(svg as unknown as Node);
    expect(out).toContain("<svg");
    expect(out).toContain("&lt;svg-text&gt;");
    expect(out).toContain("</svg>");
  });

  it("emits an SSR error comment when a fragment child throws", () => {
    const frag = document.createDocumentFragment();
    const child = el("span");
    Object.defineProperty(child, "attributes", {
      get() {
        throw new Error("frag-child-explode");
      },
    });
    frag.appendChild(child);
    const out = renderToString(frag);
    expect(out).toContain("SSR error");
    expect(out).toContain("frag-child-explode");
  });

  it("strips <script> and <style> (dev emits a marker comment)", () => {
    const script = el("script");
    script.textContent = "alert(1)";
    const style = el("style");
    style.textContent = "body{}";
    // Dev mode (test env) emits a stripped marker rather than empty string.
    expect(renderToString(script)).toBe("<!--ssr:script-stripped-->");
    expect(renderToString(style)).toBe("<!--ssr:style-stripped-->");
  });

  it("drops on* event handlers and unsafe attribute names", () => {
    const div = el("div");
    div.setAttribute("onclick", "evil()");
    div.setAttribute("class", "ok");
    const out = renderToString(div);
    expect(out).not.toContain("onclick");
    expect(out).toContain('class="ok"');
  });

  it("sanitizes URL-bearing attributes and drops javascript: hrefs", () => {
    const a = el("a");
    a.setAttribute("href", "javascript:alert(1)");
    const out = renderToString(a);
    expect(out).not.toContain("javascript:");

    const img = el("img");
    img.setAttribute("src", "https://example.com/x.png");
    const imgOut = renderToString(img);
    expect(imgOut).toContain("https://example.com/x.png");
    // img is a void element -> self-closing.
    expect(imgOut.trim().endsWith("/>")).toBe(true);
  });

  it("adds data-sibu-ssr unless data-sibu-hydrate is present", () => {
    const div = el("div");
    expect(renderToString(div)).toContain('data-sibu-ssr="true"');

    const hydrated = el("div");
    hydrated.dataset.sibuHydrate = "1";
    expect(renderToString(hydrated)).not.toContain('data-sibu-ssr="true"');
  });

  it("escapes attribute values against quotes and angle brackets", () => {
    const div = el("div");
    div.setAttribute("title", `a"b'c<d>&`);
    const out = renderToString(div);
    expect(out).toContain("&quot;");
    expect(out).toContain("&#39;");
    expect(out).toContain("&lt;");
    expect(out).toContain("&gt;");
  });

  it("emits an SSR error comment when child rendering throws", () => {
    const parent = el("div");
    const child = el("span");
    // Force renderToString to throw while serializing the child by making
    // Array.from(child.childNodes) blow up via a poisoned attributes getter.
    Object.defineProperty(child, "attributes", {
      get() {
        throw new Error("attr-explode");
      },
    });
    parent.appendChild(child);
    const out = renderToString(parent);
    // Dev mode includes the message inside the SSR error comment.
    expect(out).toContain("SSR error");
    expect(out).toContain("attr-explode");
  });
});

describe("ssr.ts coverage2 — renderToDocument", () => {
  it("renders title, meta, links, scripts, bodyAttrs and trusted headExtra", () => {
    const doc = renderToDocument(
      () => {
        const d = el("div");
        d.textContent = "app";
        return d;
      },
      {
        title: "My <Page>",
        meta: [{ name: "description", content: "hello" }],
        links: [{ rel: "stylesheet", href: "https://cdn.example.com/a.css" }],
        scripts: ["https://cdn.example.com/app.js"],
        bodyAttrs: { class: "dark", onload: "evil()" },
        headExtra: trustHTML('<link rel="preconnect" href="https://x.com">'),
      },
    );

    expect(doc).toContain("<!DOCTYPE html>");
    expect(doc).toContain("<title>My &lt;Page&gt;</title>");
    expect(doc).toContain('name="description"');
    expect(doc).toContain('href="https://cdn.example.com/a.css"');
    expect(doc).toContain('<script src="https://cdn.example.com/app.js"></script>');
    expect(doc).toContain('class="dark"');
    // on* handler dropped from bodyAttrs.
    expect(doc).not.toContain("onload");
    expect(doc).toContain("preconnect");
    expect(doc).toContain("app");
  });

  it("drops a dangerous meta http-equiv=refresh with a javascript: url", () => {
    const doc = renderToDocument(() => el("div"), {
      meta: [{ "http-equiv": "refresh", content: "0;url=javascript:alert(1)" }],
    });
    expect(doc).not.toContain("javascript:");
    expect(doc).not.toContain("refresh");
  });

  it("drops scripts with unsafe src and links/metas that yield no safe attrs", () => {
    const doc = renderToDocument(() => el("div"), {
      scripts: ["javascript:alert(1)"],
      meta: [{ "on-bad": "x" } as Record<string, string>],
    });
    expect(doc).not.toContain("javascript:");
  });

  it("emits an SSR error comment when the root component throws", () => {
    const doc = renderToDocument(() => {
      throw new Error("root-boom");
    });
    expect(doc).toContain("SSR error");
    expect(doc).toContain("root-boom");
  });
});

describe("ssr.ts coverage2 — hydrate with diagnostics", () => {
  let container: HTMLElement;
  beforeEach(() => {
    container = el("div");
    document.body.appendChild(container);
  });
  afterEach(() => {
    container.remove();
  });

  it("replaces server content with the client tree and marks hydrated", () => {
    const server = el("p");
    server.textContent = "server";
    container.appendChild(server);

    hydrate(() => {
      const c = el("p");
      c.textContent = "client";
      return c;
    }, container);

    expect(container.getAttribute("data-sibu-hydrated")).toBe("true");
    expect(container.textContent).toBe("client");
  });

  it("reports a tag mismatch via onMismatch", () => {
    const server = el("section");
    container.appendChild(server);
    const onMismatch = vi.fn();

    hydrate(() => el("article"), container, { diagnostics: true, onMismatch });

    expect(onMismatch).toHaveBeenCalledTimes(1);
    expect(onMismatch.mock.calls[0][0].kind).toBe("tag");
  });

  it("reports an attribute mismatch and a missing-on-client attribute", () => {
    const server = el("div");
    server.setAttribute("data-x", "1");
    server.setAttribute("data-only-server", "yes");
    container.appendChild(server);
    const onMismatch = vi.fn();

    hydrate(
      () => {
        const c = el("div");
        c.setAttribute("data-x", "2"); // differing value
        return c;
      },
      container,
      { diagnostics: true, onMismatch },
    );

    expect(onMismatch).toHaveBeenCalled();
    expect(onMismatch.mock.calls[0][0].kind).toBe("attribute");
  });

  it("reports a child-count mismatch (client has extra node) and warns by default", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const server = el("div"); // no children
    container.appendChild(server);

    hydrate(
      () => {
        const c = el("div");
        c.appendChild(el("span"));
        return c;
      },
      container,
      { diagnostics: true },
    );

    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).toContain("[SibuJS hydration]");
    warn.mockRestore();
  });

  it("reports a node the server rendered but the client did not", () => {
    const server = el("div");
    server.appendChild(el("span"));
    container.appendChild(server);
    const onMismatch = vi.fn();

    hydrate(
      () => el("div"), // no children
      container,
      { diagnostics: true, onMismatch },
    );

    expect(onMismatch).toHaveBeenCalled();
    expect(onMismatch.mock.calls[0][0].kind).toBe("child-count");
  });

  it("reports a client-only attribute (present on client, missing on server)", () => {
    const server = el("div");
    container.appendChild(server);
    const onMismatch = vi.fn();

    hydrate(
      () => {
        const c = el("div");
        c.setAttribute("data-client", "1");
        return c;
      },
      container,
      { diagnostics: true, onMismatch },
    );

    expect(onMismatch).toHaveBeenCalled();
    const report = onMismatch.mock.calls[0][0];
    expect(report.kind).toBe("attribute");
    expect(report.serverValue).toBe("(missing)");
  });
});

describe("ssr.ts coverage2 — islands", () => {
  it("island() validates its id and tags the element", () => {
    const tagged = island("my-island", () => el("div"));
    expect(tagged.getAttribute("data-sibu-island")).toBe("my-island");
    expect(() => island("bad id!", () => el("div"))).toThrow(/island: id must match/);
  });

  it("hydrateIslands replaces marked islands and guards prototype pollution", () => {
    const container = el("div");
    const marker = el("div");
    marker.setAttribute("data-sibu-island", "foo");
    container.appendChild(marker);
    // A marker whose id is __proto__ must be ignored (hasOwn guard).
    const evil = el("div");
    evil.setAttribute("data-sibu-island", "__proto__");
    container.appendChild(evil);

    hydrateIslands(container, {
      foo: () => {
        const c = el("section");
        c.textContent = "hydrated";
        return c;
      },
    });

    expect(container.getAttribute("data-sibu-hydrated")).toBe("partial");
    const hydratedEl = container.querySelector('[data-sibu-island="foo"]');
    expect(hydratedEl?.tagName.toLowerCase()).toBe("section");
    expect(hydratedEl?.getAttribute("data-sibu-hydrated")).toBe("true");
  });

  it("hydrateIslands skips non-function factories", () => {
    const container = el("div");
    const marker = el("div");
    marker.setAttribute("data-sibu-island", "x");
    container.appendChild(marker);
    hydrateIslands(container, { x: "not-a-fn" as unknown as () => HTMLElement });
    // Marker remains untouched (still the original div, not hydrated).
    expect(container.querySelector('[data-sibu-island="x"]')?.getAttribute("data-sibu-hydrated")).toBeNull();
  });

  it("hydrateProgressively observes islands and hydrates on intersection", () => {
    const observed: Element[] = [];
    let triggerIntersect: ((entries: unknown[]) => void) | null = null;
    class FakeIO {
      cb: (entries: unknown[]) => void;
      constructor(cb: (entries: unknown[]) => void) {
        this.cb = cb;
        triggerIntersect = cb;
      }
      observe(target: Element) {
        observed.push(target);
      }
      disconnect() {}
      unobserve() {}
      takeRecords() {
        return [];
      }
    }
    const original = globalThis.IntersectionObserver;
    (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
      FakeIO as unknown as typeof IntersectionObserver;

    try {
      const container = el("div");
      const marker = el("div");
      marker.setAttribute("data-sibu-island", "lazy");
      container.appendChild(marker);

      const cleanup = hydrateProgressively(container, {
        lazy: () => {
          const c = el("aside");
          c.textContent = "lazy-content";
          return c;
        },
      });

      expect(container.getAttribute("data-sibu-hydrated")).toBe("progressive");
      expect(observed.length).toBe(1);

      // Simulate the island scrolling into view.
      triggerIntersect?.([{ isIntersecting: true }]);
      const hydratedEl = container.querySelector('[data-sibu-island="lazy"]');
      expect(hydratedEl?.tagName.toLowerCase()).toBe("aside");
      expect(hydratedEl?.getAttribute("data-sibu-hydrated")).toBe("true");

      // Cleanup disconnects observers without throwing.
      expect(() => cleanup()).not.toThrow();
    } finally {
      (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = original;
    }
  });
});

describe("ssr.ts coverage2 — streaming", () => {
  it("renderToStream emits the same structure as renderToString", async () => {
    const div = el("div");
    div.className = "wrap";
    const span = el("span");
    span.textContent = "child";
    div.appendChild(span);

    const streamed = await collectStream(renderToStream(div));
    expect(streamed).toContain('class="wrap"');
    expect(streamed).toContain("child");
    expect(streamed).toContain("</div>");
  });

  it("renderToStream handles fragments, comments, text, scripts and void elements", async () => {
    const frag = document.createDocumentFragment();
    frag.appendChild(document.createComment("c --> x"));
    frag.appendChild(document.createTextNode("<txt>"));
    const script = el("script");
    script.textContent = "x";
    frag.appendChild(script);
    const br = el("br");
    frag.appendChild(br);

    const out = await collectStream(renderToStream(frag));
    expect(out).toContain("&lt;txt&gt;");
    expect(out).toContain("<br />");
    expect(out).toContain("ssr:script-stripped");
  });

  it("renderToStream sanitizes url attributes and emits an error comment on throw", async () => {
    const a = el("a");
    a.setAttribute("href", "vbscript:bad");
    expect(await collectStream(renderToStream(a))).not.toContain("vbscript:");

    const parent = el("div");
    const child = el("span");
    Object.defineProperty(child, "attributes", {
      get() {
        throw new Error("stream-explode");
      },
    });
    parent.appendChild(child);
    const out = await collectStream(renderToStream(parent));
    expect(out).toContain("SSR error");
  });

  it("renderToStream emits an error comment when a fragment child throws", async () => {
    const frag = document.createDocumentFragment();
    const child = el("span");
    Object.defineProperty(child, "attributes", {
      get() {
        throw new Error("stream-frag-explode");
      },
    });
    frag.appendChild(child);
    const out = await collectStream(renderToStream(frag));
    expect(out).toContain("SSR error");
  });

  it("renderToStream serializes an SVG element as markup (escaping its text)", async () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.textContent = "<svg&node>";
    const out = await collectStream(renderToStream(svg as unknown as Node));
    expect(out).toContain("<svg");
    expect(out).toContain("&lt;svg&amp;node&gt;");
    expect(out).toContain("</svg>");
  });

  it("renderToReadableStream produces a Web ReadableStream and can be cancelled", async () => {
    const div = el("div");
    div.textContent = "stream";
    const stream = renderToReadableStream(div);
    const reader = stream.getReader();
    let acc = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      acc += value;
    }
    expect(acc).toContain("stream");

    // A fresh stream that we cancel mid-flight (exercises cancel()).
    const stream2 = renderToReadableStream(div);
    const reader2 = stream2.getReader();
    await reader2.read();
    await expect(reader2.cancel()).resolves.toBeUndefined();
  });
});

describe("ssr.ts coverage2 — suspense", () => {
  beforeEach(() => {
    resetSSRState();
  });

  it("ssrSuspense renders fallback inline and resolves to content html", async () => {
    const { element, promise } = ssrSuspense({
      fallback: () => {
        const f = el("div");
        f.textContent = "loading";
        return f;
      },
      content: async () => {
        const c = el("div");
        c.textContent = "loaded";
        return c;
      },
    });

    expect(element.getAttribute("data-sibu-suspense-id")).toMatch(/^sibu-sus-\d+$/);
    expect(renderToString(element)).toContain("loading");

    const resolved = await promise;
    expect(resolved.html).toContain("loaded");
    expect(resolved.id).toMatch(/^sibu-sus-\d+$/);
  });

  it("ssrSuspense falls back to the fallback html on timeout", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { promise } = ssrSuspense({
      fallback: () => {
        const f = el("div");
        f.textContent = "fallback-ui";
        return f;
      },
      content: () => new Promise(() => {}), // never resolves
      timeoutMs: 10,
    });
    const resolved = await promise;
    expect(resolved.html).toContain("fallback-ui");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("resetSSRState resets the suspense id counter so ids restart at 0", () => {
    resetSSRState();
    const a = ssrSuspense({
      fallback: () => el("div"),
      content: async () => el("div"),
    });
    a.promise.catch(() => {});
    expect(a.element.getAttribute("data-sibu-suspense-id")).toBe("sibu-sus-0");
    const b = ssrSuspense({
      fallback: () => el("div"),
      content: async () => el("div"),
    });
    b.promise.catch(() => {});
    expect(b.element.getAttribute("data-sibu-suspense-id")).toBe("sibu-sus-1");
    resetSSRState();
    const c = ssrSuspense({
      fallback: () => el("div"),
      content: async () => el("div"),
    });
    c.promise.catch(() => {});
    expect(c.element.getAttribute("data-sibu-suspense-id")).toBe("sibu-sus-0");
  });

  it("suspenseSwapScript builds a swap script and rejects unsafe ids", () => {
    const script = suspenseSwapScript("sibu-sus-0");
    expect(script).toContain("sibu-resolved-sibu-sus-0");
    expect(script).toContain("<script>");

    const withNonce = suspenseSwapScript("sibu-sus-1", "abc123");
    expect(withNonce).toContain('nonce="abc123"');

    expect(() => suspenseSwapScript("bad id!")).toThrow(/id must match/);
  });

  it("renderToSuspenseStream emits the tree then flushes resolved boundaries with swap scripts", async () => {
    const tree = el("div");
    const marker = el("div");
    marker.setAttribute("data-sibu-suspense-id", "sibu-sus-0");
    marker.textContent = "fallback";
    tree.appendChild(marker);

    const pending: Promise<{ id: string; html: string }>[] = [
      Promise.resolve({ id: "sibu-sus-0", html: "<p>resolved</p>" }),
      // A boundary with an unsafe id must be dropped from the stream.
      Promise.resolve({ id: "bad id!", html: "<p>evil</p>" }),
    ];

    const out = await collectStream(renderToSuspenseStream(tree, pending, { nonce: "n0" }));
    expect(out).toContain("fallback");
    expect(out).toContain('id="sibu-resolved-sibu-sus-0"');
    expect(out).toContain("resolved");
    expect(out).toContain('nonce="n0"');
    // The unsafe-id boundary is not emitted.
    expect(out).not.toContain("evil");
  });

  it("renderToSuspenseStream with no pending boundaries just streams the tree", async () => {
    const tree = el("div");
    tree.textContent = "plain";
    const out = await collectStream(renderToSuspenseStream(tree));
    expect(out).toContain("plain");
  });
});

describe("ssr.ts coverage2 — state serialization", () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__SIBU_SSR_DATA__;
  });

  it("escapeScriptJson escapes script-breaking and line-separator chars", () => {
    const out = escapeScriptJson("</script><x>&  ");
    expect(out).toContain("\\u003c");
    expect(out).toContain("\\u003e");
    expect(out).toContain("\\u0026");
    expect(out).toContain("\\u2028");
    expect(out).toContain("\\u2029");
    expect(out).not.toContain("</script>");
  });

  it("serializeState embeds escaped JSON and supports a nonce", () => {
    const html = serializeState({ user: "<b>", count: 1 }, "cspNonce");
    expect(html).toContain('nonce="cspNonce"');
    expect(html).toContain("window.__SIBU_SSR_DATA__=");
    expect(html).not.toContain("<b>");
    expect(html).toContain("\\u003c");
  });

  it("serializeState throws when the payload exceeds maxBytes", () => {
    expect(() => serializeState({ big: "x".repeat(100) }, undefined, { maxBytes: 10 })).toThrow(/exceeds maxBytes/);
  });

  it("deserializeState round-trips and honors a validate guard", () => {
    // Emit then parse what serializeState would store on window.
    (window as unknown as Record<string, unknown>).__SIBU_SSR_DATA__ = { ok: true, n: 2 };

    const good = deserializeState<{ ok: boolean; n: number }>(
      (d): d is { ok: boolean; n: number } =>
        typeof d === "object" && d !== null && (d as { ok?: unknown }).ok === true,
    );
    expect(good).toEqual({ ok: true, n: 2 });

    // A failing guard returns undefined (tamper rejection).
    const bad = deserializeState((d): d is never => false);
    expect(bad).toBeUndefined();
  });

  it("deserializeState warns in dev when called without a validate guard", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    (window as unknown as Record<string, unknown>).__SIBU_SSR_DATA__ = { a: 1 };
    const out = deserializeState();
    expect(out).toEqual({ a: 1 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("without a validate guard"));
    warn.mockRestore();
  });

  it("deserializeState returns undefined when no payload was embedded", () => {
    delete (window as unknown as Record<string, unknown>).__SIBU_SSR_DATA__;
    expect(deserializeState((d): d is unknown => true)).toBeUndefined();
  });
});
