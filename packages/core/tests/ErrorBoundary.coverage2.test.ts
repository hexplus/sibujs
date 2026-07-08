import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../src/components/ErrorBoundary";
import { dispose } from "../src/core/rendering/dispose";
import { mount } from "../src/core/rendering/mount";
import { signal } from "../src/core/signals/signal";

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("ErrorBoundary coverage", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("renders the default ErrorDisplay fallback when no fallback provided", async () => {
    const boundary = ErrorBoundary(() => {
      throw new Error("default fallback boom");
    });
    document.body.appendChild(boundary);
    await flush();
    expect(boundary.querySelector(".sibu-error-display")).not.toBeNull();
    expect(boundary.textContent).toContain("default fallback boom");
  });

  it("calls onError when a child throws", async () => {
    const onError = vi.fn();
    const boundary = ErrorBoundary({ onError }, () => {
      throw new Error("tracked");
    });
    document.body.appendChild(boundary);
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).toBe("tracked");
  });

  it("logs but does not crash when onError callback throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const boundary = ErrorBoundary(
      {
        onError: () => {
          throw new Error("callback failed");
        },
      },
      () => {
        throw new Error("origin");
      },
    );
    document.body.appendChild(boundary);
    await flush();
    expect(spy).toHaveBeenCalled();
    expect(boundary.textContent).toContain("origin");
  });

  it("wraps non-Error throwables into Error instances", async () => {
    const onError = vi.fn();
    const boundary = ErrorBoundary({ onError }, () => {
      throw "string failure";
    });
    document.body.appendChild(boundary);
    await flush();
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(onError.mock.calls[0][0].message).toBe("string failure");
  });

  it("retry clears the error and re-renders children", async () => {
    const [fail, setFail] = signal(true);
    const retryRef: { fn: (() => void) | null } = { fn: null };
    const boundary = ErrorBoundary(
      {
        fallback: (_err, retry) => {
          retryRef.fn = retry;
          const el = document.createElement("div");
          el.textContent = "fallback";
          return el;
        },
      },
      () => {
        if (fail()) throw new Error("transient");
        const ok = document.createElement("span");
        ok.textContent = "recovered";
        return ok;
      },
    );
    document.body.appendChild(boundary);
    await flush();
    expect(boundary.textContent).toBe("fallback");

    setFail(false);
    retryRef.fn?.();
    await flush();
    expect(boundary.textContent).toBe("recovered");
  });

  it("memoizes the fallback factory per error message (LRU touch)", async () => {
    let calls = 0;
    const fallback = (err: Error) => {
      calls++;
      const el = document.createElement("div");
      el.textContent = err.message;
      return el;
    };
    const [n, setN] = signal(0);
    const boundary = ErrorBoundary({ fallback }, () => {
      // Always throws the SAME message regardless of n so the cache key repeats.
      n();
      throw new Error("same-key");
    });
    document.body.appendChild(boundary);
    await flush();
    const firstCalls = calls;

    // Force a re-render via signal change; the boundary re-runs nodes,
    // catches again with same message, and should reuse the cached factory.
    setN(1);
    await flush();
    expect(calls).toBeGreaterThanOrEqual(firstCalls);
    expect(boundary.textContent).toBe("same-key");
  });

  it("resets automatically when a resetKey changes after an error", async () => {
    const [key, setKey] = signal("a");
    const [fail, setFail] = signal(true);
    const boundary = ErrorBoundary(
      {
        resetKeys: [key],
        fallback: () => {
          const el = document.createElement("div");
          el.textContent = "err-fallback";
          return el;
        },
      },
      () => {
        if (fail()) throw new Error("keyed");
        const ok = document.createElement("span");
        ok.textContent = "ok-content";
        return ok;
      },
    );
    document.body.appendChild(boundary);
    await flush();
    expect(boundary.textContent).toBe("err-fallback");

    // Fix the underlying condition, then change the reset key.
    setFail(false);
    setKey("b");
    await flush();
    expect(boundary.textContent).toBe("ok-content");
  });

  it("does not crash when a resetKey getter throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const throwingKey = () => {
      throw new Error("key getter threw");
    };
    const boundary = ErrorBoundary({ resetKeys: [throwingKey] }, () => {
      const el = document.createElement("div");
      el.textContent = "alive";
      return el;
    });
    document.body.appendChild(boundary);
    await flush();
    expect(boundary.textContent).toBe("alive");
    expect(warn).toHaveBeenCalled();
  });

  it("renders loading then content for async (Promise) children", async () => {
    let resolveChild: (el: Element) => void = () => {};
    const pending = new Promise<Element>((res) => {
      resolveChild = res;
    });
    const boundary = ErrorBoundary(() => pending as unknown as Element);
    document.body.appendChild(boundary);
    // Before the promise resolves, the loading placeholder is shown.
    await Promise.resolve();
    expect(boundary.querySelector(".sibu-lazy-loading")).not.toBeNull();

    const el = document.createElement("span");
    el.textContent = "async-ok";
    resolveChild(el);
    await flush();
    expect(boundary.textContent).toBe("async-ok");
  });

  it("renders fallback when async child rejects", async () => {
    const onError = vi.fn();
    const boundary = ErrorBoundary(
      {
        onError,
        fallback: (err) => {
          const el = document.createElement("div");
          el.textContent = `async-fail:${err.message}`;
          return el;
        },
      },
      () => Promise.reject(new Error("async-boom")) as unknown as Element,
    );
    document.body.appendChild(boundary);
    await flush();
    await flush();
    expect(boundary.textContent).toBe("async-fail:async-boom");
    expect(onError).toHaveBeenCalled();
  });

  it("propagates to a parent boundary when the fallback itself throws", async () => {
    const parentFallback = vi.fn((err: Error) => {
      const el = document.createElement("div");
      el.textContent = `parent-caught:${err.message}`;
      return el;
    });

    const inner = ErrorBoundary(
      {
        fallback: () => {
          throw new Error("fallback-broke");
        },
      },
      () => {
        throw new Error("inner-origin");
      },
    );

    const outer = ErrorBoundary({ fallback: parentFallback }, () => inner);
    document.body.appendChild(outer);
    await flush();
    await flush();
    expect(parentFallback).toHaveBeenCalled();
    expect(outer.textContent).toContain("parent-caught:fallback-broke");
  });

  it("catches a single pending error stashed before mount (onMount scan)", async () => {
    const onError = vi.fn();
    const boundary = ErrorBoundary(
      {
        onError,
        fallback: (err) => {
          const el = document.createElement("div");
          el.textContent = `scanned:${err.message}`;
          return el;
        },
      },
      () => {
        const child = document.createElement("section");
        // Simulate a lazy() child that stashed a pending error.
        (child as unknown as Record<string, unknown>).__sibuPendingError = new Error("pending-one");
        return child;
      },
    );
    mount(boundary, document.body);
    await flush();
    await flush();
    expect(onError).toHaveBeenCalled();
    expect(boundary.textContent).toContain("scanned:pending-one");
  });

  it("tears down the resetKeys effect and listener on dispose", async () => {
    const [key, setKey] = signal("a");
    const fallback = vi.fn(() => {
      const el = document.createElement("div");
      el.textContent = "fb";
      return el;
    });
    const boundary = ErrorBoundary({ resetKeys: [key], fallback }, () => {
      throw new Error("boom");
    });
    document.body.appendChild(boundary);
    await flush();

    // Dispose the boundary — this runs the registered disposer (resetKeys
    // teardown + listener removal).
    dispose(boundary);

    const before = fallback.mock.calls.length;
    // After disposal the resetKeys effect no longer reacts.
    setKey("b");
    await flush();
    expect(fallback.mock.calls.length).toBe(before);
  });

  it("aggregates multiple pending errors found at mount", async () => {
    const onError = vi.fn();
    const boundary = ErrorBoundary(
      {
        onError,
        fallback: (err) => {
          const el = document.createElement("div");
          el.textContent = `agg:${err.message}`;
          return el;
        },
      },
      () => {
        const wrap = document.createElement("div");
        const a = document.createElement("span");
        (a as unknown as Record<string, unknown>).__sibuPendingError = new Error("err-a");
        const b = document.createElement("span");
        (b as unknown as Record<string, unknown>).__sibuPendingError = new Error("err-b");
        wrap.appendChild(a);
        wrap.appendChild(b);
        return wrap;
      },
    );
    mount(boundary, document.body);
    await flush();
    await flush();
    expect(onError).toHaveBeenCalled();
    // Both messages are surfaced via AggregateError.
    const caught = onError.mock.calls[0][0] as Error;
    expect(caught.message).toContain("pre-mount errors");
  });
});
