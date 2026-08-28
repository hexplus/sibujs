/**
 * `Head()`, `renderToDocument()`, and `renderRouteToDocument()` must reach the
 * SAME verdict on the same meta entry.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A shared policy function is not the same thing as a shared decision. All three
 * paths already called one `isDangerousMetaRefresh`, and they still disagreed,
 * because they called it at different POINTS in their own pipelines:
 *
 *     client:  filter unsafe names  →  resolve values  →  check duplicates
 *     server:  check duplicates     →  filter unsafe names  →  sanitize values
 *
 * So `{ name: "description", content: "ok", onload: "a", ONLOAD: "b" }` was
 * emitted by the client — which dropped both event handlers as unsafe names and
 * then saw no duplicate — and rejected by both servers, which saw the duplicate
 * in the raw record. Same rule, same function, opposite outcomes.
 *
 * The order is now fixed in one place (`planMetaEntry`): raw duplicate names
 * first, then name filtering, then value resolution, then sanitization, and only
 * then the refresh verdict — computed on the effective post-sanitization
 * snapshot, so what is validated is exactly what is committed.
 *
 * Every row below is driven through all three paths and the results compared to
 * each other, not to a hard-coded expectation. A row that all three get wrong in
 * the same way is caught by the dedicated security suites; this file exists to
 * catch the case where they differ.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispose } from "../src/core/rendering/dispose";
import { div } from "../src/core/rendering/html";
import { Head } from "../src/platform/head";
import { renderToDocument } from "../src/platform/ssr";
import { renderRouteToDocument } from "../src/plugins/routerSSR";

interface Row {
  label: string;
  entry: Record<string, string>;
}

const TABLE: Row[] = [
  // ── duplicate case-insensitive names ────────────────────────────────────
  {
    label: "duplicate http-equiv casing",
    entry: { "http-equiv": "x-custom", "HTTP-EQUIV": "refresh", content: "0;url=javascript:alert(1)" },
  },
  {
    label: "duplicate content casing",
    entry: { "http-equiv": "refresh", content: "5;url=/safe", CONTENT: "0;url=data:text/html,x" },
  },
  {
    label: "duplicate safe ordinary attribute casing",
    entry: { name: "description", NAME: "description", content: "ok" },
  },
  {
    label: "duplicate event-handler casing",
    entry: { name: "description", content: "ok", onload: "a", ONLOAD: "b" },
  },
  {
    label: "duplicate invalid attribute casing",
    entry: { name: "description", content: "ok", "1bad": "a", "1BAD": "b" },
  },

  // ── single spellings, mixed case ────────────────────────────────────────
  { label: "mixed-case http-equiv/content, safe", entry: { "HTTP-EQUIV": "refresh", CONTENT: "5;url=/home" } },
  {
    label: "mixed-case http-equiv/content, dangerous",
    entry: { "Http-Equiv": "refresh", Content: "0;url=javascript:1" },
  },

  // ── ordinary metadata ───────────────────────────────────────────────────
  { label: "description", entry: { name: "description", content: "A page" } },
  { label: "keywords", entry: { name: "keywords", content: "a,b,c" } },
  { label: "open graph", entry: { property: "og:title", content: "Title" } },
  { label: "non-refresh http-equiv", entry: { "http-equiv": "x-ua-compatible", content: "IE=edge" } },
  {
    label: "ordinary entry carrying an event handler",
    entry: { name: "description", content: "A page", onload: "evil()" },
  },

  // ── refresh directives ──────────────────────────────────────────────────
  { label: "safe static refresh", entry: { "http-equiv": "refresh", content: "5;url=/home" } },
  { label: "safe delay-only refresh", entry: { "http-equiv": "refresh", content: "30" } },
  { label: "forbidden static refresh", entry: { "http-equiv": "refresh", content: "0;url=javascript:alert(1)" } },
  {
    label: "forbidden static refresh, spaced spelling",
    entry: { "http-equiv": "refresh", content: "0; URL = 'JaVaScRiPt:alert(1)'" },
  },
  {
    label: "malformed static refresh, unterminated quote",
    entry: { "http-equiv": "refresh", content: '0;url="/safe' },
  },
  {
    label: "malformed static refresh, competing assignments",
    entry: { "http-equiv": "refresh", content: "0;url=/safe;url=javascript:alert(1)" },
  },
  {
    label: "malformed static refresh, non-numeric delay",
    entry: { "http-equiv": "refresh", content: "abc;url=/safe" },
  },
];

const component = () => div({ id: "app" }, "content") as HTMLElement;
const routes = [{ path: "/", component }];

/** What the client publishes for one entry: its effective attributes, or null. */
function clientResult(entry: Record<string, string>): Record<string, string> | null {
  const head = Head({ meta: [entry] });
  try {
    const el = document.head.querySelector("meta");
    if (!el) return null;
    const out: Record<string, string> = {};
    for (const attr of Array.from(el.attributes)) out[attr.name] = attr.value;
    return out;
  } finally {
    dispose(head);
  }
}

