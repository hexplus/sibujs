import { beforeEach, describe, expect, it } from "vitest";
import { signal } from "../src/core/signals/signal";
import { Head, setCanonical, setStructuredData } from "../src/platform/head";

function cleanHead() {
  for (const el of document.head.querySelectorAll("meta")) el.remove();
  for (const el of document.head.querySelectorAll("link")) el.remove();
  for (const el of document.head.querySelectorAll("script")) el.remove();
  for (const el of document.head.querySelectorAll("base")) el.remove();
}

describe("Head (coverage2)", () => {
  beforeEach(cleanHead);

  it("returns a comment anchor", () => {
    const anchor = Head({ title: "X" });
    expect(anchor.nodeType).toBe(Node.COMMENT_NODE);
    expect(anchor.textContent).toBe("sibu-head");
  });

  it("sets a reactive title and updates it on signal change", () => {
    const [t, setT] = signal("First");
    Head({ title: () => t() });
    expect(document.title).toBe("First");
    setT("Second");
    expect(document.title).toBe("Second");
  });

  it("renders link and script tags with sanitized URL attributes", () => {
    Head({
      link: [{ rel: "preload", href: "https://cdn/app.css" }],
      script: [{ src: "https://cdn/app.js", async: "true" }],
    });
    const link = document.head.querySelector("link");
    expect(link?.getAttribute("href")).toBe("https://cdn/app.css");
    const script = document.head.querySelector("script");
    expect(script?.getAttribute("src")).toBe("https://cdn/app.js");
    expect(script?.getAttribute("async")).toBe("true");
  });

  it("sanitizes javascript: in link/script src to empty", () => {
    Head({
      link: [{ rel: "icon", href: "javascript:alert(1)" }],
      script: [{ src: "javascript:alert(1)" }],
    });
    expect(document.head.querySelector("link")?.getAttribute("href")).toBe("");
    expect(document.head.querySelector("script")?.getAttribute("src")).toBe("");
  });

  it("skips unsafe attribute names (event handlers / bad chars)", () => {
    Head({ link: [{ rel: "stylesheet", onload: "evil()", href: "/ok.css" }] });
    const link = document.head.querySelector("link");
    expect(link?.hasAttribute("onload")).toBe(false);
    expect(link?.getAttribute("href")).toBe("/ok.css");
  });

  it("renders and sanitizes the base tag href, replacing an existing base", () => {
    const stale = document.createElement("base");
    stale.setAttribute("href", "/stale");
    document.head.appendChild(stale);

    Head({ base: { href: "https://safe/", target: "_blank" } });
    const bases = document.head.querySelectorAll("base");
    expect(bases.length).toBe(1);
    expect(bases[0].getAttribute("href")).toBe("https://safe/");
    expect(bases[0].getAttribute("target")).toBe("_blank");
  });

  it("drops a javascript: base href but keeps the base tag and target", () => {
    Head({ base: { href: "javascript:alert(1)", target: "_self" } });
    const base = document.head.querySelector("base");
    expect(base).not.toBeNull();
    // unsafe href sanitized to "" -> never assigned
    expect(base?.getAttribute("href")).toBeNull();
    expect(base?.getAttribute("target")).toBe("_self");
  });

  it("drops a static dangerous http-equiv refresh meta entirely", () => {
    Head({
      meta: [{ "http-equiv": "refresh", content: "0;url=javascript:alert(1)" }],
    });
    expect(document.head.querySelector('meta[http-equiv="refresh"]')).toBeNull();
  });

  it("removes reactive content when it becomes a dangerous refresh url", () => {
    const [content, setContent] = signal("5;url=https://ok");
    Head({
      meta: [{ "http-equiv": "refresh", content: () => content() }],
    });
    const meta = document.head.querySelector('meta[http-equiv="refresh"]');
    expect(meta?.getAttribute("content")).toBe("5;url=https://ok");

    // Now flip it to a dangerous value -> the effect removes the content attr
    setContent("0;url=javascript:alert(1)");
    expect(meta?.getAttribute("content")).toBeNull();
  });

  it("writes reactive non-refresh meta content normally", () => {
    const [desc, setDesc] = signal("hello");
    Head({ meta: [{ name: "description", content: () => desc() }] });
    const meta = document.head.querySelector('meta[name="description"]');
    expect(meta?.getAttribute("content")).toBe("hello");
    setDesc("world");
    expect(meta?.getAttribute("content")).toBe("world");
  });

  it("treats data: refresh url as dangerous", () => {
    Head({ meta: [{ "http-equiv": "refresh", content: "0;url=data:text/html,x" }] });
    expect(document.head.querySelector('meta[http-equiv="refresh"]')).toBeNull();
  });

  it("allows a benign http-equiv refresh redirect", () => {
    Head({ meta: [{ "http-equiv": "refresh", content: "3;url=https://example.com" }] });
    const meta = document.head.querySelector('meta[http-equiv="refresh"]');
    expect(meta?.getAttribute("content")).toBe("3;url=https://example.com");
  });
});

describe("setStructuredData / setCanonical (coverage2)", () => {
  beforeEach(cleanHead);

  it("escapes script-breaking characters in JSON-LD", () => {
    setStructuredData({ name: "</script><x>", url: "a&b" });
    const script = document.head.querySelector('script[type="application/ld+json"][data-sibu]');
    expect(script?.textContent).toContain("\\u003c");
    expect(script?.textContent).not.toContain("</script>");
  });

  it("replaces existing structured data", () => {
    setStructuredData({ a: 1 });
    setStructuredData({ b: 2 });
    const scripts = document.head.querySelectorAll('script[type="application/ld+json"][data-sibu]');
    expect(scripts.length).toBe(1);
    expect(scripts[0].textContent).toContain('"b":2');
  });

  it("creates and updates the canonical link, sanitizing the URL", () => {
    setCanonical("https://example.com/page");
    let link = document.head.querySelector('link[rel="canonical"]') as HTMLLinkElement;
    expect(link.getAttribute("href")).toBe("https://example.com/page");

    // Reuses the same link element on a second call
    setCanonical("https://example.com/other");
    const links = document.head.querySelectorAll('link[rel="canonical"]');
    expect(links.length).toBe(1);
    link = links[0] as HTMLLinkElement;
    expect(link.getAttribute("href")).toBe("https://example.com/other");

    // Dangerous URL sanitized to empty
    setCanonical("javascript:alert(1)");
    expect((document.head.querySelector('link[rel="canonical"]') as HTMLLinkElement).getAttribute("href")).toBe("");
  });
});
