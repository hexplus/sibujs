import { afterEach, describe, expect, it, vi } from "vitest";
import { setRuntimeErrorHandler } from "../../src/core/errors";
import { dispose, registerDisposer } from "../../src/core/rendering/dispose";
import { each } from "../../src/core/rendering/each";
import { Fragment } from "../../src/core/rendering/fragment";
import { div, span } from "../../src/core/rendering/html";
import { KeepAlive } from "../../src/core/rendering/keepAlive";
import { Portal } from "../../src/core/rendering/portal";
import { signal } from "../../src/core/signals/signal";

// Disposal from application code that runs during a commit (a factory, a
// custom element's connected/disconnected callback, an evicted case's
// cleanup) is final: nothing is inserted or kept subscribed after it, and
// what the interrupted commit built is released exactly once.

const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const node of Array.from(document.body.childNodes)) dispose(node);
  document.body.replaceChildren();
  setRuntimeErrorHandler(null);
});

interface Stats {
  runs: number;
  cleanups: number;
}

/** A reactive element with a cleanup, counting both. */
function tracked(label: string, value: () => number, stats: Stats): HTMLElement {
  const el = div(() => {
    stats.runs++;
    return `${label}${value()}`;
  });
  registerDisposer(el, () => stats.cleanups++);
  return el;
}

let tagId = 0;
/** Define a custom element that runs `on` when connected (or disconnected). */
function reactiveTag(kind: "connectedCallback" | "disconnectedCallback", on: () => void): string {
  const tag = `f5-${kind === "connectedCallback" ? "conn" : "disc"}-${++tagId}`;
  customElements.define(
    tag,
    class extends HTMLElement {
      [kind]() {
        on();
      }
    },
  );
  return tag;
}

describe("Portal disposed during its commit", () => {
  it("does not append content after its factory disposed the anchor", async () => {
    const [value, setValue] = signal(0);
    const stats = { runs: 0, cleanups: 0 };
    const target = div();
    document.body.append(target);
    let anchor: Comment | undefined;
    anchor = Portal(() => {
      dispose(anchor as Comment);
      return tracked("orphan", value, stats);
    }, target);
    document.body.append(anchor);
    await tick();
    expect(target.textContent).toBe("");
    expect(stats.cleanups).toBe(1);
    const before = stats.runs;
    setValue(1);
    expect(stats.runs).toBe(before);
    dispose(anchor);
    expect(stats.cleanups).toBe(1);
  });

  it("releases content whose connectedCallback disposed the anchor, once", async () => {
    const [value, setValue] = signal(0);
    const stats = { runs: 0, cleanups: 0 };
    const target = div();
    document.body.append(target);
    let anchor: Comment | undefined;
    const tag = reactiveTag("connectedCallback", () => dispose(anchor as Comment));
    anchor = Portal(() => {
      const el = document.createElement(tag);
      el.append(tracked("x", value, stats));
      return el;
    }, target);
    document.body.append(anchor);
    await tick();
    expect(target.textContent).toBe("");
    expect(stats.cleanups).toBe(1);
    const before = stats.runs;
    setValue(1);
    expect(stats.runs).toBe(before);
  });

  it("rolls back a factory that disposed the anchor and then threw", async () => {
    setRuntimeErrorHandler(() => {});
    const [value, setValue] = signal(0);
    const stats = { runs: 0, cleanups: 0 };
    const target = div();
    document.body.append(target);
    let anchor: Comment | undefined;
    anchor = Portal(() => {
      dispose(anchor as Comment);
      tracked("x", value, stats);
      throw new Error("after dispose");
    }, target);
    document.body.append(anchor);
    await tick();
    expect(target.textContent).toBe("");
    expect(stats.cleanups).toBe(1);
    const before = stats.runs;
    setValue(1);
    expect(stats.runs).toBe(before);
  });
});

