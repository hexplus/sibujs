import { afterEach, describe, expect, it, vi } from "vitest";
import { isAbortError } from "../src/data/abort";
import { resource } from "../src/data/resource";

// ---------------------------------------------------------------------------
// One cancellation classifier for the whole data layer.
//
// THE INVARIANT UNDER TEST: the same rejected value means the same thing to
// every data primitive.
//
//   cancelled  !=  failed
//
// Regression origin: `resource` and `mutation` recognised only `DOMException`,
// while `query` and `infiniteQuery` accepted any object carrying
// `name === "AbortError"` — a difference they documented deliberately, because
// `DOMException` is not available in every runtime a user's fetcher may run in.
// A fetcher rejecting with `Object.assign(new Error(), { name: "AbortError" })`
// was therefore silently ignored by two primitives and stored as application
// error state by the other two.
// ---------------------------------------------------------------------------

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isAbortError classifies by name, across carriers", () => {
  it("recognises a DOMException abort", () => {
    expect(isAbortError(new DOMException("Aborted", "AbortError"))).toBe(true);
  });

  it("recognises an ordinary Error whose name is AbortError", () => {
    const err = new Error("cancelled");
    err.name = "AbortError";
    expect(isAbortError(err)).toBe(true);
  });

  it("recognises a plain object abort (documented userland-fetcher form)", () => {
    expect(isAbortError({ name: "AbortError" })).toBe(true);
  });

  it("does NOT classify by message — new Error('AbortError') is a real failure", () => {
    const err = new Error("AbortError");
    expect(err.name).toBe("Error");
    expect(isAbortError(err)).toBe(false);
  });

  it("rejects non-objects and unrelated errors", () => {
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
    expect(isAbortError("AbortError")).toBe(false);
    expect(isAbortError(new TypeError("boom"))).toBe(false);
    expect(isAbortError({ name: "TimeoutError" })).toBe(false);
  });
});

describe("resource() treats an ordinary Error named AbortError as cancellation", () => {
  it("does not store it as error state and does not call onError", async () => {
    const onError = vi.fn();
    const abortError = new Error("cancelled");
    abortError.name = "AbortError";

    const res = resource(
      async () => {
        throw abortError;
      },
      { onError, retry: { maxRetries: 0 } },
    );
    await tick();
    await tick();

    // Cancellation is control flow, not a failed data operation.
    expect(res.error()).toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
    expect(res.loading()).toBe(false);
  });

  it("still stores a genuine failure as error state", async () => {
    const onError = vi.fn();
    const failure = new Error("AbortError"); // message only — name is "Error"

    const res = resource(
      async () => {
        throw failure;
      },
      { onError, retry: { maxRetries: 0 } },
    );
    await tick();
    await tick();

    expect(res.error()).toBe(failure);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("also accepts a plain-object abort", async () => {
    const onError = vi.fn();
    const res = resource(
      async () => {
        throw { name: "AbortError", message: "cancelled" };
      },
      { onError, retry: { maxRetries: 0 } },
    );
    await tick();
    await tick();

    expect(res.error()).toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
  });
});
