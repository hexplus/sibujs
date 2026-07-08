import { afterEach, describe, expect, it, vi } from "vitest";
import { wakeLock } from "../src/browser/wakeLock";

class FakeSentinel extends EventTarget {
  released = false;
  type: "screen" = "screen";
  releaseCalls = 0;
  async release() {
    this.releaseCalls++;
    this.released = true;
    this.dispatchEvent(new Event("release"));
  }
}

describe("wakeLock (coverage2)", () => {
  let originalDescriptor: PropertyDescriptor | undefined;

  afterEach(() => {
    if (originalDescriptor) {
      Object.defineProperty(navigator, "wakeLock", originalDescriptor);
    } else {
      delete (navigator as unknown as { wakeLock?: unknown }).wakeLock;
    }
    originalDescriptor = undefined;
    vi.restoreAllMocks();
  });

  function installApi(api: unknown) {
    originalDescriptor = Object.getOwnPropertyDescriptor(navigator, "wakeLock");
    Object.defineProperty(navigator, "wakeLock", {
      value: api,
      configurable: true,
      writable: true,
    });
  }

  it("degrades gracefully when wakeLock is unavailable", async () => {
    // Ensure no wakeLock present
    delete (navigator as unknown as { wakeLock?: unknown }).wakeLock;
    const lock = wakeLock();
    expect(lock.active()).toBe(false);
    await lock.request();
    await lock.release();
    expect(() => lock.dispose()).not.toThrow();
    expect(lock.active()).toBe(false);
  });

  it("request sets active and listens for release events", async () => {
    const sentinel = new FakeSentinel();
    installApi({ request: vi.fn(async () => sentinel) });
    const lock = wakeLock();
    await lock.request();
    expect(lock.active()).toBe(true);

    // Native release event flips active back to false
    sentinel.dispatchEvent(new Event("release"));
    expect(lock.active()).toBe(false);
  });

  it("request handles rejection by clearing active (catch branch)", async () => {
    installApi({ request: vi.fn(async () => Promise.reject(new Error("denied"))) });
    const lock = wakeLock();
    await lock.request();
    expect(lock.active()).toBe(false);
  });

  it("release calls sentinel.release when held and not yet released", async () => {
    const sentinel = new FakeSentinel();
    installApi({ request: vi.fn(async () => sentinel) });
    const lock = wakeLock();
    await lock.request();
    await lock.release();
    expect(sentinel.releaseCalls).toBe(1);
    expect(lock.active()).toBe(false);
  });

  it("release is a no-op when sentinel already released", async () => {
    const sentinel = new FakeSentinel();
    sentinel.released = true;
    installApi({ request: vi.fn(async () => sentinel) });
    const lock = wakeLock();
    await lock.request();
    await lock.release();
    expect(sentinel.releaseCalls).toBe(0);
    expect(lock.active()).toBe(false);
  });

  it("re-acquires the lock on visibility return when previously released", async () => {
    const first = new FakeSentinel();
    const second = new FakeSentinel();
    const request = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    installApi({ request });
    const lock = wakeLock();
    await lock.request();
    expect(request).toHaveBeenCalledTimes(1);

    // Simulate browser auto-releasing on hide
    first.released = true;
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    // allow the async request() inside the handler to resolve
    await Promise.resolve();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);
    expect(lock.active()).toBe(true);
  });

  it("does not re-acquire when document is hidden", async () => {
    const first = new FakeSentinel();
    const request = vi.fn().mockResolvedValue(first);
    installApi({ request });
    const lock = wakeLock();
    await lock.request();
    first.released = true;
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("re-acquire on a rejected second request leaves active false (request swallows error)", async () => {
    const first = new FakeSentinel();
    const request = vi.fn().mockResolvedValueOnce(first).mockRejectedValueOnce(new Error("boom"));
    installApi({ request });
    const lock = wakeLock();
    await lock.request();
    first.released = true;
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);
    // request()'s internal catch sets active false on the failed re-acquire
    expect(lock.active()).toBe(false);
  });

  it("dispose removes the visibility listener and releases", async () => {
    const sentinel = new FakeSentinel();
    installApi({ request: vi.fn(async () => sentinel) });
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const lock = wakeLock();
    await lock.request();
    lock.dispose();
    await Promise.resolve();
    expect(removeSpy).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    expect(sentinel.releaseCalls).toBe(1);
  });

  it("dispose handles release rejection (catch + warn)", async () => {
    const sentinel = new FakeSentinel();
    sentinel.release = async () => {
      throw new Error("release failed");
    };
    installApi({ request: vi.fn(async () => sentinel) });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const lock = wakeLock();
    await lock.request();
    lock.dispose();
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalledWith("[SibuJS wakeLock] release failed:", expect.any(Error));
  });
});
