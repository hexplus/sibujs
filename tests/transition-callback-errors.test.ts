import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../src/components/ErrorBoundary";
import { type RuntimeErrorContext, setRuntimeErrorHandler } from "../src/core/errors";
import { div } from "../src/core/rendering/html";
import { transition } from "../src/ui/transition";

// ---------------------------------------------------------------------------
// A throwing onEnterDone / onLeaveDone must not hang the transition promise.
//
// THE DEFECT: `done()` called the application callback and then `resolve()`.
// A throw skipped `resolve()`. With a timed transition the exception escaped
// from `setTimeout`, bypassing ErrorBoundary and the runtime handler, and
// `await enter()` hung forever; with `duration: 0` the promise rejected instead.
// ---------------------------------------------------------------------------

type Kind = "enter" | "leave";
const KINDS: Kind[] = ["enter", "leave"];
const DURATIONS = [0, 200];

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  vi.useRealTimers();
  setRuntimeErrorHandler(null);
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function build(kind: Kind, duration: number, boom: Error) {
  const el = document.createElement("div");
  const throwing = () => {
    throw boom;
  };
  const t = transition(el, {
    duration,
    enterClass: "in",
    leaveClass: "out",
    activeClass: "active",
    ...(kind === "enter" ? { onEnterDone: throwing } : { onLeaveDone: throwing }),
  });
  return { el, run: () => t[kind](), other: () => t[kind === "enter" ? "leave" : "enter"]() };
}

async function settle(promise: Promise<void>, duration: number): Promise<"resolved" | "rejected"> {
  if (duration > 0) vi.advanceTimersByTime(duration);
  return promise.then(
    () => "resolved" as const,
    () => "rejected" as const,
  );
}

for (const kind of KINDS) {
  for (const duration of DURATIONS) {
    describe(`${kind}() with a throwing callback, duration ${duration}`, () => {
      it("resolves, reports once to the runtime handler, and cleans up", async () => {
        const reports: Array<{ error: unknown; context: RuntimeErrorContext }> = [];
        setRuntimeErrorHandler((error, context) => reports.push({ error, context }));
        const boom = new Error(`${kind} callback failed`);
        const { el, run } = build(kind, duration, boom);

        const outcome = await settle(run(), duration);

        expect(outcome).toBe("resolved");
        expect(reports).toHaveLength(1);
        expect(reports[0].error).toBe(boom);
        expect(reports[0].context.phase).toBe("async");
        expect(reports[0].context.node).toBe(el);
        expect(el.classList.contains(kind === "enter" ? "in" : "out")).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
      });

      it("leaves the controller usable for the next transition", async () => {
        setRuntimeErrorHandler(() => {});
        const { el, run, other } = build(kind, duration, new Error("first"));
        await settle(run(), duration);

        const outcome = await settle(other(), duration);

        expect(outcome).toBe("resolved");
        expect(el.classList.contains("in")).toBe(false);
        expect(el.classList.contains("out")).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
      });

      it("is claimed by the enclosing ErrorBoundary instead of the runtime handler", async () => {
        const handler = vi.fn();
        setRuntimeErrorHandler(handler);
        vi.spyOn(console, "error").mockImplementation(() => {});

        let start: () => Promise<void> = async () => {};
        const boundary = ErrorBoundary({ fallback: () => div({ class: "boundary-fallback" }, "caught") }, () => {
          const built = build(kind, duration, new Error("inside boundary"));
          start = built.run;
          return built.el;
        });
        const host = document.createElement("div");
        document.body.appendChild(host);
        host.appendChild(boundary);
        await vi.advanceTimersByTimeAsync(0);

        const outcome = await settle(start(), duration);
        await vi.advanceTimersByTimeAsync(0);

        expect(outcome).toBe("resolved");
        expect(host.querySelector(".boundary-fallback")?.textContent).toBe("caught");
        expect(handler).not.toHaveBeenCalled();
      });
    });
  }
}