/**
 * What a server path emits for one entry.
 *
 * Parsed back out of the document with the SAME DOM the client is measured
 * with, so the two results are directly comparable rather than compared through
 * a string match that could pass for the wrong reason.
 */
function serverResult(html: string): Record<string, string> | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  // The two fixed metas every document template emits are not under test.
  const el = Array.from(doc.head.querySelectorAll("meta")).find(
    (m) => !m.hasAttribute("charset") && m.getAttribute("name") !== "viewport",
  );
  if (!el) return null;
  const out: Record<string, string> = {};
  for (const attr of Array.from(el.attributes)) out[attr.name] = attr.value;
  return out;
}

beforeEach(() => {
  for (const el of Array.from(document.head.querySelectorAll("meta"))) el.remove();
});

afterEach(() => {
  for (const el of Array.from(document.head.querySelectorAll("meta"))) el.remove();
});

describe("client / renderToDocument / router SSR agree on every meta entry", () => {
  for (const { label, entry } of TABLE) {
    it(`agrees on ${label}`, () => {
      const client = clientResult(entry);
      const doc = serverResult(renderToDocument(component, { meta: [entry] }));
      const routed = serverResult(renderRouteToDocument("/", routes, { meta: [entry] }));

      // 1. All three must agree that the entry exists — or does not.
      expect(doc !== null, `renderToDocument ${doc ? "emitted" : "dropped"} where the client did not`).toBe(
        client !== null,
      );
      expect(routed !== null, `router SSR ${routed ? "emitted" : "dropped"} where the client did not`).toBe(
        client !== null,
      );

      // 2. For accepted entries the effective attributes and sanitized values
      //    must match too — agreeing on existence while disagreeing on content
      //    is the same class of bug one level down.
      if (client !== null) {
        expect(doc, "renderToDocument produced different effective attributes").toEqual(client);
        expect(routed, "router SSR produced different effective attributes").toEqual(client);
      }
    });
  }
});

describe("the duplicate-name rule is applied to raw authored names", () => {
  it("rejects a duplicate whose names would both have been filtered away", () => {
    // The regression itself. `onload`/`ONLOAD` never reach any output, so a
    // duplicate check that runs after filtering cannot see them.
    const entry = { name: "description", content: "ok", onload: "a", ONLOAD: "b" };
    expect(clientResult(entry), "the client published a duplicate-name entry").toBeNull();
    expect(serverResult(renderToDocument(component, { meta: [entry] }))).toBeNull();
    expect(serverResult(renderRouteToDocument("/", routes, { meta: [entry] }))).toBeNull();
  });

  it("rejects a duplicate whose names are invalid on every path", () => {
    const entry = { name: "description", content: "ok", "1bad": "a", "1BAD": "b" };
    expect(clientResult(entry)).toBeNull();
    expect(serverResult(renderToDocument(component, { meta: [entry] }))).toBeNull();
    expect(serverResult(renderRouteToDocument("/", routes, { meta: [entry] }))).toBeNull();
  });

  it("does not reject an entry that merely mixes cases across DIFFERENT names", () => {
    const entry = { NAME: "description", Content: "ok", ID: "x" };
    const client = clientResult(entry);
    expect(client, "a legal mixed-case entry was rejected").not.toBeNull();
    expect(serverResult(renderToDocument(component, { meta: [entry] }))).toEqual(client);
    expect(serverResult(renderRouteToDocument("/", routes, { meta: [entry] }))).toEqual(client);
  });
});

describe("what is validated is what is committed", () => {
  it("judges the refresh directive on the post-sanitization value", () => {
    // `content` is not a URL slot on any path, so its value survives
    // sanitization unchanged and the parser sees exactly what is emitted.
    const entry = { "http-equiv": "refresh", content: "5;url=/home" };
    const client = clientResult(entry);
    expect(client?.content).toBe("5;url=/home");
    expect(serverResult(renderToDocument(component, { meta: [entry] }))?.content).toBe("5;url=/home");
    expect(serverResult(renderRouteToDocument("/", routes, { meta: [entry] }))?.content).toBe("5;url=/home");
  });

  it("agrees on an entry whose URL attribute is sanitized away", () => {
    const entry = { name: "x", content: "ok", href: "javascript:alert(1)" };
    const client = clientResult(entry);
    const doc = serverResult(renderToDocument(component, { meta: [entry] }));
    const routed = serverResult(renderRouteToDocument("/", routes, { meta: [entry] }));

    // All three must at minimum agree the dangerous URL never survives.
    for (const [label, result] of [
      ["client", client],
      ["renderToDocument", doc],
      ["router SSR", routed],
    ] as const) {
      expect(result?.href ?? "", `${label} emitted a javascript: href`).not.toContain("javascript:");
    }
    expect(doc !== null).toBe(client !== null);
    expect(routed !== null).toBe(client !== null);
  });
});
