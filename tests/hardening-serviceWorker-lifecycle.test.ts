/**
 * serviceWorker SSR safety + registration/unregister state machine.
 *
 * INVARIANT (SSR): a platform helper must not throw where `navigator` is absent.
 * INVARIANT (lifecycle): a FAILED unregister must not permanently detach the
 * wrapper, and an unregister requested while registration is still pending must
 * still unregister the registration once it resolves — never leave a live
 * browser registration that SibuJS has forgotten about.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serviceWorker } from "../src/platform/serviceWorker";

interface FakeWorker {
  state: string;
  addEventListener: (t: string, h: () => void) => void;
  removeEventListener: (t: string, h: () => void) => void;
  fire: () => void;
}

function fakeWorker(state = "installed"): FakeWorker {
  const handlers = new Set<() => void>();
  return {
    state,
    addEventListener: (_t, h) => handlers.add(h),
    removeEventListener: (_t, h) => handlers.delete(h),
    fire: () => {
      for (const h of handlers) h();
    },
  };
}

function fakeRegistration(unregisterResult = true) {
  const handlers = new Set<() => void>();
  const reg = {
    installing: null as FakeWorker | null,
    unregisterCalls: 0,
    addEventListener: (_t: string, h: () => void) => handlers.add(h),
    removeEventListener: (_t: string, h: () => void) => handlers.delete(h),
    update: vi.fn(async () => {}),
    unregister: vi.fn(async () => {
      reg.unregisterCalls++;
      return unregisterResult;
    }),
    fireUpdateFound: () => {
      for (const h of handlers) h();
    },
    listenerCount: () => handlers.size,
  };
  return reg;
}

const originalNavigator = globalThis.navigator;
const flush = () => new Promise((r) => setTimeout(r, 0));

function installNavigator(register: () => Promise<unknown>, controller: unknown = {}) {
  Object.defineProperty(globalThis, "navigator", {
    value: { serviceWorker: { register, controller } },
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, "navigator", {
    value: originalNavigator,
    configurable: true,
    writable: true,
  });
  vi.restoreAllMocks();
});

describe("serviceWorker — SSR safety", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "navigator", {
      value: undefined,
      configurable: true,
      writable: true,
    });
  });

  it("does not throw when navigator is undefined", () => {
    expect(() => serviceWorker("/sw.js")).not.toThrow();
  });

  it("reports an inert, unsupported state without navigator", async () => {
    const sw = serviceWorker("/sw.js");
    expect(sw.registration()).toBeNull();
    expect(sw.isReady()).toBe(false);
    expect(sw.isUpdateAvailable()).toBe(false);
    await expect(sw.update()).resolves.toBeUndefined();
    await expect(sw.unregister()).resolves.toBe(false);
  });
});

describe("serviceWorker — registration lifecycle", () => {
  it("exposes the registration on success", async () => {
    const reg = fakeRegistration();
    installNavigator(async () => reg);

    const sw = serviceWorker("/sw.js");
    await flush();

    expect(sw.registration()).toBe(reg as unknown as ServiceWorkerRegistration);
    expect(sw.isReady()).toBe(true);
  });

  it("captures a registration failure", async () => {
    installNavigator(async () => {
      throw new Error("nope");
    });

    const sw = serviceWorker("/sw.js");
    await flush();

    expect(sw.error()?.message).toBe("nope");
    expect(sw.isReady()).toBe(false);
  });

  it("clears state when unregister() returns true", async () => {
    const reg = fakeRegistration(true);
    installNavigator(async () => reg);

    const sw = serviceWorker("/sw.js");
    await flush();

    await expect(sw.unregister()).resolves.toBe(true);
    expect(sw.registration()).toBeNull();
    expect(sw.isReady()).toBe(false);
  });

  it("stays operational when unregister() returns false", async () => {
    const reg = fakeRegistration(false);
    installNavigator(async () => reg);

    const sw = serviceWorker("/sw.js");
    await flush();

    await expect(sw.unregister()).resolves.toBe(false);

    // The registration is still live in the browser, so the wrapper must keep
    // reporting it rather than pretending it is gone.
    expect(sw.registration()).toBe(reg as unknown as ServiceWorkerRegistration);
    expect(sw.isReady()).toBe(true);
  });

  it("keeps tracking updates after a failed unregister", async () => {
    const reg = fakeRegistration(false);
    installNavigator(async () => reg);

    const sw = serviceWorker("/sw.js");
    await flush();
    await sw.unregister();

    const worker = fakeWorker("installed");
    reg.installing = worker;
    reg.fireUpdateFound();
    worker.fire();

    expect(sw.isUpdateAvailable()).toBe(true);
  });

  it("still allows update() after a failed unregister", async () => {
    const reg = fakeRegistration(false);
    installNavigator(async () => reg);

    const sw = serviceWorker("/sw.js");
    await flush();
    await sw.unregister();

    await sw.update();
    expect(reg.update).toHaveBeenCalledTimes(1);
  });

  it("unregisters a registration that resolves after unregister() was called", async () => {
    const reg = fakeRegistration(true);
    let resolveRegistration!: (r: unknown) => void;
    installNavigator(
      () =>
        new Promise((res) => {
          resolveRegistration = res;
        }),
    );

    const sw = serviceWorker("/sw.js");
    const pending = sw.unregister();

    resolveRegistration(reg);
    await flush();
    await pending;
    await flush();

    // The browser registration must not survive with SibuJS reporting nothing.
    expect(reg.unregister).toHaveBeenCalledTimes(1);
    expect(sw.registration()).toBeNull();
    expect(sw.isReady()).toBe(false);
  });

  it("does not report ready for a registration that arrives after unregister", async () => {
    const reg = fakeRegistration(true);
    let resolveRegistration!: (r: unknown) => void;
    installNavigator(
      () =>
        new Promise((res) => {
          resolveRegistration = res;
        }),
    );

    const sw = serviceWorker("/sw.js");
    void sw.unregister();

    resolveRegistration(reg);
    await flush();
    await flush();

    expect(sw.isReady()).toBe(false);
  });

  it("is idempotent across repeated unregister() calls", async () => {
    const reg = fakeRegistration(true);
    installNavigator(async () => reg);

    const sw = serviceWorker("/sw.js");
    await flush();

    await sw.unregister();
    await sw.unregister();

    expect(reg.unregister).toHaveBeenCalledTimes(1);
  });

  it("detaches listeners after a successful unregister", async () => {
    const reg = fakeRegistration(true);
    installNavigator(async () => reg);

    const sw = serviceWorker("/sw.js");
    await flush();
    expect(reg.listenerCount()).toBe(1);

    await sw.unregister();
    expect(reg.listenerCount()).toBe(0);
  });
});
