import { describe, expect, it } from "vitest";
import { machine } from "../src/patterns/machine";

describe("machine", () => {
  it("should initialize with initial state", () => {
    const { state } = machine({
      initial: "idle",
      states: {
        idle: { on: { START: "running" } },
        running: { on: { STOP: "idle" } },
      },
    });

    expect(state()).toBe("idle");
  });

  it("should transition on events", () => {
    const { state, send } = machine({
      initial: "idle",
      states: {
        idle: { on: { START: "running" } },
        running: { on: { STOP: "idle" } },
      },
    });

    send("START");
    expect(state()).toBe("running");

    send("STOP");
    expect(state()).toBe("idle");
  });

  it("should check if matches state", () => {
    const { matches, send } = machine({
      initial: "idle",
      states: {
        idle: { on: { START: "running" } },
        running: { on: { STOP: "idle" } },
      },
    });

    expect(matches("idle")).toBe(true);
    expect(matches("running")).toBe(false);

    send("START");
    expect(matches("running")).toBe(true);
  });

  it("should check if can transition", () => {
    const { can } = machine({
      initial: "idle",
      states: {
        idle: { on: { START: "running" } },
        running: { on: { STOP: "idle" } },
      },
    });

    expect(can("START")).toBe(true);
    expect(can("STOP")).toBe(false);
  });

  it("should support guards", () => {
    const { state, send, context } = machine({
      initial: "idle",
      context: { attempts: 0 },
      states: {
        idle: {
          on: {
            START: {
              target: "running",
              guard: (ctx) => ctx.attempts < 3,
              action: (ctx) => ({ attempts: ctx.attempts + 1 }),
            },
          },
        },
        running: { on: { STOP: "idle" } },
      },
    });

    send("START");
    expect(state()).toBe("running");
    expect(context().attempts).toBe(1);
  });

  it("should reject transition when guard fails", () => {
    const { state, send } = machine({
      initial: "idle",
      context: { attempts: 3 },
      states: {
        idle: {
          on: {
            START: {
              target: "running",
              guard: (ctx) => ctx.attempts < 3,
            },
          },
        },
        running: { on: { STOP: "idle" } },
      },
    });

    send("START");
    expect(state()).toBe("idle"); // Guard rejected
  });
});