describe("KeepAlive disposed during a switch", () => {
  it("does not commit a case after its factory disposed the anchor", async () => {
    const [key, setKey] = signal("a");
    const [value, setValue] = signal(0);
    const a = { runs: 0, cleanups: 0 };
    const b = { runs: 0, cleanups: 0 };
    const host = div();
    document.body.append(host);
    let anchor: Comment | undefined;
    anchor = KeepAlive(key, {
      a: () => tracked("a", value, a),
      b: () => {
        dispose(anchor as Comment);
        return tracked("orphan b", value, b);
      },
    });
    host.append(anchor);
    await tick();
    expect(host.textContent).toBe("a0");
    setKey("b");
    await tick();
    expect(host.textContent).toBe("");
    expect(a.cleanups).toBe(1);
    expect(b.cleanups).toBe(1);
    const before = a.runs + b.runs;
    setValue(1);
    expect(a.runs + b.runs).toBe(before);
    dispose(anchor);
    expect(a.cleanups + b.cleanups).toBe(2);
  });

  it("does not build the next case after parking disposed the anchor", async () => {
    const [key, setKey] = signal("a");
    let built = 0;
    const host = div();
    document.body.append(host);
    let anchor: Comment | undefined;
    const tag = reactiveTag("disconnectedCallback", () => dispose(anchor as Comment));
    anchor = KeepAlive(key, {
      a: () => document.createElement(tag),
      b: () => {
        built++;
        return div("b");
      },
    });
    host.append(anchor);
    await tick();
    setKey("b");
    await tick();
    expect(built).toBe(0);
    expect(host.textContent).toBe("");
  });

  it("does not insert the new case after an evicted case's cleanup disposed the anchor", async () => {
    const [key, setKey] = signal("a");
    const [value, setValue] = signal(0);
    const b = { runs: 0, cleanups: 0 };
    const host = div();
    document.body.append(host);
    let anchor: Comment | undefined;
    anchor = KeepAlive(
      key,
      {
        a: () => {
          const el = div("a");
          registerDisposer(el, () => dispose(anchor as Comment));
          return el;
        },
        b: () => tracked("b", value, b),
      },
      { max: 1 },
    );
    host.append(anchor);
    await tick();
    setKey("b");
    await tick();
    expect(host.textContent).toBe("");
    expect(b.cleanups).toBe(1);
    const before = b.runs;
    setValue(1);
    expect(b.runs).toBe(before);
  });

  it("stops after the inserted case's connectedCallback disposed the anchor", async () => {
    const [key, setKey] = signal("a");
    const [rows, setRows] = signal([1, 2]);
    let rowBuilds = 0;
    const host = div();
    document.body.append(host);
    let anchor: Comment | undefined;
    const tag = reactiveTag("connectedCallback", () => dispose(anchor as Comment));
    anchor = KeepAlive(key, {
      a: () => div("a"),
      b: () =>
        Fragment([
          document.createElement(tag),
          each(
            rows,
            (n) => {
              rowBuilds++;
              return span(() => String(n()));
            },
            { key: (n) => n },
          ),
        ]),
    });
    host.append(anchor);
    await tick();
    setKey("b");
    await tick();
    // The case's nested first render never starts in a disposed case.
    expect(rowBuilds).toBe(0);
    expect(host.textContent).toBe("");
    setRows([1, 2, 3]);
    await tick();
    expect(rowBuilds).toBe(0);
  });

  it("shows only the newest case when a factory switches the key", async () => {
    const [key, setKey] = signal("a");
    const host = div();
    document.body.append(host);
    const anchor = KeepAlive(key, {
      a: () => div("a"),
      b: () => {
        setKey("c");
        return div("b");
      },
      c: () => div("c"),
    });
    host.append(anchor);
    await tick();
    setKey("b");
    await tick();
    expect(host.textContent).toBe("c");
    setKey("b");
    await tick();
    expect(host.textContent).toBe("b");
    dispose(anchor);
  });
});

describe("KeepAlive case factory that disposes and throws", () => {
  it("rolls back what it allocated after disposing the anchor", async () => {
    setRuntimeErrorHandler(() => {});
    const [key, setKey] = signal("a");
    const [value, setValue] = signal(0);
    const stats = { runs: 0, cleanups: 0 };
    const host = div();
    document.body.append(host);
    let anchor: Comment | undefined;
    anchor = KeepAlive(key, {
      a: () => div("a"),
      b: () => {
        dispose(anchor as Comment);
        tracked("b", value, stats);
        throw new Error("disposed and failed");
      },
    });
    host.append(anchor);
    await tick();
    setKey("b");
    await tick();
    expect(host.textContent).toBe("");
    expect(stats.cleanups).toBe(1);
    const before = stats.runs;
    setValue(1);
    expect(stats.runs).toBe(before);
    dispose(anchor);
    dispose(anchor);
    expect(stats.cleanups).toBe(1);
  });

  it("rolls back what it allocated before and after disposing the anchor", async () => {
    setRuntimeErrorHandler(() => {});
    const [key, setKey] = signal("a");
    const [value, setValue] = signal(0);
    const early = { runs: 0, cleanups: 0 };
    const late = { runs: 0, cleanups: 0 };
    const host = div();
    document.body.append(host);
    let anchor: Comment | undefined;
    anchor = KeepAlive(key, {
      a: () => div("a"),
      b: () => {
        tracked("early", value, early);
        dispose(anchor as Comment);
        tracked("late", value, late);
        throw new Error("disposed and failed");
      },
    });
    host.append(anchor);
    await tick();
    setKey("b");
    await tick();
    expect(early.cleanups).toBe(1);
    expect(late.cleanups).toBe(1);
    const before = early.runs + late.runs;
    setValue(1);
    expect(early.runs + late.runs).toBe(before);
  });
});

