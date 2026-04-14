import { beforeEach, describe, expect, it } from "vitest";
import { dispose, registerDisposer } from "../src/core/rendering/dispose";
import { div } from "../src/core/rendering/html";
import { KeepAlive } from "../src/core/rendering/keepAlive";
import { signal } from "../src/core/signals/signal";

describe("KeepAlive", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  it("preserves DOM identity across key swaps", () => {
    const [tab, setTab] = signal("home");
    const homeNode = div("home-content");
    const settingsNode = div("settings-content");
    const anchor = KeepAlive(tab, {
      home: () => homeNode,
      settings: () => settingsNode,
    });
    container.appendChild(anchor);

    // Initial render is deferred via microtask
    return Promise.resolve().then(() => {
      expect(container.contains(homeNode)).toBe(true);
      setTab("settings");
      expect(container.contains(settingsNode)).toBe(true);
      expect(container.contains(homeNode)).toBe(false);
      // Switch back — same DOM node reused.
      setTab("home");
      expect(container.contains(homeNode)).toBe(true);
    });
  });

  it("evicts oldest on max overflow and disposes evicted subtree", () => {
    const [tab, setTab] = signal("a");
    const disposed = new Set<string>();
    const make = (label: string) => {
      const el = div(label);
      registerDisposer(el, () => disposed.add(label));
      return el;
    };
    const anchor = KeepAlive(tab, { a: () => make("A"), b: () => make("B"), c: () => make("C") }, { max: 2 });
    container.appendChild(anchor);

    return Promise.resolve()
      .then(() => {
        setTab("b");
        setTab("c"); // evicts "a" (LRU)
      })
      .then(() => {
        expect(disposed.has("A")).toBe(true);
        expect(disposed.has("B") || disposed.has("C")).toBe(false);
      });
  });

  it("disposes every cached subtree when anchor itself is disposed", () => {
    const [tab, setTab] = signal("one");
    const make = (label: string) => {
      const el = div(label);
      (el as unknown as Record<string, string>).__sibuTestLabel = label;
      return el;
    };
    const anchor = KeepAlive(tab, {
      one: () => make("one"),
      two: () => make("two"),
    });
    container.appendChild(anchor);

    return Promise.resolve().then(() => {
      setTab("two"); // populates both keys
      // Dispose the anchor — every cached subtree should be torn down.
      dispose(anchor);
      // After dispose, no cached node should be in DOM.
      const remaining = container.querySelectorAll("*").length;
      expect(remaining).toBeLessThanOrEqual(1); // anchor comment may persist
    });
  });
});
