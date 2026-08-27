/**
 * A single public `unregister()` is ONE logical operation and must consume at
 * most one native `registration.unregister()`.
 *
 * The pending-registration path had two independent callers of the native API:
 * `adopt()` (which unregisters a registration arriving after the request) and
 * `unregister()` itself (resuming once the registration promise settles). When
 * the native call returned `false`, `adopt()` correctly re-adopted the still-live
 * registration — and then the resumed `unregister()` fired a SECOND native
 * attempt against it.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
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
    addEventListener: (_t: string, h: () => void) => handlers.add(h),
    removeEventListener: (_t: string, h: () => void) => handlers.delete(h),
    update: vi.fn(async () => {}),
    unregister: vi.fn(async () => unregisterResult),
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

describe("serviceWorker — pending unregister is coalesced", () => {
  it("issues exactly one native unregister when the pending attempt returns false", async () => {
    const reg = fakeRegistration(false);
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
    const result = await pending;
    await flush();

    // ONE logical request → ONE native attempt.
    expect(reg.unregister).toHaveBeenCalledTimes(1);
    expect(result).toBe(false);

    // The browser still has the worker, so the wrapper must have adopted it.
    expect(sw.registration()).toBe(reg as unknown as ServiceWorkerRegistration);
    expect(sw.isReady()).toBe(true);
  });

  it("keeps listeners operational after a refused pending unregister", async () => {
    const reg = fakeRegistration(false);
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

    expect(reg.listenerCount()).toBe(1);

    const worker = fakeWorker("installed");
    reg.installing = worker;
    reg.fireUpdateFound();
    worker.fire();
    expect(sw.isUpdateAvailable()).toBe(true);

    await sw.update();
    expect(reg.update).toHaveBeenCalledTimes(1);
  });

  it("shares one native attempt between two concurrent pending unregister callers", async () => {
    const reg = fakeRegistration(false);
    let resolveRegistration!: (r: unknown) => void;
    installNavigator(
      () =>
        new Promise((res) => {
          resolveRegistration = res;
        }),
    );

    const sw = serviceWorker("/sw.js");
    const a = sw.unregister();
    const b = sw.unregister();

    resolveRegistration(reg);
    await flush();
    const [ra, rb] = await Promise.all([a, b]);
    await flush();

    expect(reg.unregister).toHaveBeenCalledTimes(1);
    expect(ra).toBe(false);
    expect(rb).toBe(false);
  });

  it("shares one native attempt between concurrent callers on an active registration", async () => {
    const reg = fakeRegistration(true);
    installNavigator(async () => reg);

    const sw = serviceWorker("/sw.js");
    await flush();

    const [a, b] = await Promise.all([sw.unregister(), sw.unregister()]);

    expect(reg.unregister).toHaveBeenCalledTimes(1);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(sw.registration()).toBeNull();
  });

  it("still reaches the terminal state when a pending unregister succeeds", async () => {
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

    expect(await pending).toBe(true);
    expect(reg.unregister).toHaveBeenCalledTimes(1);
    expect(sw.registration()).toBeNull();
    expect(sw.isReady()).toBe(false);
  });

  it("remains idempotent after a successful removal", async () => {
    const reg = fakeRegistration(true);
    installNavigator(async () => reg);

    const sw = serviceWorker("/sw.js");
    await flush();

    expect(await sw.unregister()).toBe(true);
    expect(await sw.unregister()).toBe(false);
    expect(reg.unregister).toHaveBeenCalledTimes(1);
  });

  it("allows a later unregister attempt after one was refused", async () => {
    let result = false;
    const reg = {
      addEventListener: () => {},
      removeEventListener: () => {},
      update: vi.fn(async () => {}),
      unregister: vi.fn(async () => result),
    };
    installNavigator(async () => reg);

    const sw = serviceWorker("/sw.js");
    await flush();

    expect(await sw.unregister()).toBe(false);
    expect(reg.unregister).toHaveBeenCalledTimes(1);

    // The browser changed its mind; a fresh request is a fresh operation.
    result = true;
    expect(await sw.unregister()).toBe(true);
    expect(reg.unregister).toHaveBeenCalledTimes(2);
    expect(sw.isReady()).toBe(false);
  });

  it("stays inert without navigator (SSR)", async () => {
    Object.defineProperty(globalThis, "navigator", { value: undefined, configurable: true, writable: true });
    const sw = serviceWorker("/sw.js");
    expect(sw.registration()).toBeNull();
    expect(await sw.unregister()).toBe(false);
  });
});