describe("each row render that disposes an enclosing KeepAlive", () => {
  /** Record exceptions thrown by scheduled microtasks instead of failing the run. */
  function captureMicrotaskErrors(): string[] {
    const errors: string[] = [];
    const schedule = globalThis.queueMicrotask;
    vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) =>
      schedule(() => {
        try {
          callback();
        } catch (error) {
          errors.push(String(error));
        }
      }),
    );
    return errors;
  }

  it("releases the row it returned and inserts nothing", async () => {
    const errors = captureMicrotaskErrors();
    const [key, setKey] = signal("a");
    const [value, setValue] = signal(0);
    const stats = { runs: 0, cleanups: 0 };
    const host = div();
    document.body.append(host);
    let anchor: Comment | undefined;
    anchor = KeepAlive(key, {
      a: () => div("a"),
      b: () =>
        each(
          () => [1],
          () => {
            dispose(anchor as Comment);
            return tracked("row", value, stats);
          },
          { key: (x) => x },
        ),
    });
    host.append(anchor);
    await tick();
    setKey("b");
    await tick();
    expect(errors).toEqual([]);
    expect(host.textContent).toBe("");
    expect(stats.cleanups).toBe(1);
    const before = stats.runs;
    setValue(1);
    expect(stats.runs).toBe(before);
  });

  it("releases the rows the same pass built before the disposing one", async () => {
    const errors = captureMicrotaskErrors();
    const [key, setKey] = signal("a");
    const [value, setValue] = signal(0);
    const first = { runs: 0, cleanups: 0 };
    const second = { runs: 0, cleanups: 0 };
    const host = div();
    document.body.append(host);
    let anchor: Comment | undefined;
    anchor = KeepAlive(key, {
      a: () => div("a"),
      b: () =>
        each(
          () => [1, 2],
          (n) => {
            if (n() === 1) return tracked("one", value, first);
            dispose(anchor as Comment);
            return tracked("two", value, second);
          },
          { key: (x) => x },
        ),
    });
    host.append(anchor);
    await tick();
    setKey("b");
    await tick();
    expect(errors).toEqual([]);
    expect(host.textContent).toBe("");
    expect(first.cleanups).toBe(1);
    expect(second.cleanups).toBe(1);
    const before = first.runs + second.runs;
    setValue(1);
    expect(first.runs + second.runs).toBe(before);
  });

  it("releases new rows of a later pass when one of them disposes the list's host", async () => {
    const [rows, setRows] = signal([1]);
    const [value, setValue] = signal(0);
    const added = { runs: 0, cleanups: 0 };
    let host: HTMLElement | undefined;
    host = div([
      each(
        rows,
        (n) => {
          if (n() === 3) dispose(host as HTMLElement);
          return n() === 1 ? span("1") : tracked(String(n()), value, added);
        },
        { key: (x) => x },
      ),
    ]);
    document.body.append(host);
    await tick();
    setRows([1, 2, 3]);
    await tick();
    expect(added.cleanups).toBe(2);
    const before = added.runs;
    setValue(1);
    expect(added.runs).toBe(before);
  });

  it("releases a disposed factory result's complete nested fragment range", async () => {
    const [key, setKey] = signal("a");
    const [rows, setRows] = signal([1]);
    let builds = 0;
    let cleanups = 0;
    const host = div();
    document.body.append(host);
    let anchor: Comment | undefined;
    anchor = KeepAlive(key, {
      a: () => div("a"),
      b: () => {
        dispose(anchor as Comment);
        const frag = Fragment([
          each(
            rows,
            () => {
              builds++;
              return span("row");
            },
            { key: (x) => x },
          ),
        ]);
        registerDisposer(frag, () => cleanups++);
        return frag;
      },
    });
    host.append(anchor);
    await tick();
    setKey("b");
    await tick();
    setRows([1, 2]);
    await tick();
    expect({ text: host.textContent, builds, cleanups }).toEqual({ text: "", builds: 0, cleanups: 1 });
  });
});

