import { describe, expect, it, vi } from "vitest";
import { dispose } from "../src/core/rendering/dispose";
import { onCleanup, onMount, onUnmount } from "../src/core/rendering/lifecycle";

describe("onMount", () => {
  it("should call callback via microtask when no element specified", async () => {
    const cb = vi.fn();
    onMount(cb);

    expect(cb).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(cb).toHaveBeenCalledOnce();
  });

  it("should call callback when element is already connected", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);

    const cb = vi.fn();
    onMount(cb, el);

    await Promise.resolve();
    expect(cb).toHaveBeenCalledOnce();

    document.body.removeChild(el);
  });
});

describe("onUnmount", () => {
  it("should call callback when element is removed from DOM", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);

    const cb = vi.fn();
    onUnmount(cb, el);

    // Give observer time to start
    await new Promise((r) => setTimeout(r, 10));

    document.body.removeChild(el);

    // MutationObserver is async
    await new Promise((r) => setTimeout(r, 50));

    expect(cb).toHaveBeenCalledOnce();
  });
});

describe("onCleanup", () => {
  it("should run callback when dispose() is called on element", () => {
    const cb = vi.fn();
    const el = document.createElement("div");
    onCleanup(cb, el);

    expect(cb).not.toHaveBeenCalled();
    dispose(el);
    expect(cb).toHaveBeenCalledOnce();
  });

  it("should run multiple cleanup callbacks", () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const el = document.createElement("div");
    onCleanup(cb1, el);
    onCleanup(cb2, el);

    dispose(el);
    expect(cb1).toHaveBeenCalledOnce();
    expect(cb2).toHaveBeenCalledOnce();
  });

  it("should run cleanup on child elements when parent is disposed", () => {
    const cb = vi.fn();
    const parent = document.createElement("div");
    const child = document.createElement("span");
    parent.appendChild(child);
    onCleanup(cb, child);

    dispose(parent);
    expect(cb).toHaveBeenCalledOnce();
  });
});
