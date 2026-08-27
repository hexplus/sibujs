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

    await expect(sw.unregister()).rejects.toThrow("native unregister failed");

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
    const pending = sw.unregister();

    resolveRegistration(reg);
    await flush();

    await expect(pending).rejects.toThrow("native unregister failed");
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
    const pending = sw.unregister();
    resolveRegistration(reg);
    await flush();
    await expect(pending).rejects.toThrow();
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

    const a = sw.unregister();
    const b = sw.unregister();

    await expect(a).rejects.toThrow("native unregister failed");
    await expect(b).rejects.toThrow("native unregister failed");

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

    await expect(sw.unregister()).rejects.toThrow("native unregister failed");
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
    const outcome = await sw.unregister().then(
      (v) => ({ kind: "resolved" as const, v }),
      (e) => ({ kind: "rejected" as const, e }),
    );
    expect(outcome.kind).toBe("rejected");
  });
});