describe("Portal candidate whose cleanup disposes the anchor again", () => {
  it("is released once", async () => {
    let cleanups = 0;
    const target = div();
    let anchor: Comment | undefined;
    anchor = Portal(() => {
      dispose(anchor as Comment);
      const node = span("candidate");
      registerDisposer(node, () => {
        cleanups++;
        dispose(anchor as Comment);
      });
      return node;
    }, target);
    document.body.append(target, anchor);
    await tick();
    expect({ text: target.textContent, cleanups }).toEqual({ text: "", cleanups: 1 });
  });
});

describe("KeepAlive first render that switches the key", () => {
  it("shows only the newest case when the first factory writes the key", async () => {
    const [key, setKey] = signal("a");
    const host = div();
    document.body.append(host);
    const anchor = KeepAlive(key, {
      a: () => {
        setKey("b");
        return div("a");
      },
      b: () => div("b"),
    });
    host.append(anchor);
    await tick();
    expect(key()).toBe("b");
    expect(host.textContent).toBe("b");
    dispose(anchor);
  });

  it("keeps the superseded case cached and shows it on a later switch", async () => {
    const [key, setKey] = signal("a");
    let aBuilds = 0;
    const host = div();
    document.body.append(host);
    const anchor = KeepAlive(key, {
      a: () => {
        aBuilds++;
        if (aBuilds === 1) setKey("b");
        return div("a");
      },
      b: () => div("b"),
    });
    host.append(anchor);
    await tick();
    expect(host.textContent).toBe("b");
    setKey("a");
    await tick();
    expect(host.textContent).toBe("a");
    expect(aBuilds).toBe(1);
    setKey("b");
    await tick();
    expect(host.textContent).toBe("b");
    dispose(anchor);
  });

  it("evicts the superseded case, not the shown one, from a bounded cache", async () => {
    const [key, setKey] = signal("a");
    let aCleanups = 0;
    let bCleanups = 0;
    const host = div();
    document.body.append(host);
    const anchor = KeepAlive(
      key,
      {
        a: () => {
          setKey("b");
          const el = div("a");
          registerDisposer(el, () => aCleanups++);
          return el;
        },
        b: () => {
          const el = div("b");
          registerDisposer(el, () => bCleanups++);
          return el;
        },
      },
      { max: 1 },
    );
    host.append(anchor);
    await tick();
    expect(host.textContent).toBe("b");
    expect(aCleanups).toBe(1);
    expect(bCleanups).toBe(0);
    dispose(anchor);
    expect(bCleanups).toBe(1);
  });

  it("shows only the newest case when the first case's connectedCallback writes the key", async () => {
    const [key, setKey] = signal("a");
    const host = div();
    document.body.append(host);
    let connects = 0;
    // Redirects on its first connection only: re-attaching the cached case
    // connects it again.
    const tag = reactiveTag("connectedCallback", () => {
      if (++connects === 1) setKey("b");
    });
    const anchor = KeepAlive(key, {
      a: () => {
        const el = document.createElement(tag);
        el.textContent = "a";
        return el;
      },
      b: () => div("b"),
    });
    host.append(anchor);
    await tick();
    expect(host.textContent).toBe("b");
    setKey("a");
    await tick();
    expect(host.textContent).toBe("a");
    dispose(anchor);
  });
});

describe("each() teardown after a completed pass", () => {
  it("does not reclaim a removed row now owned by another container", async () => {
    const [rows, setRows] = signal([1]);
    const row = span("reused elsewhere");
    const anchor = each(rows, () => row, { key: (x) => x });
    const host = div([anchor]);
    document.body.append(host);
    await tick();
    setRows([]);
    expect(row.parentNode).toBeNull();
    const other = div([row]);
    document.body.append(other);
    let newOwnerCleanups = 0;
    registerDisposer(row, () => newOwnerCleanups++);
    dispose(anchor);
    expect(other.textContent).toBe("reused elsewhere");
    expect(row.parentNode).toBe(other);
    expect(newOwnerCleanups).toBe(0);
  });

  it("still releases every committed row once", async () => {
    const [rows, setRows] = signal([1, 2]);
    const [value, setValue] = signal(0);
    const stats = { runs: 0, cleanups: 0 };
    const anchor = each(rows, (n) => tracked(String(n()), value, stats), { key: (x) => x });
    const host = div([anchor]);
    document.body.append(host);
    await tick();
    setRows([2, 3]);
    await tick();
    expect(stats.cleanups).toBe(1);
    dispose(anchor);
    expect(stats.cleanups).toBe(3);
    const before = stats.runs;
    setValue(1);
    expect(stats.runs).toBe(before);
  });
});

