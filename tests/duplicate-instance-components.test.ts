// @vitest-environment node
//
// 30. The dynamic component registry is shared across duplicate module copies.
// Same technique as duplicate-instance.test.ts: bundle the module once, evaluate
// it twice against one globalThis.

import { createRequire } from "node:module";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

// jsdom ships without type declarations; only the constructor is needed here.
const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html: string) => { window: Window & Record<string, unknown> };
};

interface Copy {
  registerComponent: (name: string, component: () => HTMLElement) => void;
  unregisterComponent: (name: string) => void;
  resolveComponent: (name: string) => HTMLElement;
}

let bundleCode = "";
const DOM_GLOBALS = [
  "window",
  "document",
  "Node",
  "Element",
  "HTMLElement",
  "SVGElement",
  "Text",
  "Comment",
  "DocumentFragment",
];
const saved = new Map<string, PropertyDescriptor | undefined>();

function loadCopy(): Copy {
  const module = { exports: {} as Record<string, unknown> };
  new Function("module", "exports", "require", bundleCode)(module, module.exports, require);
  return module.exports as unknown as Copy;
}

beforeAll(async () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  for (const key of DOM_GLOBALS) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === "window" ? dom.window : (dom.window as unknown as Record<string, unknown>)[key],
    });
  }
  const result = await build({
    stdin: {
      contents: `export { registerComponent, unregisterComponent, resolveComponent } from "./src/core/rendering/dynamic";`,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    logLevel: "silent",
  });
  bundleCode = result.outputFiles[0].text;
});

afterAll(() => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
});

const make = (label: string) => () => {
  const el = document.createElement("section");
  el.textContent = label;
  return el;
};

describe("component registry across duplicate copies", () => {
  test("the two copies are genuinely separate module instances", () => {
    expect(loadCopy().registerComponent).not.toBe(loadCopy().registerComponent);
  });

  test("register through copy A, resolve through copy B", () => {
    const a = loadCopy();
    const b = loadCopy();
    a.registerComponent("Shared", make("from A"));
    expect(b.resolveComponent("Shared").textContent).toBe("from A");
    a.unregisterComponent("Shared");
  });

  test("unregistering through either copy removes it for both", () => {
    const a = loadCopy();
    const b = loadCopy();
    a.registerComponent("Gone", make("x"));
    b.unregisterComponent("Gone");
    expect(a.resolveComponent("Gone").textContent).toContain('[Component "Gone" not found]');

    b.registerComponent("Gone", make("y"));
    a.unregisterComponent("Gone");
    expect(b.resolveComponent("Gone").textContent).toContain("not found");
  });

  test("re-registering through one copy is visible to the other", () => {
    const a = loadCopy();
    const b = loadCopy();
    a.registerComponent("Swap", make("first"));
    b.registerComponent("Swap", make("second"));
    expect(a.resolveComponent("Swap").textContent).toBe("second");
    a.unregisterComponent("Swap");
  });

  test("the registry lives under a versioned global symbol", () => {
    const registry = (globalThis as Record<symbol, unknown>)[Symbol.for("sibujs.components.registry.v1")];
    expect(registry).toBeInstanceOf(Map);
  });
});
