import { describe, expect, it } from "vitest";
import { createSlots } from "../src/patterns/composable";
import { validators } from "../src/patterns/contracts";
import { machine } from "../src/patterns/machine";
import { optimisticList } from "../src/patterns/optimistic";
import { timeline } from "../src/patterns/timeTravel";

describe("machine entry actions + can() guards", () => {
  it("runs entry actions on transition and evaluates can() across transition shapes", () => {
    const calls: string[] = [];
    const m = machine<"idle" | "active" | "done", "GO" | "STOP" | "FINISH" | "NOPE", { allow: boolean }>({
      initial: "idle",
      context: { allow: true },
      states: {
        idle: {
          on: {
            GO: { target: "active", guard: (c) => c.allow }, // guarded object transition
            FINISH: "done", // string transition
          },
          entry: () => calls.push("idle-entry"),
        },
        active: {
          on: { STOP: { target: "idle" } }, // object transition, no guard
          entry: () => calls.push("active-entry"),
        },
        done: {},
      },
    });

    expect(calls).toEqual(["idle-entry"]); // initial entry
    expect(m.matches("idle")).toBe(true);

    m.send("GO"); // → active; runs active entry action
    expect(calls).toContain("active-entry");
    expect(m.matches("active")).toBe(true);

    expect(m.can("STOP")).toBe(true); // object transition without guard → true
    expect(m.can("NOPE")).toBe(false); // no such transition → false

    m.send("STOP"); // back to idle
    expect(m.can("GO")).toBe(true); // guarded transition → guard(context) === true
    expect(m.can("FINISH")).toBe(true); // string transition → true
  });
});

describe("createSlots array result", () => {
  it("wraps an array slot in a display:contents fragment and honours fallback", () => {
    const slots = createSlots({
      multi: () => [document.createElement("a"), document.createElement("b")],
      single: () => document.createElement("section"),
    });

    const frag = slots.renderSlot("multi") as HTMLElement;
    expect(frag.style.display).toBe("contents");
    expect(frag.children.length).toBe(2);

    expect((slots.renderSlot("single") as HTMLElement).tagName).toBe("SECTION");
    expect((slots.renderSlot("missing", () => document.createElement("u")) as HTMLElement).tagName).toBe("U");
    expect(slots.renderSlot("missing")).toBeNull();

    expect(slots.hasSlot("multi")).toBe(true);
    expect(slots.hasSlot("toString")).toBe(false); // own-key only
  });
});

describe("contracts validators", () => {
  it("covers function / object / instanceOf / arrayOf validators", () => {
    expect(validators.function(() => {}, "f")).toBe(true);
    expect(validators.function(1, "f")).toContain("must be a function");

    expect(validators.object({}, "o")).toBe(true);
    expect(validators.object(null, "o")).toContain("must be an object");

    expect(validators.array([], "a")).toBe(true);
    expect(validators.array(1, "a")).toContain("must be an array");

    const isDate = validators.instanceOf(Date);
    expect(isDate(new Date(), "d")).toBe(true);
    expect(isDate({}, "d")).toContain("must be an instance of Date");

    const nums = validators.arrayOf(validators.number);
    expect(nums([1, 2, 3], "a")).toBe(true);
    expect(nums("x", "a")).toContain("must be an array");
  });
});

describe("timeline maxHistory eviction", () => {
  it("shifts the oldest entry once history exceeds maxHistory", () => {
    const t = timeline(0, 3);
    t.set(1);
    t.set(2);
    t.set(3); // history would be [0,1,2,3] (len 4 > 3) → shift oldest
    expect(t.value()).toBe(3);
    expect(t.history()[0]).toBe(1); // 0 evicted
    expect(t.history().length).toBe(3);
  });
});

describe("optimisticList add — success, failure, and primitive ids", () => {
  it("applies the resolved value on success and reverts on failure", async () => {
    const list = optimisticList<{ id: number; done?: boolean }>([]);
    await list.add({ id: 1 }, async () => ({ id: 1, done: true }));
    expect(list.items().some((i) => i.done)).toBe(true);

    const before = list.items().length;
    await list.add({ id: 2 }, async () => {
      throw new Error("server-fail");
    });
    // optimistic item rolled back → length returns to `before`
    expect(list.items().length).toBe(before);
    expect(list.pending()).toBe(false);
  });

  it("handles a primitive-valued list (findIndexById Object.is fallback)", async () => {
    const list = optimisticList<number>([]);
    await list.add(10, async () => 11);
    expect(list.items()).toContain(11);
  });
});