describe("each() row render that throws", () => {
  it("rolls back a row that disposed its outer KeepAlive and then threw", async () => {
    setRuntimeErrorHandler(() => {});
    const [key, setKey] = signal("a");
    const [value, setValue] = signal(0);
    const stats = { runs: 0, cleanups: 0 };
    const host = div();
    document.body.append(host);
    let anchor: Comment | undefined;
    anchor = KeepAlive(key, {
      a: () => div("a"),
      b: () =>
        each(
          () => [1],
          () => {
            dispose(anchor as Comment);
            tracked("row", value, stats);
            throw new Error("disposed row failed");
          },
          { key: (x) => x },
        ),
    });
    host.append(anchor);
    await tick();
    setKey("b");
    await tick();
    expect(host.textContent).toBe("");
    expect(stats.cleanups).toBe(1);
    const before = stats.runs;
    setValue(1);
    expect(stats.runs).toBe(before);
  });

  it("rolls back a throwing row and keeps the other rows live", async () => {
    setRuntimeErrorHandler(() => {});
    const [value, setValue] = signal(0);
    const failed = { runs: 0, cleanups: 0 };
    const kept = { runs: 0, cleanups: 0 };
    const anchor = each(
      () => [1, 2],
      (n) => {
        if (n() === 1) return tracked("ok", value, kept);
        tracked("bad", value, failed);
        throw new Error("row failed");
      },
      { key: (x) => x },
    );
    const host = div([anchor]);
    document.body.append(host);
    await tick();
    expect(host.textContent).toBe("ok0");
    expect(failed.cleanups).toBe(1);
    const before = failed.runs;
    setValue(1);
    expect(failed.runs).toBe(before);
    expect(host.textContent).toBe("ok1");
    expect(kept.cleanups).toBe(0);
    dispose(anchor);
    expect(kept.cleanups).toBe(1);
  });
});

describe("KeepAlive first render redirected back to the same key", () => {
  /** `a` redirects to `b` on its first build; `b` always redirects back to `a`. */
  function roundTrip(value: () => number, latest: Stats) {
    let aBuilds = 0;
    const cases = {
      a: () => {
        const build = ++aBuilds;
        if (build === 1) {
          setKeyRef("b");
          return div("obsolete a");
        }
        return tracked("latest a", value, latest);
      },
      b: () => {
        setKeyRef("a");
        return div("b");
      },
    };
    let setKeyRef: (k: string) => void = () => {};
    return {
      cases,
      bind: (set: (k: string) => void) => {
        setKeyRef = set;
      },
      builds: () => aBuilds,
    };
  }

  it.each([1, 10])("keeps the newest case owned with max %i", async (max) => {
    const [key, setKey] = signal("a");
    const [value, setValue] = signal(0);
    const latest = { runs: 0, cleanups: 0 };
    const trip = roundTrip(value, latest);
    trip.bind(setKey);
    const host = div();
    document.body.append(host);
    const anchor = KeepAlive(key, trip.cases, { max });
    host.append(anchor);
    await tick();
    expect(key()).toBe("a");
    expect(host.textContent).toBe("latest a0");
    dispose(anchor);
    expect(host.textContent).toBe("");
    expect(latest.cleanups).toBe(1);
    const before = latest.runs;
    setValue(1);
    expect(latest.runs).toBe(before);
  });

  it("navigates the cached cases afterwards without rebuilding them", async () => {
    const [key, setKey] = signal("a");
    const [value] = signal(0);
    const latest = { runs: 0, cleanups: 0 };
    const trip = roundTrip(value, latest);
    trip.bind(setKey);
    const host = div();
    document.body.append(host);
    const anchor = KeepAlive(key, trip.cases);
    host.append(anchor);
    await tick();
    expect(host.textContent).toBe("latest a0");
    setKey("b");
    await tick();
    expect(host.textContent).toBe("b");
    setKey("a");
    await tick();
    expect(host.textContent).toBe("latest a0");
    expect(trip.builds()).toBe(2);
    expect(latest.cleanups).toBe(0);
    dispose(anchor);
    expect(latest.cleanups).toBe(1);
  });
});
