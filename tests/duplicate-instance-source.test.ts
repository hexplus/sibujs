import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// ---------------------------------------------------------------------------
// Covers the duplicate-instance DETECTION path on the real source modules.
//
// `tests/duplicate-instance.test.ts` proves cross-instance behavior by bundling
// the core and evaluating it twice — but that runs a bundled copy, so coverage
// instrumentation never credits the source module's "a duplicate loaded" branch
// (the in-process module evaluates exactly once, always taking the first-copy
// path). Here we exercise that branch directly: pre-seed the `globalThis`
// registry as if a first copy had already published its API, then freshly
// import the source module so its resolver takes the duplicate path.
// ---------------------------------------------------------------------------

const REACTIVE_KEY = Symbol.for("sibujs.reactive.v1");
const BATCH_KEY = Symbol.for("sibujs.reactive.batch.v1");

type Registry = Record<symbol, unknown>;

describe("duplicate-instance detection on the source modules", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    delete (globalThis as Registry)[REACTIVE_KEY];
    delete (globalThis as Registry)[BATCH_KEY];
    vi.restoreAllMocks();
  });

  test("track.ts delegates to the first copy and dev-warns once on a duplicate load", async () => {
    // Simulate a first copy of the reactive runtime having published its API.
    (globalThis as Registry)[REACTIVE_KEY] = { version: "0.0.0-first", __dupWarned: false };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await import("../src/reactivity/track");

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("Multiple instances of the reactive runtime");
    // The registry object is stamped so a third copy stays quiet.
    expect((globalThis as Record<symbol, { __dupWarned?: boolean }>)[REACTIVE_KEY].__dupWarned).toBe(true);
  });

  test("track.ts does not warn again when the first copy already warned", async () => {
    (globalThis as Registry)[REACTIVE_KEY] = { version: "0.0.0-first", __dupWarned: true };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await import("../src/reactivity/track");

    expect(warn).not.toHaveBeenCalled();
  });

  test("batch.ts re-exports the first copy's functions on a duplicate load", async () => {
    const firstBatch = {
      batch: <T>(fn: () => T): T => fn(),
      enqueueBatchedSignal: () => false,
      isBatching: () => false,
    };
    (globalThis as Registry)[BATCH_KEY] = firstBatch;

    const mod = await import("../src/reactivity/batch");

    // The duplicate copy delegates to the first copy's functions verbatim.
    expect(mod.batch).toBe(firstBatch.batch);
    expect(mod.isBatching).toBe(firstBatch.isBatching);
    expect(mod.enqueueBatchedSignal).toBe(firstBatch.enqueueBatchedSignal);
  });
});
