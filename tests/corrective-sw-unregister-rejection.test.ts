/**
 * A native `registration.unregister()` REJECTION is not evidence of removal.
 *
 * A `false` return means "the browser declined" and the wrapper already
 * recovers from it. A rejection means the attempt did not complete at all — so
 * the worker is, as far as anyone knows, still installed and still controlling
 * pages. Propagating the failure while leaving the wrapper detached is the worst
 * of both: the caller sees an error AND SibuJS has forgotten the registration it
 * was supposed to be managing.
 *
 * Ownership must revert to an active registration BEFORE the rejection
 * propagates. The rejection itself is preserved — it is real information, and
 * silently converting it to `false` would claim the browser answered when it
 * did not.
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

/** `unregisterImpl` decides success / refusal / rejection per call. */
function fakeRegistration(unregisterImpl: () => Promise<boolean>) {
  const handlers = new Set<() => void>();
  const reg = {
    installing: null as FakeWorker | null,
    addEventListener: (_t: string, h: () => void) => handlers.add(h),
    removeEventListener: (_t: string, h: () => void) => handlers.delete(h),
    update: vi.fn(async () => {}),
    unregister: vi.fn(() => unregisterImpl()),
    fireUpdateFound: () => {
      for (const h of handlers) h();
    },
    listenerCount: () => handlers.size,
  };
  return reg;
}

const originalNavigator = globalThis.navigator;
const flush = () => new Promise((r) => setTimeout(r, 0));

/**
 * Capture a promise's outcome with handlers attached SYNCHRONOUSLY.
 *
 * `const p = sw.unregister(); await flush(); await expect(p).rejects...` looks
 * equivalent but is not: `p` rejects during the flush with nothing attached, so
 * the runtime reports an unhandled rejection before the assertion ever runs.
 * Attaching at creation closes that window — which is the same discipline the
 * framework code under test is being held to.
 */
function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
}

function expectRejection(outcome: { ok: boolean; error?: unknown }, message: string): void {
  expect(outcome.ok, "expected the unregister to reject").toBe(false);
  expect((outcome.error as Error).message).toBe(message);
}

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

describe("serviceWorker — native unregister rejection", () => {
  it("keeps an ACTIVE registration usable when unregister rejects", async () => {
    const reg = fakeRegistration(async () => {
      throw new Error("native unregister failed");
    });
    installNavigator(async () => reg);

    const sw = serviceWorker("/sw.js");
    await flush();

    expectRejection(await settle(sw.unregister()), "native unregister failed");

    // No evidence the worker was removed, so the wrapper must still own it.
    expect(sw.registration()).toBe(reg as unknown as ServiceWorkerRegistration);
    expect(sw.isReady()).toBe(true);
    expect(reg.listenerCount()).toBe(1);
  });

  it("re-adopts a PENDING registration when unregister rejects", async () => {
    const reg = fakeRegistration(async () => {
      throw new Error("native unregister failed");
    });
    let resolveRegistration!: (r: unknown) => void;
    installNavigator(
      () =>
        new Promise((res) => {
          resolveRegistration = res;
        }),
    );

    const sw = serviceWorker("/sw.js");
    const pending = settle(sw.unregister());

    resolveRegistration(reg);
    await flush();

    expectRejection(await pending, "native unregister failed");
    await flush();

    // The registration arrived and was withheld pending removal; removal failed,
    // so it must be activated rather than dropped on the floor.
    expect(sw.registration()).toBe(reg as unknown as ServiceWorkerRegistration);
    expect(sw.isReady()).toBe(true);
    expect(reg.unregister).toHaveBeenCalledTimes(1);
  });

  it("keeps update tracking alive after a rejected unregister", async () => {
    const reg = fakeRegistration(async () => {
      throw new Error("native unregister failed");
    });
    let resolveRegistration!: (r: unknown) => void;
    installNavigator(
      () =>
        new Promise((res) => {
          resolveRegistration = res;
        }),
    );

    const sw = serviceWorker("/sw.js");
    const pending = settle(sw.unregister());
    resolveRegistration(reg);
    await flush();
    expectRejection(await pending, "native unregister failed");
    await flush();

    const worker = fakeWorker("installed");
    reg.installing = worker;
    reg.fireUpdateFound();
    worker.fire();
    expect(sw.isUpdateAvailable()).toBe(true);

    await sw.update();
    expect(reg.update).toHaveBeenCalledTimes(1);
  });

  it("shares one native attempt between concurrent callers when it rejects", async () => {
    const reg = fakeRegistration(async () => {
      throw new Error("native unregister failed");
    });
    installNavigator(async () => reg);

    const sw = serviceWorker("/sw.js");
    await flush();

    // Both handlers attached before either can settle.
    const a = settle(sw.unregister());
    const b = settle(sw.unregister());

    expectRejection(await a, "native unregister failed");
    expectRejection(await b, "native unregister failed");

    expect(reg.unregister).toHaveBeenCalledTimes(1);
    expect(sw.registration()).toBe(reg as unknown as ServiceWorkerRegistration);
    expect(sw.isReady()).toBe(true);
  });

  it("allows a later retry to succeed after a rejection", async () => {
    let attempt = 0;
    const reg = fakeRegistration(async () => {
      attempt++;
      if (attempt === 1) throw new Error("native unregister failed");
      return true;
    });
    installNavigator(async () => reg);

    const sw = serviceWorker("/sw.js");
    await flush();

    expectRejection(await settle(sw.unregister()), "native unregister failed");
    expect(sw.isReady()).toBe(true);

    await expect(sw.unregister()).resolves.toBe(true);
    expect(reg.unregister).toHaveBeenCalledTimes(2);
    expect(sw.registration()).toBeNull();
    expect(sw.isReady()).toBe(false);
  });

  it("does not convert a rejection into a false result", async () => {
    const reg = fakeRegistration(async () => {
      throw new Error("native unregister failed");
    });
    installNavigator(async () => reg);

    const sw = serviceWorker("/sw.js");
    await flush();

    // The caller asked the browser a question and got an error, not an answer.
    // Reporting `false` would claim the browser declined, which it never said.
    const outcome = await settle(sw.unregister());
    expect(outcome.ok).toBe(false);
  });
});
