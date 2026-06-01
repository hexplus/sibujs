import { afterEach, describe, expect, it, vi } from "vitest";
import { serviceWorker } from "../src/platform/serviceWorker";

// ---------------------------------------------------------------------------
// Fake ServiceWorker infrastructure
//
// jsdom exposes no navigator.serviceWorker, so we stub a minimal container,
// registration, and worker that let us drive updatefound / statechange events.
// ---------------------------------------------------------------------------

class FakeEventTarget {
  private listeners: Record<string, ((e: unknown) => void)[]> = {};
  addEventListener(type: string, cb: (e: unknown) => void): void {
    (this.listeners[type] ||= []).push(cb);
  }
  removeEventListener(type: string, cb: (e: unknown) => void): void {
    const list = this.listeners[type];
    if (list) this.listeners[type] = list.filter((l) => l !== cb);
  }
  emit(type: string): void {
    for (const cb of this.listeners[type] || []) cb({});
  }
  listenerCount(type: string): number {
    return (this.listeners[type] || []).length;
  }
}

class FakeWorker extends FakeEventTarget {
  state = "installing";
}

class FakeRegistration extends FakeEventTarget {
  installing: FakeWorker | null = null;
  update = vi.fn().mockResolvedValue(undefined);
  unregister = vi.fn().mockResolvedValue(true);
}

function installFakeServiceWorker(
  opts: { registerImpl?: (url: string, options?: unknown) => Promise<unknown>; controller?: unknown } = {},
) {
  const container = {
    register: opts.registerImpl ?? vi.fn((_url: string, _options?: unknown) => Promise.resolve(new FakeRegistration())),
    controller: "controller" in opts ? opts.controller : {},
  };
  Object.defineProperty(navigator, "serviceWorker", {
    value: container,
    configurable: true,
    writable: true,
  });
  return container;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.restoreAllMocks();
  // Remove the stubbed property so other suites see a clean navigator.
  try {
    delete (navigator as Record<string, unknown>).serviceWorker;
  } catch {
    Object.defineProperty(navigator, "serviceWorker", { value: undefined, configurable: true });
  }
});

