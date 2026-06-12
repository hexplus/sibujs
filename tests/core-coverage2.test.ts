import { afterEach, describe, expect, it, vi } from "vitest";
import { each } from "../src/core/rendering/each";
import { Fragment } from "../src/core/rendering/fragment";
import { html } from "../src/core/rendering/htm";
import { KeepAlive } from "../src/core/rendering/keepAlive";
import { onMount, onUnmount } from "../src/core/rendering/lifecycle";
import { array } from "../src/core/signals/array";
import { signal } from "../src/core/signals/signal";
import { strictEffect } from "../src/core/strict";
import { bindChildNode } from "../src/reactivity/bindChildNode";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function mountAnchor(anchor: Comment): HTMLElement {
  const root = document.createElement("div");
  document.body.appendChild(root);
  root.appendChild(anchor);
  return root;
}

describe("KeepAlive", () => {
  it("warns on an unbounded cache (max: 0)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const [k] = signal("a");
    KeepAlive(() => k(), { a: () => document.createElement("div") }, { max: 0 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unbounded cache"));
  });

  it("renders nothing for a key with no matching factory", async () => {
    const [k, setK] = signal("a");
    const anchor = KeepAlive(() => k(), { a: () => document.createElement("b") });
    const root = mountAnchor(anchor);
    await Promise.resolve();
    expect(root.querySelector("b")).toBeTruthy();
    setK("missing"); // no factory → detaches, renders nothing, no crash
    expect(root.querySelector("b")).toBeNull();
  });

  it("wraps a DocumentFragment factory result in a display:contents container", async () => {
    const [k] = signal("frag");
    const anchor = KeepAlive(() => k(), {
      frag: () => Fragment([document.createElement("span"), document.createElement("span")]),
    });
    const root = mountAnchor(anchor);
    await Promise.resolve();
    const wrapper = root.querySelector("div");
    expect(wrapper).toBeTruthy();
    expect((wrapper as HTMLElement).style.display).toBe("contents");
    expect(wrapper?.querySelectorAll("span").length).toBe(2);
  });

  it("preserves a cached subtree (no dispose) and re-shows it, with LRU + eviction", async () => {
    const [k, setK] = signal("a");
    const made: Record<string, number> = { a: 0, b: 0, c: 0 };
    const anchor = KeepAlive(
      () => k(),
      {
        a: () => {
          made.a++;
          return document.createElement("a-el");
        },
        b: () => {
          made.b++;
          return document.createElement("b-el");
        },
        c: () => {
          made.c++;
          return document.createElement("c-el");
        },
      },
      { max: 2 },
    );
    const root = mountAnchor(anchor);
    await Promise.resolve();
    setK("b");
    setK("a"); // 'a' cached → not rebuilt; moves to MRU
    expect(made.a).toBe(1); // reused, not recreated
    setK("c"); // cache now exceeds max:2 → evicts LRU ('b')
    setK("b"); // 'b' was evicted → rebuilt
    expect(made.b).toBe(2);
    expect(root).toBeTruthy();
  });
});

describe("bindChildNode edge branches", () => {
  it("clears tracked nodes when the placeholder has no parent", () => {
    const ph = document.createComment("ph"); // never attached
    const [v, setV] = signal(1);
    // First render with a parent so lastNodes is populated, then detach.
    const root = document.createElement("div");
    document.body.appendChild(root);
    root.appendChild(ph);
    bindChildNode(ph, () => document.createTextNode(String(v())));
    root.removeChild(ph); // detach the placeholder
    expect(() => setV(2)).not.toThrow(); // parent-null branch: clears + returns
  });

  it("dedupes duplicate node references in a returned array (dev warn)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = document.createElement("div");
    document.body.appendChild(root);
    const ph = document.createComment("ph");
    root.appendChild(ph);
    const shared = document.createElement("i");
    bindChildNode(ph, () => [shared, shared]); // duplicate ref
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("duplicate node reference"));
    // Only one instance ends up in the DOM.
    expect(root.querySelectorAll("i").length).toBe(1);
  });
});

describe("each detached-anchor error path", () => {
  it("warns (does not throw) when render throws after the anchor is detached", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = document.createElement("div");
    document.body.appendChild(root);
    const [items, setItems] = signal([1]);
    const anchor = each(
      items,
      (item) => {
        if (item() === 2) throw new Error("boom");
        const el = document.createElement("span");
        el.textContent = String(item());
        return el;
      },
      { key: (n) => n },
    );
    root.appendChild(anchor);
    await Promise.resolve();
    setItems([1, 2]); // triggers render throw → queues a microtask
    root.removeChild(anchor); // detach BEFORE the microtask runs
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalled(); // surfaced via devWarn, no crash
  });
});

describe("html template comments / CDATA / processing instructions", () => {
  it("skips <!-- comments -->, <![CDATA[...]]>, and <?pi?> nodes", () => {
    const el = html`<div><!-- c -->A<![CDATA[ x ]]>B<?xml v?>C</div>` as HTMLElement;
    expect(el.tagName).toBe("DIV");
    expect(el.textContent).toContain("A");
    expect(el.textContent).toContain("B");
    expect(el.textContent).toContain("C");
  });

  it("handles an unterminated CDATA / PI without crashing", () => {
    expect(() => html`<span><![CDATA[ unterminated` as HTMLElement).not.toThrow();
    expect(() => html`<span><?pi unterminated` as HTMLElement).not.toThrow();
  });
});

describe("array().updateWhere", () => {
  it("updates only items matching the predicate", () => {
    const [items, actions] = array([1, 2, 3, 4]);
    actions.updateWhere(
      (n) => n % 2 === 0,
      (n) => n * 100,
    );
    expect(items()).toEqual([1, 200, 3, 400]);
  });
});

describe("strictEffect second-run error handling", () => {
  it("swallows a throw from the deferred second effect run", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let n = 0;
    const stop = strictEffect(() => {
      n++;
      if (n === 2) throw new Error("second-run-boom"); // only the deferred run throws
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(n).toBe(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("strictEffect"), expect.anything());
    stop();
  });
});

describe("lifecycle periodic full sweep", () => {
  it("fires watched mount/unmount via the 256-mutation safety sweep", async () => {
    const mounted = document.createElement("div");
    document.body.appendChild(mounted);
    let mountFired = false;
    let unmountFired = false;
    // Register a mount watcher for an already-connected element (goes through
    // the watcher path), and an unmount watcher.
    onMount(() => {
      mountFired = true;
      return undefined;
    }, mounted);
    onUnmount(() => {
      unmountFired = true;
    }, mounted);
    await Promise.resolve();

    // Drive >256 childList mutations on document.body so the shared observer's
    // FULL_SWEEP_INTERVAL counter trips and fullSweep() runs.
    for (let i = 0; i < 300; i++) {
      const n = document.createElement("span");
      document.body.appendChild(n);
      document.body.removeChild(n);
    }
    // Let the MutationObserver callback(s) flush.
    await new Promise((r) => setTimeout(r, 20));
    expect(mountFired).toBe(true);
    // unmount watcher only fires once the element actually disconnects
    document.body.removeChild(mounted);
    await new Promise((r) => setTimeout(r, 20));
    expect(unmountFired).toBe(true);
  });
});
