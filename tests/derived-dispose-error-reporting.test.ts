import { afterAll, afterEach, describe, expect, it } from "vitest";
import { type RuntimeErrorContext, setRuntimeErrorHandler } from "../src/core/errors";
import { type DerivedAccessor, derived } from "../src/core/signals/derived";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";
import { getSubscriberCount } from "../src/devtools/introspect";

// A getter that disposes its own derived and then throws must not lose the
// exception: once disposed, no later read can recompute and rethrow it, so the
// failing run itself is the only place it can surface.

const reports: Array<{ error: unknown; context: RuntimeErrorContext }> = [];
const previousHandler = setRuntimeErrorHandler((error, context) => reports.push({ error, context }));

afterEach(() => {
  reports.length = 0;
});

afterAll(() => {
  setRuntimeErrorHandler(previousHandler);
});

function selfDisposingThrower(name?: string) {
  const [source, setSource] = signal(1);
  let armed = false;
  let runs = 0;
  const boom = new Error("boom");
  const value: DerivedAccessor<number> = derived(
    () => {
      runs++;
      const next = source();
      if (armed) {
        value.dispose();
        throw boom;
      }
      return next;
    },
    name ? { name } : undefined,
  );
  return {
    source,
    setSource,
    value,
    boom,
    runs: () => runs,
    arm: () => {
      armed = true;
    },
  };
}

describe("a derived that disposes itself and then throws", () => {
  it("reports the exception once with phase 'derived' when validated for a downstream effect", () => {
    const t = selfDisposingThrower("total");
    let effectRuns = 0;
    const seen: number[] = [];
    const stop = effect(() => {
      effectRuns++;
      seen.push(t.value());
    });

    t.arm();
    t.setSource(2);

    expect(reports).toHaveLength(1);
    expect(reports[0].error).toBe(t.boom);
    expect(reports[0].context.phase).toBe("derived");
    expect(reports[0].context.name).toBe("total");

    // Frozen at the last settled value; the unchanged value wakes nobody.
    expect(t.value()).toBe(1);
    expect(seen).toEqual([1]);
    expect(effectRuns).toBe(1);

    // Cleanup still happened, and nothing recomputes or reports again.
    expect(getSubscriberCount(t.source)).toBe(0);
    const runsAfter = t.runs();
    t.setSource(3);
    expect(t.value()).toBe(1);
    expect(t.runs()).toBe(runsAfter);
    expect(reports).toHaveLength(1);
    stop();
  });

  it("reports once, without throwing, when the failing recomputation is a direct read", () => {
    const t = selfDisposingThrower();
    t.arm();
    t.setSource(2);

    expect(() => t.value()).not.toThrow();
    expect(reports).toHaveLength(1);
    expect(reports[0].context.phase).toBe("derived");
    expect(t.value()).toBe(1);
    expect(reports).toHaveLength(1);
    expect(getSubscriberCount(t.source)).toBe(0);
  });

  it("reports once, not also as an effect failure, when an effect's own read runs the failing recomputation", () => {
    const t = selfDisposingThrower();
    t.arm();
    t.setSource(2);

    const seen: number[] = [];
    const stop = effect(() => {
      seen.push(t.value());
    });

    expect(reports).toHaveLength(1);
    expect(reports[0].context.phase).toBe("derived");
    expect(seen).toEqual([1]);
    stop();
  });
});

describe("a derived that throws without disposing itself", () => {
  it("still throws to its reader and stays live", () => {
    const [source, setSource] = signal(1);
    let fail = false;
    const value = derived(() => {
      const next = source();
      if (fail) throw new Error("transient");
      return next;
    });
    expect(value()).toBe(1);

    fail = true;
    setSource(2);
    expect(() => value()).toThrow("transient");
    expect(reports).toHaveLength(0);

    fail = false;
    setSource(3);
    expect(value()).toBe(3);
    expect(getSubscriberCount(source)).toBe(1);
    value.dispose();
    expect(getSubscriberCount(source)).toBe(0);
  });
});
