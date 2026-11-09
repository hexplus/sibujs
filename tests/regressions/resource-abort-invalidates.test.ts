import { describe, expect, it, vi } from "vitest";
import { signal } from "../../src/core/signals/signal";
import { resource } from "../../src/data/resource";

const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const noRetry = { maxRetries: 0 };

interface Call<T> {
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  signal: AbortSignal;
}

/** A fetcher that ignores its AbortSignal and settles only when told to. */
function ignoringFetcher<T>() {
  const calls: Call<T>[] = [];
  const fetcher = ({ signal }: { signal: AbortSignal }) =>
    new Promise<T>((resolve, reject) => {
      calls.push({ resolve, reject, signal });
    });
  return { calls, fetcher };
}

function spies() {
  return { onStart: vi.fn(), onSuccess: vi.fn(), onError: vi.fn(), onSettled: vi.fn() };
}

describe("resource.abort() cancels the run logically (audit F10)", () => {
  it("discards a late successful result from a fetcher that ignores the signal", async () => {
    const { calls, fetcher } = ignoringFetcher<string>();
    const callbacks = spies();
    const r = resource(fetcher, { retry: noRetry, ...callbacks });

    r.abort();
    calls[0].resolve("cancelled response");
    await tick();

    expect(r.data()).toBeUndefined();
    expect(r.error()).toBeUndefined();
    expect(callbacks.onSuccess).not.toHaveBeenCalled();
    r.dispose();
  });

  it("discards a late rejection from a fetcher that ignores the signal", async () => {
    const { calls, fetcher } = ignoringFetcher<string>();
    const callbacks = spies();
    const r = resource(fetcher, { retry: noRetry, ...callbacks });

    r.abort();
    calls[0].reject(new Error("too late"));
    await tick();

    expect(r.error()).toBeUndefined();
    expect(callbacks.onError).not.toHaveBeenCalled();
    r.dispose();
  });

  it("still aborts the transport", () => {
    const { calls, fetcher } = ignoringFetcher<string>();
    const r = resource(fetcher, { retry: noRetry });

    r.abort();

    expect(calls[0].signal.aborted).toBe(true);
    r.dispose();
  });

  it("clears loading immediately and keeps the data already held", async () => {
    const { calls, fetcher } = ignoringFetcher<string>();
    const r = resource(fetcher, { retry: noRetry });
    calls[0].resolve("first");
    await tick();

    void r.refetch();
    expect(r.loading()).toBe(true);
    r.abort();

    expect(r.loading()).toBe(false);
    expect(r.data()).toBe("first");
    r.dispose();
  });

  it("runs onSettled once, at the abort, and not again at the late settlement", async () => {
    const { calls, fetcher } = ignoringFetcher<string>();
    const callbacks = spies();
    const r = resource(fetcher, { retry: noRetry, ...callbacks });

    r.abort();
    expect(callbacks.onSettled).toHaveBeenCalledTimes(1);

    calls[0].resolve("late");
    await tick();

    expect(callbacks.onStart).toHaveBeenCalledTimes(1);
    expect(callbacks.onSettled).toHaveBeenCalledTimes(1);
    r.dispose();
  });

  it("runs onSettled once when the fetcher honors the abort", async () => {
    const callbacks = spies();
    const r = resource(
      ({ signal }) =>
        new Promise<string>((_, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
      { retry: noRetry, ...callbacks },
    );

    r.abort();
    await tick();

    expect(r.loading()).toBe(false);
    expect(r.error()).toBeUndefined();
    expect(callbacks.onSettled).toHaveBeenCalledTimes(1);
    r.dispose();
  });

  it("stops scheduled retries", async () => {
    let attempts = 0;
    const r = resource(
      async () => {
        attempts++;
        throw new Error("fails");
      },
      { retry: { maxRetries: 2, baseDelay: 1, jitter: 0 } },
    );
    await tick();

    r.abort();
    await new Promise((done) => setTimeout(done, 20));

    expect(attempts).toBe(1);
    expect(r.error()).toBeUndefined();
    r.dispose();
  });
});

describe("resource after an abort (audit F10)", () => {
  it("commits a later refetch normally", async () => {
    const { calls, fetcher } = ignoringFetcher<string>();
    const callbacks = spies();
    const r = resource(fetcher, { retry: noRetry, ...callbacks });
    r.abort();

    const refetched = r.refetch();
    expect(r.loading()).toBe(true);
    calls[1].resolve("fresh");
    await refetched;

    expect(r.data()).toBe("fresh");
    expect(r.loading()).toBe(false);
    expect(callbacks.onSuccess).toHaveBeenCalledTimes(1);
    expect(callbacks.onSuccess).toHaveBeenCalledWith("fresh");
    expect(callbacks.onSettled).toHaveBeenCalledTimes(2);
    r.dispose();
  });

  it("ignores the aborted run when it settles after a newer one started", async () => {
    const { calls, fetcher } = ignoringFetcher<string>();
    const r = resource(fetcher, { retry: noRetry });
    r.abort();
    void r.refetch();

    calls[0].resolve("cancelled");
    await tick();

    expect(r.data()).toBeUndefined();
    expect(r.loading()).toBe(true);
    calls[1].resolve("fresh");
    await tick();
    expect(r.data()).toBe("fresh");
    r.dispose();
  });

  it("can be aborted again on the next run", async () => {
    const { calls, fetcher } = ignoringFetcher<string>();
    const callbacks = spies();
    const r = resource(fetcher, { retry: noRetry, ...callbacks });
    r.abort();
    void r.refetch();

    r.abort();
    calls[1].resolve("cancelled too");
    await tick();

    expect(calls[1].signal.aborted).toBe(true);
    expect(r.data()).toBeUndefined();
    expect(callbacks.onSettled).toHaveBeenCalledTimes(2);
    r.dispose();
  });

  it("fetches again when a source changes", async () => {
    const [id, setId] = signal(1);
    const results: Array<(value: string) => void> = [];
    const r = resource(
      id,
      () =>
        new Promise<string>((resolve) => {
          results.push(resolve);
        }),
      { retry: noRetry },
    );
    r.abort();

    setId(2);
    results[0]("stale");
    results[1]("for id 2");
    await tick();

    expect(r.data()).toBe("for id 2");
    r.dispose();
  });

  it("supports starting a refetch from onSettled", async () => {
    const { calls, fetcher } = ignoringFetcher<string>();
    let again = true;
    const r: ReturnType<typeof resource<string>> = resource(fetcher, {
      retry: noRetry,
      onSettled: () => {
        if (again) {
          again = false;
          void r.refetch();
        }
      },
    });

    r.abort();

    expect(r.loading()).toBe(true);
    calls[1].resolve("fresh");
    await tick();
    expect(r.data()).toBe("fresh");
    r.dispose();
  });

  it("keeps a refetch started by an abort listener", async () => {
    const { calls, fetcher } = ignoringFetcher<string>();
    const r = resource(fetcher, { retry: noRetry });
    calls[0].signal.addEventListener("abort", () => void r.refetch());

    r.abort();

    expect(calls).toHaveLength(2);
    expect(r.loading()).toBe(true);
    calls[1].resolve("fresh");
    await tick();
    expect(r.data()).toBe("fresh");
    expect(r.loading()).toBe(false);
    r.dispose();
  });
});

describe("resource.abort() with nothing to cancel (audit F10)", () => {
  it("does nothing before the first fetch", () => {
    const { fetcher } = ignoringFetcher<string>();
    const callbacks = spies();
    const r = resource(fetcher, { retry: noRetry, immediate: false, ...callbacks });

    r.abort();

    expect(callbacks.onSettled).not.toHaveBeenCalled();
    r.dispose();
  });

  it("does nothing after the run has finished", async () => {
    const { calls, fetcher } = ignoringFetcher<string>();
    const callbacks = spies();
    const r = resource(fetcher, { retry: noRetry, ...callbacks });
    calls[0].resolve("done");
    await tick();

    r.abort();

    expect(r.data()).toBe("done");
    expect(calls[0].signal.aborted).toBe(false);
    expect(callbacks.onSettled).toHaveBeenCalledTimes(1);
    r.dispose();
  });

  it("does nothing the second time", () => {
    const { fetcher } = ignoringFetcher<string>();
    const callbacks = spies();
    const r = resource(fetcher, { retry: noRetry, ...callbacks });

    r.abort();
    r.abort();

    expect(callbacks.onSettled).toHaveBeenCalledTimes(1);
    r.dispose();
  });

  it("does nothing after dispose", () => {
    const { fetcher } = ignoringFetcher<string>();
    const callbacks = spies();
    const r = resource(fetcher, { retry: noRetry, ...callbacks });

    r.dispose();
    r.abort();

    expect(callbacks.onSettled).not.toHaveBeenCalled();
  });
});

describe("resource.abort() called from a lifecycle callback (audit F10)", () => {
  it("cancels the run from onStart before the fetcher is called", async () => {
    const fetcher = vi.fn(async () => "value");
    const onSettled = vi.fn();
    let r: ReturnType<typeof resource<string>> | undefined;
    r = resource(fetcher, {
      retry: noRetry,
      immediate: false,
      onStart: () => r?.abort(),
      onSettled,
    });

    await r.refetch();

    expect(fetcher).not.toHaveBeenCalled();
    expect(r.loading()).toBe(false);
    expect(r.data()).toBeUndefined();
    expect(onSettled).toHaveBeenCalledTimes(1);
    r.dispose();
  });

  it("runs onSettled once when aborted from onSuccess", async () => {
    const onSettled = vi.fn();
    let r: ReturnType<typeof resource<string>> | undefined;
    r = resource(async () => "value", {
      retry: noRetry,
      immediate: false,
      onSuccess: () => r?.abort(),
      onSettled,
    });

    await r.refetch();

    expect(r.data()).toBe("value");
    expect(r.loading()).toBe(false);
    expect(onSettled).toHaveBeenCalledTimes(1);
    r.dispose();
  });
});
