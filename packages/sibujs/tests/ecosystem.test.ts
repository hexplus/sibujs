import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bundlerMetadata, createTestHarness, env, healthCheck } from "../src/plugins/ecosystem";

describe("createTestHarness", () => {
  let harness: ReturnType<typeof createTestHarness>;

  beforeEach(() => {
    harness = createTestHarness();
  });

  afterEach(() => {
    harness.teardown();
  });

  it("setup creates a container appended to body", () => {
    const container = harness.setup();
    expect(container).toBeInstanceOf(HTMLElement);
    expect(container.tagName).toBe("DIV");
    expect(container.getAttribute("data-sibu-test")).toBe("true");
    expect(document.body.contains(container)).toBe(true);
  });

  it("render mounts a component into the container", () => {
    harness.setup();
    const el = document.createElement("span");
    el.textContent = "hello";
    const rendered = harness.render(el);
    expect(rendered).toBe(el);
    expect(harness.getContainer().contains(el)).toBe(true);
  });

  it("render accepts a factory function", () => {
    harness.setup();
    const rendered = harness.render(() => {
      const el = document.createElement("p");
      el.textContent = "from factory";
      return el;
    });
    expect(rendered.tagName).toBe("P");
    expect(rendered.textContent).toBe("from factory");
    expect(harness.getContainer().contains(rendered)).toBe(true);
  });

  it("query finds elements within the container", () => {
    harness.setup();
    const el = document.createElement("button");
    el.className = "my-btn";
    harness.render(el);

    expect(harness.query(".my-btn")).toBe(el);
    expect(harness.query(".nonexistent")).toBeNull();
  });

  it("queryAll returns all matching elements", () => {
    harness.setup();
    const li1 = document.createElement("li");
    const li2 = document.createElement("li");
    li1.className = "item";
    li2.className = "item";
    harness.render(li1);
    harness.render(li2);

    const results = harness.queryAll(".item");
    expect(results).toHaveLength(2);
    expect(results[0]).toBe(li1);
    expect(results[1]).toBe(li2);
  });

  it("teardown removes the container from the DOM", () => {
    const container = harness.setup();
    expect(document.body.contains(container)).toBe(true);
    harness.teardown();
    expect(document.body.contains(container)).toBe(false);
  });

  it("teardown is safe to call when not set up", () => {
    // Should not throw
    expect(() => harness.teardown()).not.toThrow();
  });
});

describe("bundlerMetadata", () => {
  it("has the correct name", () => {
    expect(bundlerMetadata.name).toBe("sibujs");
  });

  it("has sideEffects set to false", () => {
    expect(bundlerMetadata.sideEffects).toBe(false);
  });

  it("lists the real published subpath entries", () => {
    const entries = bundlerMetadata.entries;
    expect(entries).toContain("index");
    expect(entries).toContain("data");
    expect(entries).toContain("ui");
    expect(entries).toContain("ssr");
    expect(entries).toContain("plugins");
    expect(entries).toContain("build");
    expect(entries).toContain("testing");
  });

  it("generateImportMap returns a proper map with default base", () => {
    const map = bundlerMetadata.generateImportMap();
    // The bare package specifier resolves to the index bundle.
    expect(map.sibujs).toBe("/node_modules/sibujs/dist/index.js");
    // Subpaths resolve to their own dist bundle.
    expect(map["sibujs/data"]).toBe("/node_modules/sibujs/dist/data.js");
    expect(map["sibujs/plugins"]).toBe("/node_modules/sibujs/dist/plugins.js");
  });

  it("generateImportMap uses a custom base path", () => {
    const map = bundlerMetadata.generateImportMap("/lib/sibujs/");
    expect(map.sibujs).toBe("/lib/sibujs/dist/index.js");
    expect(map["sibujs/ssr"]).toBe("/lib/sibujs/dist/ssr.js");
  });

  it("generateImportMap includes an entry for every published subpath", () => {
    const map = bundlerMetadata.generateImportMap();
    expect(Object.keys(map)).toHaveLength(bundlerMetadata.entries.length);
  });
});

describe("healthCheck", () => {
  it("returns a status with a checks array", () => {
    const result = healthCheck();
    expect(result).toHaveProperty("status");
    expect(result).toHaveProperty("checks");
    expect(Array.isArray(result.checks)).toBe(true);
  });

  it("status is ok when all checks pass", () => {
    const result = healthCheck();
    // In jsdom environment, DOM, requestAnimationFrame, and MutationObserver
    // should all be available
    expect(result.status).toBe("ok");
  });

  it("each check has name, passed, and message", () => {
    const result = healthCheck();
    for (const check of result.checks) {
      expect(check).toHaveProperty("name");
      expect(check).toHaveProperty("passed");
      expect(check).toHaveProperty("message");
      expect(typeof check.name).toBe("string");
      expect(typeof check.passed).toBe("boolean");
      expect(typeof check.message).toBe("string");
    }
  });

  it("includes a DOM Environment check", () => {
    const result = healthCheck();
    const domCheck = result.checks.find((c) => c.name === "DOM Environment");
    expect(domCheck).toBeDefined();
    expect(domCheck?.passed).toBe(true);
  });

  it("includes a requestAnimationFrame check", () => {
    const result = healthCheck();
    const rafCheck = result.checks.find((c) => c.name === "requestAnimationFrame");
    expect(rafCheck).toBeDefined();
    expect(rafCheck?.passed).toBe(true);
  });

  it("includes a MutationObserver check", () => {
    const result = healthCheck();
    const moCheck = result.checks.find((c) => c.name === "MutationObserver");
    expect(moCheck).toBeDefined();
    expect(moCheck?.passed).toBe(true);
  });
});

describe("env", () => {
  it("has expected properties", () => {
    expect(env).toHaveProperty("isBrowser");
    expect(env).toHaveProperty("isNode");
    expect(env).toHaveProperty("isSSR");
    expect(env).toHaveProperty("isDev");
    expect(env).toHaveProperty("isTest");
  });

  it("isBrowser is true in jsdom", () => {
    // jsdom provides window and document
    expect(env.isBrowser).toBe(true);
  });

  it("isNode is true when running under node", () => {
    expect(env.isNode).toBe(true);
  });

  it("isSSR is false in jsdom (window is defined)", () => {
    expect(env.isSSR).toBe(false);
  });

  it("isDev is true when NODE_ENV is not production", () => {
    // Vitest sets NODE_ENV to 'test', which is not 'production'
    expect(env.isDev).toBe(true);
  });

  it("isTest is true when running under vitest", () => {
    expect(env.isTest).toBe(true);
  });

  it("all env properties are booleans", () => {
    for (const key of ["isBrowser", "isNode", "isWorker", "isDeno", "isBun", "isSSR", "isDev", "isTest"] as const) {
      expect(typeof env[key]).toBe("boolean");
    }
  });
});
