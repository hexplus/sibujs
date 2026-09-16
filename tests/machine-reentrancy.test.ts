import { describe, expect, it } from "vitest";
import { effect } from "../src/core/signals/effect";
import { machine } from "../src/patterns/machine";

// ---------------------------------------------------------------------------
// machine.send() is run-to-completion.
//
// THE DEFECT: exit hooks and transition actions ran before the outer transition
// committed its state. A nested send() from an action, a hook, or a subscriber
// woken by setContext() therefore saw the OLD state: its transition was
// overwritten when the outer one finished, and exit hooks could run twice for
// the same logical state. Context and state were also published separately, so
// subscribers could observe the new context paired with the old state.
// ---------------------------------------------------------------------------

type S = "a" | "b" | "c" | "d";
type E = "GO" | "NEXT" | "LAST";

describe("machine run-to-completion", () => {
  it("a send() from a transition action runs after the outer transition commits", () => {
    let service!: ReturnType<typeof machine<S, E, { n: number }>>;
    service = machine<S, E, { n: number }>({
      initial: "a",
      context: { n: 0 },
      states: {
        a: {
          on: {
            GO: {
              target: "b",
              action: (ctx) => {
                service.send("NEXT");
                return { n: ctx.n + 1 };
              },
            },
            NEXT: "d",
          },
        },
        b: { on: { NEXT: "c" } },
        c: {},
        d: {},
      },
    });

    service.send("GO");

    expect(service.state()).toBe("c");
    expect(service.context().n).toBe(1);
  });

  it("a send() from an exit hook is queued and the exit hook runs once", () => {
    const exits: string[] = [];
    let service!: ReturnType<typeof machine<S, E>>;
    service = machine<S, E>({
      initial: "a",
      states: {
        a: {
          on: { GO: "b", NEXT: "d" },
          exit: () => {
            exits.push("a");
            service.send("NEXT");
          },
        },
        b: { on: { NEXT: "c" }, exit: () => exits.push("b") },
        c: {},
        d: {},
      },
    });

    service.send("GO");

    expect(service.state()).toBe("c");
    expect(exits).toEqual(["a", "b"]);
  });

  it("a send() from an entry hook runs after the entry completes", () => {
    const log: string[] = [];
    let service!: ReturnType<typeof machine<S, E>>;
    service = machine<S, E>({
      initial: "a",
      states: {
        a: { on: { GO: "b" } },
        b: {
          on: { NEXT: "c" },
          entry: () => {
            service.send("NEXT");
            log.push(`entry b, state=${service.state()}`);
          },
        },
        c: { entry: () => log.push("entry c") },
        d: {},
      },
    });

    service.send("GO");

    expect(service.state()).toBe("c");
    expect(log).toEqual(["entry b, state=b", "entry c"]);
  });

  it("a send() from a reactive subscriber is not overwritten", () => {
    const service = machine<S, E, { n: number }>({
      initial: "a",
      context: { n: 0 },
      states: {
        // NEXT is also valid in "a": a subscriber that ran before the state
        // committed would take it from the stale state instead of from "b".
        a: { on: { GO: { target: "b", action: (ctx) => ({ n: ctx.n + 1 }) }, NEXT: "d" } },
        b: { on: { NEXT: "c" } },
        c: {},
        d: {},
      },
    });
    let sent = false;
    const stop = effect(() => {
      if (service.context().n === 1 && !sent) {
        sent = true;
        service.send("NEXT");
      }
    });

    service.send("GO");

    expect(service.state()).toBe("c");
    stop();
  });

  it("processes nested events in FIFO order", () => {
    const visited: string[] = [];
    let service!: ReturnType<typeof machine<S, E>>;
    service = machine<S, E>({
      initial: "a",
      states: {
        a: {
          on: {
            GO: {
              target: "b",
              action: () => {
                service.send("NEXT");
                service.send("LAST");
                return {};
              },
            },
          },
        },
        b: { on: { NEXT: "c" }, entry: () => visited.push("b") },
        c: { on: { LAST: "d" }, entry: () => visited.push("c") },
        d: { entry: () => visited.push("d") },
      },
    });

    service.send("GO");

    expect(visited).toEqual(["b", "c", "d"]);
    expect(service.state()).toBe("d");
  });

  it("publishes context and state atomically", () => {
    const service = machine<S, E, { label: string }>({
      initial: "a",
      context: { label: "in-a" },
      states: {
        a: { on: { GO: { target: "b", action: () => ({ label: "in-b" }) } } },
        b: {},
        c: {},
        d: {},
      },
    });
    const seen: string[] = [];
    const stop = effect(() => {
      seen.push(`${service.state()}/${service.context().label}`);
    });
    seen.length = 0;

    service.send("GO");

    expect(seen).toEqual(["b/in-b"]);
    stop();
  });

  it("a throwing action resets the processing guard and drops queued events", () => {
    let explode = true;
    let service!: ReturnType<typeof machine<S, E>>;
    service = machine<S, E>({
      initial: "a",
      states: {
        a: {
          on: {
            GO: {
              target: "b",
              action: () => {
                if (explode) {
                  service.send("NEXT");
                  throw new Error("action failed");
                }
                return {};
              },
            },
            NEXT: "d",
          },
        },
        b: { on: { NEXT: "c" } },
        c: {},
        d: {},
      },
    });

    expect(() => service.send("GO")).toThrow("action failed");
    expect(service.state()).toBe("a");

    explode = false;
    service.send("GO");
    expect(service.state()).toBe("b");
    service.send("NEXT");
    expect(service.state()).toBe("c");
  });
});
