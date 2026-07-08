import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "../src/plugins/ecosystem";
import { preloadCritical } from "../src/plugins/startup";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

describe("ecosystem createTestHarness", () => {
  it("renders, flushes, queries, clicks, and inputs", async () => {
    const h = createTestHarness();
    h.setup();

    const box = document.createElement("div");
    box.className = "box";
    const input = document.createElement("input");
    h.render(box);
    h.render(input);

    await h.flush(); // microtask + rAF flush

    expect(h.query(".box")).toBe(box);
    expect(h.queryAll("div, input").length).toBe(2);

    let clicked = false;
    box.addEventListener("click", () => {
      clicked = true;
    });
    h.click(box);
    expect(clicked).toBe(true);

    h.input(input, "typed");
    expect(input.value).toBe("typed");

    h.teardown();
    expect(document.querySelector("[data-sibu-test]")).toBeNull();
  });
});

describe("startup preloadCritical", () => {
  it("creates preload links and dedupes", () => {
    preloadCritical([{ href: "/app.js", as: "script" }]);
    preloadCritical([{ href: "/app.js", as: "script" }]); // dedup
    expect(document.head.querySelectorAll('link[rel="preload"][href="/app.js"]').length).toBe(1);
  });

  it("falls back to a regex escape when CSS.escape is unavailable", () => {
    vi.stubGlobal("CSS", undefined);
    expect(() => preloadCritical([{ href: '/a.js"x', as: "script" }])).not.toThrow();
    expect(document.head.querySelector('link[rel="preload"]')).toBeTruthy();
  });
});
