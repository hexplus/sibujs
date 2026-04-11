import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { favicon, svgFavicon } from "../src/browser/favicon";

describe("favicon", () => {
  beforeEach(() => {
    for (const link of document.querySelectorAll("link[rel='icon']")) {
      link.remove();
    }
  });
  afterEach(() => {
    for (const link of document.querySelectorAll("link[rel='icon']")) {
      link.remove();
    }
  });

  it("creates a <link rel='icon'> element if none exists", () => {
    favicon("/foo.png");
    const link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
    expect(link).not.toBeNull();
    expect(link?.href).toContain("/foo.png");
  });

  it("updates the href of an existing link", () => {
    favicon("/a.png");
    favicon("/b.png");
    const links = document.querySelectorAll("link[rel='icon']");
    expect(links.length).toBe(1);
    expect((links[0] as HTMLLinkElement).href).toContain("/b.png");
  });
});

describe("svgFavicon", () => {
  it("produces a data URI for the provided SVG", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"/>`;
    const uri = svgFavicon(svg);
    expect(uri.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(uri).toContain(encodeURIComponent(svg));
  });
});
