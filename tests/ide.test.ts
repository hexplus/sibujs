import { describe, expect, it } from "vitest";
import {
  generateLanguageConfig,
  generateTypeStubs,
  generateVSCodeSnippets,
  getComponentMetadata,
} from "../src/build/ide";

// ─── getComponentMetadata ────────────────────────────────────────────────────

describe("getComponentMetadata", () => {
  it("returns a non-empty array", () => {
    const meta = getComponentMetadata();
    expect(Array.isArray(meta)).toBe(true);
    expect(meta.length).toBeGreaterThan(0);
  });

  it("returns at least 15 component definitions", () => {
    const meta = getComponentMetadata();
    // Threshold lowered from 20 after removing memo, memoFn, createSignal,
    // createMemo, createEffect in 1.4.0.
    expect(meta.length).toBeGreaterThanOrEqual(15);
  });

  it("each entry has valid structure with name, description, and props", () => {
    const meta = getComponentMetadata();
    meta.forEach((component) => {
      expect(typeof component.name).toBe("string");
      expect(component.name.length).toBeGreaterThan(0);
      expect(typeof component.description).toBe("string");
      expect(component.description.length).toBeGreaterThan(0);
      expect(Array.isArray(component.props)).toBe(true);
    });
  });

  it("props have valid structure (name, type, required, description)", () => {
    const meta = getComponentMetadata();
    meta.forEach((component) => {
      component.props.forEach((prop) => {
        expect(typeof prop.name).toBe("string");
        expect(typeof prop.type).toBe("string");
        expect(typeof prop.required).toBe("boolean");
        expect(typeof prop.description).toBe("string");
      });
    });
  });

  it("includes signal metadata", () => {
    const meta = getComponentMetadata();
    const signal = meta.find((c) => c.name === "signal");
    expect(signal).toBeDefined();
    expect(signal?.description).toContain("reactive");
    expect(signal?.props.length).toBeGreaterThan(0);
  });

  it("includes effect metadata", () => {
    const meta = getComponentMetadata();
    const effect = meta.find((c) => c.name === "effect");
    expect(effect).toBeDefined();
    expect(effect?.description).toContain("side effect");
  });

  it("includes mount metadata", () => {
    const meta = getComponentMetadata();
    const mount = meta.find((c) => c.name === "mount");
    expect(mount).toBeDefined();
    expect(mount?.description).toContain("Mounts");
    expect(mount?.props.length).toBeGreaterThanOrEqual(2);
  });

  it("includes each metadata", () => {
    const meta = getComponentMetadata();
    const each = meta.find((c) => c.name === "each");
    expect(each).toBeDefined();
    expect(each?.description).toContain("list");
  });

  it("includes div metadata with events", () => {
    const meta = getComponentMetadata();
    const div = meta.find((c) => c.name === "div");
    expect(div).toBeDefined();
    expect(div?.events).toBeDefined();
    expect(div?.events?.length).toBeGreaterThan(0);
    const clickEvent = div?.events?.find((e) => e.name === "click");
    expect(clickEvent).toBeDefined();
  });

  it("includes context metadata", () => {
    const meta = getComponentMetadata();
    const ctx = meta.find((c) => c.name === "context");
    expect(ctx).toBeDefined();
    expect(ctx?.description).toContain("context");
  });

  it("includes onMount and onUnmount lifecycle metadata", () => {
    const meta = getComponentMetadata();
    const onMount = meta.find((c) => c.name === "onMount");
    const onUnmount = meta.find((c) => c.name === "onUnmount");
    expect(onMount).toBeDefined();
    expect(onUnmount).toBeDefined();
  });

  it("does NOT include removed SolidJS-style aliases", () => {
    const meta = getComponentMetadata();
    const names = meta.map((c) => c.name);
    // createSignal / createMemo / createEffect were removed in 1.4.0.
    expect(names).not.toContain("createSignal");
    expect(names).not.toContain("createMemo");
    expect(names).not.toContain("createEffect");
  });

  it("all component names are unique", () => {
    const meta = getComponentMetadata();
    const names = meta.map((c) => c.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });
});

// ─── generateVSCodeSnippets ──────────────────────────────────────────────────

describe("generateVSCodeSnippets", () => {
  it("returns a non-empty object", () => {
    const snippets = generateVSCodeSnippets();
    expect(typeof snippets).toBe("object");
    expect(Object.keys(snippets).length).toBeGreaterThan(0);
  });

  it("returns at least 15 snippets", () => {
    const snippets = generateVSCodeSnippets();
    expect(Object.keys(snippets).length).toBeGreaterThanOrEqual(15);
  });

  it("each snippet has valid structure (prefix, body, description)", () => {
    const snippets = generateVSCodeSnippets();
    Object.entries(snippets).forEach(([_name, snippet]) => {
      expect(typeof snippet.prefix).toBe("string");
      expect(snippet.prefix.length).toBeGreaterThan(0);
      expect(Array.isArray(snippet.body)).toBe(true);
      expect(snippet.body.length).toBeGreaterThan(0);
      expect(typeof snippet.description).toBe("string");
      expect(snippet.description.length).toBeGreaterThan(0);
    });
  });

  it("includes sibu-component snippet", () => {
    const snippets = generateVSCodeSnippets();
    const componentSnippet = Object.values(snippets).find((s) => s.prefix === "sibu-component");
    expect(componentSnippet).toBeDefined();
    expect(componentSnippet?.body.join("\n")).toContain("function");
    expect(componentSnippet?.body.join("\n")).toContain("HTMLElement");
  });

  it("includes sibu-state snippet", () => {
    const snippets = generateVSCodeSnippets();
    const stateSnippet = Object.values(snippets).find((s) => s.prefix === "sibu-state");
    expect(stateSnippet).toBeDefined();
    expect(stateSnippet?.body.join("\n")).toContain("signal");
  });

  it("includes sibu-effect snippet", () => {
    const snippets = generateVSCodeSnippets();
    const effectSnippet = Object.values(snippets).find((s) => s.prefix === "sibu-effect");
    expect(effectSnippet).toBeDefined();
    expect(effectSnippet?.body.join("\n")).toContain("effect");
  });

  it("includes sibu-each snippet", () => {
    const snippets = generateVSCodeSnippets();
    const eachSnippet = Object.values(snippets).find((s) => s.prefix === "sibu-each");
    expect(eachSnippet).toBeDefined();
    expect(eachSnippet?.body.join("\n")).toContain("each(");
  });

  it("includes sibu-context snippet", () => {
    const snippets = generateVSCodeSnippets();
    const ctxSnippet = Object.values(snippets).find((s) => s.prefix === "sibu-context");
    expect(ctxSnippet).toBeDefined();
    expect(ctxSnippet?.body.join("\n")).toContain("context");
  });

  it("all prefixes start with 'sibu-'", () => {
    const snippets = generateVSCodeSnippets();
    Object.values(snippets).forEach((snippet) => {
      expect(snippet.prefix.startsWith("sibu-")).toBe(true);
    });
  });

  it("all snippet prefixes are unique", () => {
    const snippets = generateVSCodeSnippets();
    const prefixes = Object.values(snippets).map((s) => s.prefix);
    const uniquePrefixes = new Set(prefixes);
    expect(uniquePrefixes.size).toBe(prefixes.length);
  });

  it("snippet bodies contain VS Code placeholder syntax", () => {
    const snippets = generateVSCodeSnippets();
    // At least some snippets should have ${ placeholders
    const hasPlaceholders = Object.values(snippets).some((snippet) =>
      snippet.body.some((line) => /\$\{?\d/.test(line)),
    );
    expect(hasPlaceholders).toBe(true);
  });
});

// ─── generateLanguageConfig ──────────────────────────────────────────────────

describe("generateLanguageConfig", () => {
  it("returns proper line comment delimiter", () => {
    const config = generateLanguageConfig();
    expect(config.comments.lineComment).toBe("//");
  });

  it("returns proper block comment delimiters", () => {
    const config = generateLanguageConfig();
    expect(config.comments.blockComment).toEqual(["/*", "*/"]);
  });

  it("includes standard bracket pairs", () => {
    const config = generateLanguageConfig();
    expect(config.brackets).toContainEqual(["{", "}"]);
    expect(config.brackets).toContainEqual(["[", "]"]);
    expect(config.brackets).toContainEqual(["(", ")"]);
    expect(config.brackets).toContainEqual(["<", ">"]);
  });

  it("includes auto-closing pairs for braces, brackets, and quotes", () => {
    const config = generateLanguageConfig();
    const pairs = config.autoClosingPairs;
    expect(pairs).toContainEqual({ open: "{", close: "}" });
    expect(pairs).toContainEqual({ open: "[", close: "]" });
    expect(pairs).toContainEqual({ open: "(", close: ")" });
    expect(pairs).toContainEqual({ open: "'", close: "'" });
    expect(pairs).toContainEqual({ open: '"', close: '"' });
    expect(pairs).toContainEqual({ open: "`", close: "`" });
  });

  it("includes angle bracket auto-closing pair", () => {
    const config = generateLanguageConfig();
    expect(config.autoClosingPairs).toContainEqual({ open: "<", close: ">" });
  });

  it("has correct number of auto-closing pairs", () => {
    const config = generateLanguageConfig();
    expect(config.autoClosingPairs.length).toBe(7);
  });
});

// ─── generateTypeStubs ───────────────────────────────────────────────────────

describe("generateTypeStubs", () => {
  it("returns a non-empty object", () => {
    const stubs = generateTypeStubs();
    expect(typeof stubs).toBe("object");
    expect(Object.keys(stubs).length).toBeGreaterThan(0);
  });

  it("returns at least 15 type stubs", () => {
    const stubs = generateTypeStubs();
    // Threshold lowered from 18 after removing memo, memoFn, createSignal,
    // createMemo, createEffect in 1.4.0.
    expect(Object.keys(stubs).length).toBeGreaterThanOrEqual(15);
  });

  it("includes signal type stub", () => {
    const stubs = generateTypeStubs();
    expect(stubs["signal"]).toBeDefined();
    expect(stubs["signal"]).toContain("declare function signal");
    expect(stubs["signal"]).toContain("<T>");
  });

  it("includes effect type stub", () => {
    const stubs = generateTypeStubs();
    expect(stubs["effect"]).toBeDefined();
    expect(stubs["effect"]).toContain("declare function effect");
  });

  it("includes mount type stub", () => {
    const stubs = generateTypeStubs();
    expect(stubs["mount"]).toBeDefined();
    expect(stubs["mount"]).toContain("declare function mount");
    expect(stubs["mount"]).toContain("HTMLElement");
  });

  it("includes each type stub", () => {
    const stubs = generateTypeStubs();
    expect(stubs["each"]).toBeDefined();
    expect(stubs["each"]).toContain("declare function each");
    expect(stubs["each"]).toContain("key");
  });

  it("includes context type stub", () => {
    const stubs = generateTypeStubs();
    expect(stubs["context"]).toBeDefined();
    expect(stubs["context"]).toContain("declare function context");
    expect(stubs["context"]).toContain("Context<T>");
  });

  it("includes derived type stub", () => {
    const stubs = generateTypeStubs();
    expect(stubs["derived"]).toBeDefined();
    expect(stubs["derived"]).toContain("declare function derived");
  });

  it("includes store type stub with StoreActions interface", () => {
    const stubs = generateTypeStubs();
    expect(stubs["store"]).toBeDefined();
    expect(stubs["store"]).toContain("StoreActions");
    expect(stubs["store"]).toContain("declare function store");
  });

  it("includes watch type stub", () => {
    const stubs = generateTypeStubs();
    expect(stubs["watch"]).toBeDefined();
    expect(stubs["watch"]).toContain("declare function watch");
  });

  it("includes lazy and Suspense stubs", () => {
    const stubs = generateTypeStubs();
    expect(stubs["lazy"]).toBeDefined();
    expect(stubs["lazy"]).toContain("declare function lazy");
    expect(stubs["Suspense"]).toBeDefined();
    expect(stubs["Suspense"]).toContain("declare function Suspense");
  });

  it("does NOT include stubs for removed SolidJS-style aliases", () => {
    const stubs = generateTypeStubs();
    expect(stubs["createSignal"]).toBeUndefined();
    expect(stubs["createMemo"]).toBeUndefined();
    expect(stubs["createEffect"]).toBeUndefined();
    expect(stubs["memo"]).toBeUndefined();
    expect(stubs["memoFn"]).toBeUndefined();
  });

  it("includes DynamicComponent and registerComponent stubs", () => {
    const stubs = generateTypeStubs();
    expect(stubs["DynamicComponent"]).toBeDefined();
    expect(stubs["DynamicComponent"]).toContain("declare function DynamicComponent");
    expect(stubs["registerComponent"]).toBeDefined();
    expect(stubs["registerComponent"]).toContain("declare function registerComponent");
  });

  it("includes tagFactory stub with TagProps interface", () => {
    const stubs = generateTypeStubs();
    expect(stubs["tagFactory"]).toBeDefined();
    expect(stubs["tagFactory"]).toContain("TagProps");
    expect(stubs["tagFactory"]).toContain("declare function tagFactory");
  });

  it("all stubs contain valid TypeScript declare syntax", () => {
    const stubs = generateTypeStubs();
    Object.entries(stubs).forEach(([_key, stub]) => {
      expect(stub).toContain("declare function");
    });
  });

  it("all stub values are non-empty strings", () => {
    const stubs = generateTypeStubs();
    Object.entries(stubs).forEach(([_key, stub]) => {
      expect(typeof stub).toBe("string");
      expect(stub.length).toBeGreaterThan(0);
    });
  });

  it("ref stub includes Ref interface", () => {
    const stubs = generateTypeStubs();
    expect(stubs["ref"]).toBeDefined();
    expect(stubs["ref"]).toContain("Ref<T>");
    expect(stubs["ref"]).toContain("current");
  });

  it("onMount and onUnmount stubs are present", () => {
    const stubs = generateTypeStubs();
    expect(stubs["onMount"]).toBeDefined();
    expect(stubs["onMount"]).toContain("declare function onMount");
    expect(stubs["onUnmount"]).toBeDefined();
    expect(stubs["onUnmount"]).toContain("declare function onUnmount");
  });
});
