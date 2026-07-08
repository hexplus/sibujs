import { describe, expect, it, vi } from "vitest";
import { createSharedScope, defineRemoteComponent, loadRemoteModule } from "../src/platform/microfrontend";

const flush = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// loadRemoteModule origin guard (the import() path itself cannot run in jsdom,
// so we only exercise the validation branches that reject before import()).
// ---------------------------------------------------------------------------
describe("loadRemoteModule guard", () => {
  it("refuses with no allowedOrigins and no opt-in", async () => {
    await expect(loadRemoteModule("https://evil.com/m.js")).rejects.toThrow(/refused to import/);
  });

  it("rejects an origin outside the allowlist", async () => {
    await expect(loadRemoteModule("https://evil.com/m.js", ["https://good.com"])).rejects.toThrow(
      /not in the allowlist/,
    );
  });

  it("rejects an invalid URL when an allowlist is provided", async () => {
    await expect(loadRemoteModule("http://[", ["https://good.com"])).rejects.toThrow(/invalid URL/);
  });

  it("accepts the options-bag form", async () => {
    await expect(loadRemoteModule("https://evil.com/m.js", { allowedOrigins: ["https://good.com"] })).rejects.toThrow(
      /not in the allowlist/,
    );
  });
});

// ---------------------------------------------------------------------------
// defineRemoteComponent
// ---------------------------------------------------------------------------
describe("defineRemoteComponent", () => {
  it("renders a loading placeholder, then swaps in the loaded component", async () => {
    const realEl = document.createElement("section");
    realEl.textContent = "loaded";
    const loader = vi.fn().mockResolvedValue({ default: () => realEl });

    const Remote = defineRemoteComponent("hdr", loader);
    const container = Remote();
    expect(container.getAttribute("data-remote-component")).toBe("hdr");
    expect(container.querySelector(".sibu-remote-loading")?.textContent).toBe("Loading...");

    await flush();
    expect(container.querySelector(".sibu-remote-loading")).toBeNull();
    expect(container.querySelector("section")?.textContent).toBe("loaded");
  });

  it("caches the loaded component for instant subsequent renders", async () => {
    let n = 0;
    const loader = vi.fn().mockResolvedValue({
      default: () => {
        const el = document.createElement("div");
        el.textContent = `r${n++}`;
        return el;
      },
    });
    const Remote = defineRemoteComponent("cached", loader);
    Remote();
    await flush();
    // Second call hits the fast path and does not invoke the loader again.
    const second = Remote();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(second.textContent).toBe("r1");
  });

  it("renders an error message when the loader rejects with an Error", async () => {
    const loader = vi.fn().mockRejectedValue(new Error("network down"));
    const Remote = defineRemoteComponent("err1", loader);
    const container = Remote();
    await flush();
    const err = container.querySelector(".sibu-remote-error");
    expect(err?.textContent).toContain('Failed to load remote component "err1"');
    expect(err?.textContent).toContain("network down");
  });

  it("stringifies a non-Error rejection in the error message", async () => {
    const loader = vi.fn().mockRejectedValue("boom-string");
    const Remote = defineRemoteComponent("err2", loader);
    const container = Remote();
    await flush();
    expect(container.querySelector(".sibu-remote-error")?.textContent).toContain("boom-string");
  });
});

// ---------------------------------------------------------------------------
// createSharedScope - branches not covered by the base suite
// ---------------------------------------------------------------------------
describe("createSharedScope extra branches", () => {
  it("lazily creates a signal for a key not in the initial state", () => {
    const scope = createSharedScope<{ a: number; late?: string }>({ a: 1 });
    expect(scope.get("late")).toBeUndefined();
    scope.set("late", "hi");
    expect(scope.get("late")).toBe("hi");
  });

  it("notifies subscribers on set and stops after unsubscribe", () => {
    const scope = createSharedScope<{ count: number }>({ count: 0 });
    const seen: number[] = [];
    const unsub = scope.subscribe("count", (v) => seen.push(v));
    scope.set("count", 1);
    scope.set("count", 2);
    unsub();
    scope.set("count", 3);
    expect(seen).toEqual([1, 2]);
  });

  it("supports subscribing to a lazily-created key", () => {
    const scope = createSharedScope<{ a: number; b?: string }>({ a: 1 });
    const seen: (string | undefined)[] = [];
    scope.subscribe("b", (v) => seen.push(v));
    scope.set("b", "x");
    expect(seen).toEqual(["x"]);
  });
});
