import { afterEach, describe, expect, it, vi } from "vitest";
import { catchError, catchErrorAsync, setGlobalErrorHandler } from "../src/core/rendering/catch";

describe("catchError (sync)", () => {
  afterEach(() => {
    // Reset the global handler between tests so leakage does not affect others.
    setGlobalErrorHandler(null as unknown as (error: unknown, context?: string) => void);
    vi.restoreAllMocks();
  });

  it("returns the function result when no error is thrown", () => {
    const result = catchError(() => 42);
    expect(result).toBe(42);
  });

  it("returns null when the function throws", () => {
    const result = catchError(() => {
      throw new Error("boom");
    });
    expect(result).toBeNull();
  });

  it("invokes the provided onError handler with the error and 'sync' context", () => {
    const onError = vi.fn();
    const err = new Error("kaboom");
    catchError(() => {
      throw err;
    }, onError);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(err, "sync");
  });

  it("falls back to the global handler when no onError is given", () => {
    const handler = vi.fn();
    setGlobalErrorHandler(handler);
    const err = new Error("global");
    catchError(() => {
      throw err;
    });
    expect(handler).toHaveBeenCalledWith(err, "sync");
  });

  it("prefers onError over the global handler", () => {
    const handler = vi.fn();
    const onError = vi.fn();
    setGlobalErrorHandler(handler);
    catchError(() => {
      throw new Error("x");
    }, onError);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it("logs to console.error when neither handler is present", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    catchError(() => {
      throw new Error("unhandled");
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain("Unhandled error in Sibu.catchError");
  });

  it("returns falsy non-thenable results as-is without treating them as promises", () => {
    expect(catchError(() => 0)).toBe(0);
    expect(catchError(() => "")).toBe("");
    expect(catchError(() => false)).toBe(false);
  });
});

describe("catchError (async / thenable handling)", () => {
  afterEach(() => {
    setGlobalErrorHandler(null as unknown as (error: unknown, context?: string) => void);
    vi.restoreAllMocks();
  });

  it("returns the promise and routes a rejection to onError with 'async' context", async () => {
    const onError = vi.fn();
    const err = new Error("async-fail");
    const result = catchError(() => Promise.reject(err), onError);
    expect(result).toBeInstanceOf(Promise);
    // The internal .catch swallows the rejection, so awaiting is safe.
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith(err, "async");
  });

  it("does not call onError when the returned promise resolves", async () => {
    const onError = vi.fn();
    const result = catchError(() => Promise.resolve("ok"), onError);
    await expect(result as Promise<string>).resolves.toBe("ok");
    expect(onError).not.toHaveBeenCalled();
  });

  it("routes a rejection to the global handler when no onError is given", async () => {
    const handler = vi.fn();
    setGlobalErrorHandler(handler);
    const err = new Error("async-global");
    catchError(() => Promise.reject(err));
    await Promise.resolve();
    await Promise.resolve();
    expect(handler).toHaveBeenCalledWith(err, "async");
  });

  it("logs async rejections to console.error when no handler is present", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    catchError(() => Promise.reject(new Error("noh")));
    await Promise.resolve();
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain("Unhandled async error in Sibu.catchError");
  });

  it("treats any thenable (custom .then) as async", async () => {
    const onError = vi.fn();
    const thenable = {
      // biome-ignore lint/suspicious/noThenProperty: intentional thenable being tested
      then(_res: unknown, _rej: unknown) {
        return this;
      },
      catch(cb: (e: unknown) => void) {
        cb(new Error("thenable-fail"));
        return this;
      },
    };
    catchError(() => thenable, onError);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][1]).toBe("async");
  });
});

describe("catchErrorAsync", () => {
  afterEach(() => {
    setGlobalErrorHandler(null as unknown as (error: unknown, context?: string) => void);
    vi.restoreAllMocks();
  });

  it("resolves to the awaited result on success", async () => {
    const result = await catchErrorAsync(async () => "value");
    expect(result).toBe("value");
  });

  it("resolves to null on rejection", async () => {
    const result = await catchErrorAsync(async () => {
      throw new Error("rejected");
    });
    expect(result).toBeNull();
  });

  it("invokes onError with the error and 'async' context", async () => {
    const onError = vi.fn();
    const err = new Error("ohno");
    await catchErrorAsync(async () => {
      throw err;
    }, onError);
    expect(onError).toHaveBeenCalledWith(err, "async");
  });

  it("falls back to the global handler", async () => {
    const handler = vi.fn();
    setGlobalErrorHandler(handler);
    const err = new Error("g");
    await catchErrorAsync(async () => {
      throw err;
    });
    expect(handler).toHaveBeenCalledWith(err, "async");
  });

  it("logs to console.error when no handler is present", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await catchErrorAsync(async () => {
      throw new Error("x");
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain("Unhandled async error in Sibu.catchErrorAsync");
  });
});

describe("setGlobalErrorHandler recovery semantics", () => {
  afterEach(() => {
    setGlobalErrorHandler(null as unknown as (error: unknown, context?: string) => void);
  });

  it("a newly set handler replaces the previous one", () => {
    const first = vi.fn();
    const second = vi.fn();
    setGlobalErrorHandler(first);
    setGlobalErrorHandler(second);
    catchError(() => {
      throw new Error("e");
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
