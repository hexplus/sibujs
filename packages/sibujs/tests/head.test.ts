import { beforeEach, describe, expect, it } from "vitest";
import { Head, setCanonical, setStructuredData } from "../src/platform/head";

describe("Head", () => {
  beforeEach(() => {
    // Clean up any managed elements
    for (const el of document.head.querySelectorAll("meta[data-sibu-ssr]")) el.remove();
    for (const el of document.head.querySelectorAll('script[type="application/ld+json"]')) el.remove();
    for (const el of document.head.querySelectorAll('link[rel="canonical"]')) el.remove();
  });

  it("should set document title", () => {
    Head({ title: "My App" });
    expect(document.title).toBe("My App");
  });

  it("should add meta tags", () => {
    Head({
      meta: [{ name: "description", content: "A test page" }],
    });

    const meta = document.head.querySelector('meta[name="description"]');
    expect(meta).not.toBeNull();
    expect(meta?.getAttribute("content")).toBe("A test page");
  });

  it("should add link tags", () => {
    Head({
      link: [{ rel: "stylesheet", href: "/style.css" }],
    });

    const link = document.head.querySelector('link[rel="stylesheet"]');
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("/style.css");
  });
});

describe("setStructuredData", () => {
  it("should inject JSON-LD script", () => {
    setStructuredData({ "@type": "WebPage", name: "Test" });

    const script = document.head.querySelector('script[type="application/ld+json"]');
    expect(script).not.toBeNull();
    expect(script?.textContent).toContain("WebPage");
  });
});

describe("setCanonical", () => {
  it("should set canonical URL", () => {
    setCanonical("https://example.com/page");

    const link = document.head.querySelector('link[rel="canonical"]') as HTMLLinkElement;
    expect(link).not.toBeNull();
    expect(link.href).toContain("example.com/page");
  });
});
