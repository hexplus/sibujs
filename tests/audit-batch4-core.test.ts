import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetIdCounter, createId } from "../src/core/rendering/createId";
import { getSlot, type Slots } from "../src/core/rendering/slots";
import { runInSSRContext } from "../src/core/ssr-context";
import { timeline } from "../src/patterns/timeTravel";
import { createModuleRegistry } from "../src/plugins/modular";
import { createNavigation, destroyRouter } from "./helpers/audit-batch4-router";

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 48. createId() is request-scoped during SSR.
//
// THE DEFECT: the suspense counter lived on the request store, but createId()
// always incremented one process-global counter, so a server render's ids
// depended on prior (and concurrent) traffic and diverged from a fresh client.
// ---------------------------------------------------------------------------
describe("createId() under SSR", () => {
  afterEach(() => __resetIdCounter());

  it("independent requests each start from the same sequence", () => {
    __resetIdCounter();
    createId("warmup");
    const first = runInSSRContext(() => [createId("field"), createId("field")]);
    const second = runInSSRContext(() => [createId("field"), createId("field")]);

    expect(first).toEqual(["field-1", "field-2"]);
    expect(second).toEqual(["field-1", "field-2"]);
  });

  it("matches a fresh client sequence", () => {
    const server = runInSSRContext(() => [createId(), createId("label"), createId()]);
    __resetIdCounter();
    const client = [createId(), createId("label"), createId()];
    expect(server).toEqual(client);
  });

  it("concurrent requests do not interleave", async () => {
    const tick = () => new Promise((r) => setTimeout(r, 1));
    const render = () =>
      runInSSRContext(async () => {
        const ids: string[] = [];
        for (let i = 0; i < 4; i++) {
          ids.push(createId("row"));
          await tick();
        }
        return ids;
      });

    const [a, b] = await Promise.all([render(), render()]);
    expect(a).toEqual(["row-1", "row-2", "row-3", "row-4"]);
    expect(b).toEqual(["row-1", "row-2", "row-3", "row-4"]);
  });

  it("a nested context has its own sequence and the outer one continues", () => {
    const result = runInSSRContext(() => {
      const outer1 = createId();
      const inner = runInSSRContext(() => [createId(), createId()]);
      const outer2 = createId();
      return { outer1, inner, outer2 };
    });
    expect(result).toEqual({ outer1: "sibu-1", inner: ["sibu-1", "sibu-2"], outer2: "sibu-2" });
  });

  it("does not advance the shared client counter", () => {
    __resetIdCounter();
    runInSSRContext(() => createId());
    expect(createId()).toBe("sibu-1");
  });
});

