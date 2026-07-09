// Regression tests for the round-5 deep-review fixes.

import { dispose, signal } from "@sibujs/core";
import { afterEach, describe, expect, it } from "vitest";
import { renderToDocument } from "../src/platform/ssr";
import { createRouter, destroyRouter, RouterLink } from "../src/plugins/router";
import { createSSRRouter } from "../src/plugins/routerSSR";
import { aria } from "../src/ui/a11y";

describe("router resolvePath: param-prefix interpolation", () => {
  afterEach(() => {
    try {
      destroyRouter();
    } catch {}
  });

  it("does not corrupt a param whose name is a prefix of another", () => {
    createRouter({ mode: "history", base: "" });
    const link = RouterLink({
      to: { path: "/users/:idDetail/:id", params: { id: "Y", idDetail: "X" } },
      nodes: "go",
    });
    // ":id" must not match inside ":idDetail".
    expect(link.getAttribute("href")).toBe("/users/X/Y");
  });
});

describe("aria(): reactive binding is disposed with the element", () => {
  it("stops updating after the element is disposed", () => {
    const [expanded, setExpanded] = signal(false);
    const el = document.createElement("button");
    aria(el, { expanded: () => expanded() });
    expect(el.getAttribute("aria-expanded")).toBe("false");

    setExpanded(true);
    expect(el.getAttribute("aria-expanded")).toBe("true");

    dispose(el);
    setExpanded(false);
    // After dispose the binding must be gone — attribute frozen at last value.
    expect(el.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("meta http-equiv=refresh guard is case-insensitive", () => {
  const Empty = () => document.createElement("div");

  it("drops a dangerous refresh meta with uppercase keys (renderToDocument)", () => {
    const html = renderToDocument(Empty, {
      meta: [{ "HTTP-EQUIV": "refresh", CONTENT: "0;url=javascript:alert(1)" }],
    });
    expect(html).not.toContain("javascript:");
    expect(html.toLowerCase()).not.toContain("refresh");
  });

  it("still allows a safe refresh meta", () => {
    const html = renderToDocument(Empty, {
      meta: [{ "http-equiv": "refresh", content: "5;url=/home" }],
    });
    expect(html).toContain("/home");
  });
});

describe("routerSSR renderToDocument drops dangerous refresh meta", () => {
  it("does not emit a javascript: refresh redirect", () => {
    const ssr = createSSRRouter([{ path: "/", component: () => document.createElement("div") }]);
    const html = ssr.renderToDocument("/", {
      meta: [{ "http-equiv": "refresh", content: "0;url=javascript:alert(1)" }],
    });
    expect(html).not.toContain("javascript:");
  });
});