describe("serviceWorker", () => {
  it("does nothing when serviceWorker is unsupported", () => {
    // Ensure the property is absent.
    Object.defineProperty(navigator, "serviceWorker", { value: undefined, configurable: true });
    delete (navigator as Record<string, unknown>).serviceWorker;
    const sw = serviceWorker("/sw.js");
    expect(sw.registration()).toBeNull();
    expect(sw.isReady()).toBe(false);
  });

  it("registers and marks ready on success", async () => {
    const reg = new FakeRegistration();
    installFakeServiceWorker({ registerImpl: vi.fn().mockResolvedValue(reg) });
    const sw = serviceWorker("/sw.js", { scope: "/" });
    await flush();
    expect(sw.isReady()).toBe(true);
    expect(sw.registration()).toBe(reg);
    expect(reg.listenerCount("updatefound")).toBe(1);
  });

  it("sets error when registration rejects", async () => {
    installFakeServiceWorker({ registerImpl: vi.fn().mockRejectedValue(new Error("nope")) });
    const sw = serviceWorker("/sw.js");
    await flush();
    expect(sw.error()).toBeInstanceOf(Error);
    expect(sw.error()?.message).toBe("nope");
    expect(sw.isReady()).toBe(false);
  });

  it("wraps a non-Error rejection in an Error", async () => {
    installFakeServiceWorker({ registerImpl: vi.fn().mockRejectedValue("string failure") });
    const sw = serviceWorker("/sw.js");
    await flush();
    expect(sw.error()).toBeInstanceOf(Error);
    expect(sw.error()?.message).toBe("string failure");
  });

  it("flags an update available when a new worker installs with a controller", async () => {
    const reg = new FakeRegistration();
    installFakeServiceWorker({ registerImpl: vi.fn().mockResolvedValue(reg), controller: {} });
    const sw = serviceWorker("/sw.js");
    await flush();

    const newWorker = new FakeWorker();
    reg.installing = newWorker;
    reg.emit("updatefound");
    expect(newWorker.listenerCount("statechange")).toBe(1);

    newWorker.state = "installed";
    newWorker.emit("statechange");
    expect(sw.isUpdateAvailable()).toBe(true);
  });

  it("does not flag an update when there is no controller", async () => {
    const reg = new FakeRegistration();
    installFakeServiceWorker({ registerImpl: vi.fn().mockResolvedValue(reg), controller: null });
    const sw = serviceWorker("/sw.js");
    await flush();

    const newWorker = new FakeWorker();
    reg.installing = newWorker;
    reg.emit("updatefound");
    newWorker.state = "installed";
    newWorker.emit("statechange");
    expect(sw.isUpdateAvailable()).toBe(false);
  });

  it("detaches the prior installing-worker listener across multiple updatefound events", async () => {
    const reg = new FakeRegistration();
    installFakeServiceWorker({ registerImpl: vi.fn().mockResolvedValue(reg), controller: {} });
    const sw = serviceWorker("/sw.js");
    await flush();

    const first = new FakeWorker();
    reg.installing = first;
    reg.emit("updatefound");
    expect(first.listenerCount("statechange")).toBe(1);

    const second = new FakeWorker();
    reg.installing = second;
    reg.emit("updatefound");
    expect(first.listenerCount("statechange")).toBe(0);
    expect(second.listenerCount("statechange")).toBe(1);
    void sw;
  });

  it("ignores updatefound when there is no installing worker", async () => {
    const reg = new FakeRegistration();
    installFakeServiceWorker({ registerImpl: vi.fn().mockResolvedValue(reg) });
    serviceWorker("/sw.js");
    await flush();
    reg.installing = null;
    expect(() => reg.emit("updatefound")).not.toThrow();
  });

  it("update() calls registration.update", async () => {
    const reg = new FakeRegistration();
    installFakeServiceWorker({ registerImpl: vi.fn().mockResolvedValue(reg) });
    const sw = serviceWorker("/sw.js");
    await flush();
    await sw.update();
    expect(reg.update).toHaveBeenCalled();
  });

  it("update() is a no-op without a registration", async () => {
    Object.defineProperty(navigator, "serviceWorker", { value: undefined, configurable: true });
    delete (navigator as Record<string, unknown>).serviceWorker;
    const sw = serviceWorker("/sw.js");
    await expect(sw.update()).resolves.toBeUndefined();
  });

  it("unregister() removes the registration and resets state", async () => {
    const reg = new FakeRegistration();
    reg.unregister = vi.fn().mockResolvedValue(true);
    installFakeServiceWorker({ registerImpl: vi.fn().mockResolvedValue(reg) });
    const sw = serviceWorker("/sw.js");
    await flush();
    const result = await sw.unregister();
    expect(result).toBe(true);
    expect(sw.registration()).toBeNull();
    expect(sw.isReady()).toBe(false);
  });

  it("unregister() keeps state when unregister returns false", async () => {
    const reg = new FakeRegistration();
    reg.unregister = vi.fn().mockResolvedValue(false);
    installFakeServiceWorker({ registerImpl: vi.fn().mockResolvedValue(reg) });
    const sw = serviceWorker("/sw.js");
    await flush();
    const result = await sw.unregister();
    expect(result).toBe(false);
    expect(sw.registration()).toBe(reg);
  });

  it("unregister() returns false when there is no registration", async () => {
    installFakeServiceWorker({ registerImpl: vi.fn().mockRejectedValue(new Error("x")) });
    const sw = serviceWorker("/sw.js");
    await flush();
    await expect(sw.unregister()).resolves.toBe(false);
  });

  it("ignores events after dispose (unregister) — disposed guards", async () => {
    const reg = new FakeRegistration();
    installFakeServiceWorker({ registerImpl: vi.fn().mockResolvedValue(reg), controller: {} });
    const sw = serviceWorker("/sw.js");
    await flush();
    await sw.unregister();
    // After dispose, further events must not throw or change state.
    const w = new FakeWorker();
    reg.installing = w;
    expect(() => reg.emit("updatefound")).not.toThrow();
    expect(sw.isUpdateAvailable()).toBe(false);
  });
});