// ---------------------------------------------------------------------------
// 49. Module factories cannot bypass circular-resolution detection.
//
// THE DEFECT: a module left the resolution stack before its factory ran, and a
// factory calling resolve() started a fresh stack — so a factory cycle recursed
// until a RangeError instead of throwing the documented circular-dependency
// error.
// ---------------------------------------------------------------------------
describe("module registry factory cycles", () => {
  it("a factory resolving itself throws a circular dependency error", () => {
    const registry = createModuleRegistry();
    const factory = vi.fn(() => registry.resolve("self"));
    registry.register("self", factory);

    expect(() => registry.resolve("self")).toThrow(/Circular dependency detected/);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("an indirect factory cycle throws", () => {
    const registry = createModuleRegistry();
    registry.register("a", () => registry.resolve("b"));
    registry.register("b", () => registry.resolve("a"));

    expect(() => registry.resolve("a")).toThrow(/Circular dependency detected: a -> b -> a/);
  });

  it("a cycle through a dependency's factory throws", () => {
    const registry = createModuleRegistry();
    registry.register("root", () => "root", ["dep"]);
    registry.register("dep", () => registry.resolve("root"));

    expect(() => registry.resolve("root")).toThrow(/Circular dependency detected/);
  });

  it("a throwing factory can be retried", () => {
    const registry = createModuleRegistry();
    let fail = true;
    const factory = vi.fn(() => {
      if (fail) throw new Error("not ready");
      return 42;
    });
    registry.register("flaky", factory);

    expect(() => registry.resolve("flaky")).toThrow("not ready");
    fail = false;
    expect(registry.resolve("flaky")).toBe(42);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("a failed cycle leaves every involved module retryable", () => {
    const registry = createModuleRegistry();
    let cyclic = true;
    registry.register("a", () => (cyclic ? registry.resolve("b") : "a"));
    registry.register("b", () => registry.resolve("a"));

    expect(() => registry.resolve("a")).toThrow(/Circular/);
    cyclic = false;
    expect(registry.resolve("b")).toBe("a");
  });

  it("a successful factory still runs once, including one resolving other modules", () => {
    const registry = createModuleRegistry();
    const leaf = vi.fn(() => "leaf");
    const branch = vi.fn(() => `${registry.resolve("leaf")}+branch`);
    registry.register("leaf", leaf);
    registry.register("branch", branch);

    expect(registry.resolve("branch")).toBe("leaf+branch");
    expect(registry.resolve("branch")).toBe("leaf+branch");
    expect(registry.resolve("leaf")).toBe("leaf");
    expect(leaf).toHaveBeenCalledTimes(1);
    expect(branch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 51. Router parsing keeps every `?` and `#` after the first delimiter.
// ---------------------------------------------------------------------------
describe("router query/hash parsing", () => {
  afterEach(() => destroyRouter());

  it("keeps raw ? in query values and raw # in the fragment", async () => {
    const nav = createNavigation();
    const r = await nav.go("/callback?redirect=/login?next=home#section#details");
    expect(r.query).toEqual({ redirect: "/login?next=home" });
    expect(r.hash).toBe("section#details");
    expect(r.path).toBe("/callback");
  });

  it("keeps encoded ? and # as well", async () => {
    const nav = createNavigation();
    const r = await nav.go("/callback?redirect=%2Flogin%3Fnext%3Dhome%23top#a%23b");
    expect(r.query).toEqual({ redirect: "/login?next=home#top" });
    expect(r.hash).toBe("a%23b");
  });

  it("a ? inside the fragment belongs to the fragment", async () => {
    const nav = createNavigation();
    const r = await nav.go("/callback#frag?not=query");
    expect(r.query).toEqual({});
    expect(r.hash).toBe("frag?not=query");
  });

  it("handles empty query and hash", async () => {
    const nav = createNavigation();
    const r = await nav.go("/callback?#");
    expect(r.path).toBe("/callback");
    expect(r.query).toEqual({});
    expect(r.hash).toBe("");
  });

  it("string and object navigation agree", async () => {
    const nav = createNavigation();
    const fromString = await nav.go("/callback?redirect=%2Flogin%3Fnext%3Dhome#section#details");
    const fromObject = await nav.go({
      path: "/callback",
      query: { redirect: "/login?next=home" },
      hash: "section#details",
    });
    expect(fromObject.query).toEqual(fromString.query);
    expect(fromObject.hash).toBe(fromString.hash);
  });
});

// ---------------------------------------------------------------------------
// 54. getSlot() never returns inherited prototype members.
// ---------------------------------------------------------------------------
describe("getSlot() own slots only", () => {
  for (const name of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
    it(`a missing ${JSON.stringify(name)} slot is undefined`, () => {
      expect(getSlot({}, name)).toBeUndefined();
    });

    it(`an explicitly supplied ${JSON.stringify(name)} slot is returned`, () => {
      const fn = () => `slot ${name}`;
      const slots = Object.defineProperty({}, name, { value: fn, enumerable: true }) as Slots;
      expect(getSlot(slots, name)).toBe(fn);
    });
  }

  it("works with a null-prototype slot map", () => {
    const fn = () => "x";
    const slots = Object.assign(Object.create(null), { header: fn }) as Slots;
    expect(getSlot(slots, "header")).toBe(fn);
    expect(getSlot(slots, "toString")).toBeUndefined();
  });

  it("ignores own non-function values so fallback rendering applies", () => {
    const slots = { default: "not a function" } as unknown as Slots;
    expect(getSlot(slots)).toBeUndefined();
    const rendered = getSlot(slots)?.() ?? "fallback";
    expect(rendered).toBe("fallback");
  });
});

// ---------------------------------------------------------------------------
// 55. timeline() rejects history capacities that would corrupt its state.
// ---------------------------------------------------------------------------
describe("timeline() capacity", () => {
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    it(`rejects maxHistory ${bad}`, () => {
      expect(() => timeline(0, bad)).toThrow(RangeError);
    });
  }

  it("capacity one keeps only the current value", () => {
    const h = timeline(0, 1);
    h.set(1);
    h.set(2);
    expect(h.history()).toEqual([2]);
    expect(h.index()).toBe(0);
    expect(h.value()).toBe(2);
    expect(h.canUndo()).toBe(false);
    h.undo();
    expect(h.value()).toBe(2);
    h.dispose();
  });

  it("repeated eviction keeps the index and undo/redo consistent", () => {
    const h = timeline(0, 3);
    for (let i = 1; i <= 10; i++) h.set(i);
    expect(h.history()).toEqual([8, 9, 10]);
    expect(h.index()).toBe(2);

    h.undo();
    h.undo();
    expect(h.value()).toBe(8);
    expect(h.canUndo()).toBe(false);
    h.redo();
    expect(h.value()).toBe(9);

    h.set(99);
    expect(h.history()).toEqual([8, 9, 99]);
    expect(h.canRedo()).toBe(false);
    h.dispose();
  });
});
