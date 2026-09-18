import { afterEach, describe, expect, it, vi } from "vitest";
import { dispose, registerDisposer, withDisposerRollback } from "../src/core/rendering/dispose";
import { createHttpMock } from "../src/testing/e2e";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// withDisposerRollback never re-runs a cleanup a dispose() already ran.
// ---------------------------------------------------------------------------
describe("withDisposerRollback and dispose() during the build", () => {
  it("a failed build does not run cleanups that were already disposed", () => {
    const disposedNode = document.createElement("div");
    const liveNode = document.createElement("div");
    const early = vi.fn();
    const late = vi.fn();

    expect(() =>
      withDisposerRollback(() => {
        registerDisposer(disposedNode, early);
        dispose(disposedNode);
        registerDisposer(liveNode, late);
        throw new Error("build failed");
      }),
    ).toThrow("build failed");

    expect(early).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("a successful nested build does not hand disposed cleanups to the enclosing rollback", () => {
    const node = document.createElement("div");
    const inner = vi.fn();
    const survivor = vi.fn();

    expect(() =>
      withDisposerRollback(() => {
        withDisposerRollback(() => {
          registerDisposer(node, inner);
          registerDisposer(node, survivor);
          dispose(node);
          registerDisposer(node, survivor);
        });
        throw new Error("outer failed");
      }),
    ).toThrow("outer failed");

    expect(inner).toHaveBeenCalledTimes(1);
    // Once by dispose(), once by the rollback of its re-registration.
    expect(survivor).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// createHttpMock resolves relative URLs when location is opaque.
// ---------------------------------------------------------------------------
describe("createHttpMock with an opaque location", () => {
  it("a relative URL matches its route when location.href is about:blank", async () => {
    vi.stubGlobal("location", { href: "about:blank" });
    const original = globalThis.fetch;
    const mock = createHttpMock([{ url: "/api/users", response: { body: "users" } }]);
    mock.install();
    try {
      const response = await fetch("/api/users");
      expect(await response.text()).toBe("users");
    } finally {
      mock.restore();
      globalThis.fetch = original;
    }
  });
});
