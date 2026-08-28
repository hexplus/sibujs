/**
 * Client and server must reach the SAME verdict on the same meta entry.
 *
 * Two implementations of "is this refresh dangerous?" existed — one in
 * `head.ts`, one in `ssr.ts` (which router SSR imported). Both used the same
 * four `includes()` checks, so both missed the same spellings, and any fix to
 * one would silently diverge from the other. There is now a single policy, and
 * these tests assert the server honours it identically to the client.
 *
 * Dangerous entries must be absent ENTIRELY — not escaped, not partially
 * emitted with the destination stripped, and not converted into some other
 * redirect mechanism.
 */

import { describe, expect, it } from "vitest";
import { div } from "../src/core/rendering/html";
import { renderToDocument } from "../src/platform/ssr";
import { renderRouteToDocument } from "../src/plugins/routerSSR";

const DANGEROUS_FORMS = [
  "0;url=javascript:alert(1)",
  "0; url = javascript:alert(1)",
  "0;URL=JAVASCRIPT:alert(1)",
  "0;url='javascript:alert(1)'",
  '0;url="javascript:alert(1)"',
  '0 ; URL = "data:text/html,<script>1</script>"',
  "0; url = blob:https://example.com/id",
  "0; url = vbscript:msgbox(1)",
  "0;\turl\t=\tjavascript:alert(1)",
  "0;url=java\tscript:alert(1)",
];

const SAFE_FORMS = ["5", "5;url=/home", "5; url = /home", '5; URL="https://example.com/path"', "0;url=#section"];

const MALFORMED_FORMS = ['0;url="javascript:alert(1)', "0;url=/safe;url=javascript:alert(1)", "0;url=", "0;uri=/safe"];

/** Assert an output carries no live refresh and no dangerous residue. */
function assertNoDangerousRefresh(out: string, label: string): void {
  const lower = out.toLowerCase();
  expect(lower, `${label} emitted a refresh directive`).not.toContain('http-equiv="refresh"');
  expect(lower, `${label} emitted a javascript: destination`).not.toContain("javascript:");
  expect(lower, `${label} emitted a data: document`).not.toContain("data:text/html");
  expect(lower, `${label} emitted a vbscript: destination`).not.toContain("vbscript:");
  expect(lower, `${label} emitted a blob: destination`).not.toContain("blob:");
  // Nor an entity-escaped substitute.
  expect(lower, `${label} emitted an escaped refresh`).not.toContain("&#x72;efresh");
}

const component = () => div({ id: "app" }, "content") as HTMLElement;

describe("renderToDocument drops dangerous refresh directives", () => {
  for (const content of DANGEROUS_FORMS) {
    it(`drops ${JSON.stringify(content)}`, () => {
      const out = renderToDocument(component, {
        meta: [{ "http-equiv": "refresh", content }],
      });
      assertNoDangerousRefresh(out, "renderToDocument");
      // The rest of the document still renders.
      expect(out).toContain('id="app"');
    });
  }

  for (const content of MALFORMED_FORMS) {
    it(`drops malformed ${JSON.stringify(content)}`, () => {
      const out = renderToDocument(component, {
        meta: [{ "http-equiv": "refresh", content }],
      });
      assertNoDangerousRefresh(out, "renderToDocument");
    });
  }

  for (const content of SAFE_FORMS) {
    it(`keeps safe ${JSON.stringify(content)}`, () => {
      const out = renderToDocument(component, {
        meta: [{ "http-equiv": "refresh", content }],
      });
      expect(out.toLowerCase(), "a safe refresh was suppressed").toContain('http-equiv="refresh"');
      expect(out).toContain(content.replace(/"/g, "&quot;"));
    });
  }

  it("drops an entry with duplicate http-equiv spellings", () => {
    const out = renderToDocument(component, {
      meta: [{ "http-equiv": "x-custom", "HTTP-EQUIV": "refresh", content: "0;url=javascript:alert(1)" }],
    });
    assertNoDangerousRefresh(out, "renderToDocument");
  });

  it("drops an entry with duplicate content spellings", () => {
    const out = renderToDocument(component, {
      meta: [{ "HTTP-EQUIV": "refresh", content: "5;url=/safe", CONTENT: "0;url=data:text/html,x" }],
    });
    assertNoDangerousRefresh(out, "renderToDocument");
  });

  it("honours mixed-case single spellings", () => {
    const out = renderToDocument(component, {
      meta: [{ "HTTP-EQUIV": "refresh", CONTENT: "5;url=/home" }],
    });
    expect(out.toLowerCase()).toContain("refresh");
    expect(out).toContain("5;url=/home");
  });

  it("keeps ordinary meta tags untouched", () => {
    const out = renderToDocument(component, {
      meta: [
        { name: "description", content: "A page" },
        { property: "og:title", content: "Title" },
      ],
    });
    expect(out).toContain('name="description"');
    expect(out).toContain("A page");
    expect(out).toContain('property="og:title"');
  });
});

describe("router SSR reaches the same verdict", () => {
  const routes = [{ path: "/", component }];

  for (const content of DANGEROUS_FORMS) {
    it(`drops ${JSON.stringify(content)}`, () => {
      const out = renderRouteToDocument("/", routes, {
        meta: [{ "http-equiv": "refresh", content }],
      });
      assertNoDangerousRefresh(out, "renderRouteToDocument");
    });
  }

  for (const content of MALFORMED_FORMS) {
    it(`drops malformed ${JSON.stringify(content)}`, () => {
      const out = renderRouteToDocument("/", routes, {
        meta: [{ "http-equiv": "refresh", content }],
      });
      assertNoDangerousRefresh(out, "renderRouteToDocument");
    });
  }

  for (const content of SAFE_FORMS) {
    it(`keeps safe ${JSON.stringify(content)}`, () => {
      const out = renderRouteToDocument("/", routes, {
        meta: [{ "http-equiv": "refresh", content }],
      });
      expect(out.toLowerCase(), "a safe refresh was suppressed").toContain('http-equiv="refresh"');
    });
  }

  it("drops duplicate-casing entries like renderToDocument", () => {
    const out = renderRouteToDocument("/", routes, {
      meta: [{ "http-equiv": "x-custom", "HTTP-EQUIV": "refresh", content: "0;url=javascript:alert(1)" }],
    });
    assertNoDangerousRefresh(out, "renderRouteToDocument");
  });
});

describe("client and server agree", () => {
  it("gives the same verdict for every form in the table", () => {
    const routes = [{ path: "/", component }];

    for (const content of [...DANGEROUS_FORMS, ...MALFORMED_FORMS]) {
      const doc = renderToDocument(component, { meta: [{ "http-equiv": "refresh", content }] });
      const routed = renderRouteToDocument("/", routes, { meta: [{ "http-equiv": "refresh", content }] });

      const docHasRefresh = doc.toLowerCase().includes('http-equiv="refresh"');
      const routedHasRefresh = routed.toLowerCase().includes('http-equiv="refresh"');
      expect(docHasRefresh, `renderers disagreed on ${content}`).toBe(routedHasRefresh);
      expect(docHasRefresh).toBe(false);
    }

    for (const content of SAFE_FORMS) {
      const doc = renderToDocument(component, { meta: [{ "http-equiv": "refresh", content }] });
      const routed = renderRouteToDocument("/", routes, { meta: [{ "http-equiv": "refresh", content }] });
      expect(doc.toLowerCase().includes('http-equiv="refresh"')).toBe(true);
      expect(routed.toLowerCase().includes('http-equiv="refresh"')).toBe(true);
    }
  });
});
