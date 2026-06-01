import { afterEach, describe, expect, it, vi } from "vitest";
import { dispose } from "../src/core/rendering/dispose";
import { Portal } from "../src/core/rendering/portal";

const flush = () => new Promise<void>((r) => queueMicrotask(() => queueMicrotask(() => r())));

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Portal rendering", () => {
  it("appends content to document.body by default", async () => {
    const child = document.createElement("div");
    child.textContent = "default target";
    Portal(() => child);
    await flush();
    expect(document.body.contains(child)).toBe(true);
  });

  it("does not append when disposed before the microtask runs", async () => {
    const child = document.createElement("div");
    child.textContent = "should not mount";
    const target = document.createElement("div");
    document.body.appendChild(target);

    const anchor = Portal(() => child, target);
    // Dispose synchronously, before the queued microtask appends.
    dispose(anchor as unknown as Node);
    await flush();
    expect(target.contains(child)).toBe(false);
  });

  it("removes and disposes content when the anchor is disposed", async () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const child = document.createElement("div");
    child.textContent = "to remove";

    const anchor = Portal(() => child, target);
    await flush();
    expect(target.contains(child)).toBe(true);

    dispose(anchor as unknown as Node);
    expect(target.contains(child)).toBe(false);
  });

  it("logs render errors and dispatches sibu:error-propagate", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const parent = document.createElement("div");
    document.body.appendChild(parent);

    const anchor = Portal(() => {
      throw new Error("render boom");
    });
    parent.appendChild(anchor);

    const handler = vi.fn();
    document.body.addEventListener("sibu:error-propagate", handler);

    await flush();
    await flush();

    expect(errSpy).toHaveBeenCalled();
    expect(handler).toHaveBeenCalledOnce();
    const ev = handler.mock.calls[0][0] as CustomEvent;
    expect((ev.detail as { error: Error }).error.message).toBe("render boom");

    document.body.removeEventListener("sibu:error-propagate", handler);
    errSpy.mockRestore();
  });

  it("swallows errors thrown by a non-Error value", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const anchor = Portal(() => {
      throw "string failure";
    });
    parent.appendChild(anchor);
    await flush();
    await flush();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
