import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { permissions } from "../src/browser/permissions";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("permissions", () => {
  let mockStatus: Record<string, unknown>;
  let changeHandler: (() => void) | null;

  beforeEach(() => {
    changeHandler = null;

    mockStatus = {
      state: "prompt",
      addEventListener: vi.fn((event: string, handler: () => void) => {
        if (event === "change") changeHandler = handler;
      }),
      removeEventListener: vi.fn(),
    };

    vi.stubGlobal("navigator", {
      permissions: {
        query: vi.fn(() => Promise.resolve(mockStatus)),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns prompt as initial state", () => {
    const { state } = permissions("camera");
    expect(state()).toBe("prompt");
  });

  it("updates state after permissions query resolves", async () => {
    mockStatus.state = "granted";
    const { state } = permissions("camera");
    await tick();

    expect(state()).toBe("granted");
  });

  it("updates reactively when permission state changes", async () => {
    const { state } = permissions("camera");
    await tick();

    expect(state()).toBe("prompt");

    mockStatus.state = "granted";
    changeHandler?.();
    expect(state()).toBe("granted");

    mockStatus.state = "denied";
    changeHandler?.();
    expect(state()).toBe("denied");
  });

  it("returns unsupported when permissions API is not available", () => {
    vi.stubGlobal("navigator", {});
    const { state } = permissions("camera");
    expect(state()).toBe("unsupported");
  });

  it("removes event listener on dispose", async () => {
    const { dispose } = permissions("camera");
    await tick();

    dispose();
    expect(mockStatus.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
  });
});
