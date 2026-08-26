// ---------------------------------------------------------------------------
// Enhancement lifecycle hardening.
//
// The governing invariant under test:
//
//     SETUP IS A TRANSACTION OVER FRAMEWORK-OWNED RESOURCES
//
//   setup success → lifecycle ownership commits
//   setup failure → every framework resource created before the throw rolls back
//   dispose       → active ownership ends and the root becomes enhanceable again
//
// Every test here proves resource *death* by real dispatch / real signal writes,
// never by inspecting teardown bookkeeping — and guards against vacuity by
// asserting the resource was alive first.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispose } from "../src/core/rendering/dispose";
import { signal } from "../src/core/signals/signal";
import { enhance, enhanceAll } from "../src/platform/enhance";

function serverRender(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html.trim();
  document.body.appendChild(host);
  return host.firstElementChild as HTMLElement;
}

const COUNTER_HTML = `<div class="c"><b data-ref="n">0</b><button data-ref="b">x</button></div>`;

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// ENH-001 — setup failure must roll back framework-owned resources
// ---------------------------------------------------------------------------

describe("ENH-001 — enhance() setup failure rolls back framework-owned resources", () => {
  it("tears down effect, listener and custom cleanups created before the throw", () => {
    const root = serverRender(COUNTER_HTML);
    const textNode = root.querySelector('[data-ref="n"]') as HTMLElement;
    const button = root.querySelector('[data-ref="b"]') as HTMLButtonElement;
    const [n, setN] = signal(1);

    let listenerCalls = 0;
    let cleanupA = 0;
    let cleanupB = 0;
    let setupCalls = 0;

    expect(() =>
      enhance(root, (ctx) => {
        setupCalls++;
        ctx.text("@n", () => n());
        ctx.attr("@n", "data-count", () => n());
        ctx.on("@b", "click", () => listenerCalls++);
        ctx.cleanup(() => cleanupA++);
        ctx.cleanup(() => cleanupB++);
        throw new Error("setup failed");
      }),
    ).toThrow("setup failed");

    // Vacuity guards: the bindings really did run before the throw.
    expect(setupCalls).toBe(1);
    expect(textNode.textContent).toBe("1");
    expect(textNode.getAttribute("data-count")).toBe("1");

    // Custom cleanups ran exactly once each.
    expect(cleanupA).toBe(1);
    expect(cleanupB).toBe(1);

    // The effect is dead: a signal write must not reach the DOM.
    setN(2);
    expect(textNode.textContent).toBe("1");
    expect(textNode.getAttribute("data-count")).toBe("1");

    // The listener is gone: real dispatch must not reach the handler.
    button.click();
    expect(listenerCalls).toBe(0);

    // A failed setup never claims ownership.
    expect(root.hasAttribute("data-sibu-enhanced")).toBe(false);
  });

  it("proves the listener was live before the throw (vacuity guard)", () => {
    const root = serverRender(COUNTER_HTML);
    const button = root.querySelector('[data-ref="b"]') as HTMLButtonElement;
    let listenerCalls = 0;

    expect(() =>
      enhance(root, (ctx) => {
        ctx.on("@b", "click", () => listenerCalls++);
        // Dispatch *inside* setup, while the listener is legitimately wired.
        button.click();
        expect(listenerCalls).toBe(1);
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(listenerCalls).toBe(1); // was alive
    button.click();
    expect(listenerCalls).toBe(1); // now dead
  });

  it("rolls back a model() binding (both directions) when setup later throws", () => {
    const root = serverRender(`<form><input data-ref="name" value="seed" /></form>`);
    const input = root.querySelector('[data-ref="name"]') as HTMLInputElement;
    const [name, setName] = signal("seed");

    expect(() =>
      enhance(root, (ctx) => {
        ctx.model("@name", [name, setName]);
        throw new Error("late failure");
      }),
    ).toThrow("late failure");

    // signal → control is dead
    setName("alice");
    expect(input.value).toBe("seed");

    // control → signal is dead
    input.value = "bob";
    input.dispatchEvent(new Event("input"));
    expect(name()).toBe("alice");
  });

  it("restores show() visibility state on rollback", () => {
    const root = serverRender(`<div><p data-ref="msg" hidden>hi</p></div>`);
    const msg = root.querySelector('[data-ref="msg"]') as HTMLElement;
    const [open] = signal(true);

    expect(() =>
      enhance(root, (ctx) => {
        ctx.show("@msg", () => open());
        expect(msg.hidden).toBe(false); // vacuity guard: binding applied
        throw new Error("nope");
      }),
    ).toThrow("nope");

    expect(msg.hidden).toBe(true); // server state restored
  });

  it.each([
    ["immediately", 0],
    ["after the first binding", 1],
    ["after several bindings", 2],
    ["after cleanup registration", 3],
    ["near the end of setup", 4],
  ])("rolls back when setup throws %s", (_label, stopAt) => {
    const root = serverRender(COUNTER_HTML);
    const textNode = root.querySelector('[data-ref="n"]') as HTMLElement;
    const button = root.querySelector('[data-ref="b"]') as HTMLButtonElement;
    const [n, setN] = signal(1);
    let listenerCalls = 0;
    let cleanups = 0;

    expect(() =>
      enhance(root, (ctx) => {
        if (stopAt === 0) throw new Error("stop");
        ctx.text("@n", () => n());
        if (stopAt === 1) throw new Error("stop");
        ctx.on("@b", "click", () => listenerCalls++);
        ctx.classed("@n", "live", () => n() > 0);
        if (stopAt === 2) throw new Error("stop");
        ctx.cleanup(() => cleanups++);
        if (stopAt === 3) throw new Error("stop");
        ctx.attr("@n", "data-x", () => n());
        throw new Error("stop");
      }),
    ).toThrow("stop");

    setN(99);
    button.click();

    expect(textNode.textContent).not.toBe("99"); // no live effect
    expect(listenerCalls).toBe(0); // no live listener
    expect(cleanups).toBe(stopAt >= 3 ? 1 : 0); // registered cleanups ran once
    expect(root.hasAttribute("data-sibu-enhanced")).toBe(false);
  });

  it("preserves the original setup error (does not swallow or replace it)", () => {
    const root = serverRender(COUNTER_HTML);
    const original = new TypeError("original failure");

    let thrown: unknown;
    try {
      enhance(root, (ctx) => {
        ctx.text("@n", () => "x");
        throw original;
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBe(original); // identity, not a wrapper
  });

  it("continues rollback when a teardown itself throws, and still rethrows the setup error", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = serverRender(COUNTER_HTML);
    const button = root.querySelector('[data-ref="b"]') as HTMLButtonElement;
    let a = 0;
    let c = 0;
    let listenerCalls = 0;

    expect(() =>
      enhance(root, (ctx) => {
        ctx.cleanup(() => {
          a++;
        });
        ctx.cleanup(() => {
          throw new Error("teardown B exploded");
        });
        ctx.cleanup(() => {
          c++;
        });
        ctx.on("@b", "click", () => listenerCalls++);
        throw new Error("setup X");
      }),
    ).toThrow("setup X"); // original error survives the broken teardown

    expect(a).toBe(1);
    expect(c).toBe(1); // C ran despite B throwing
    button.click();
    expect(listenerCalls).toBe(0); // listener still removed
    expect(err).toHaveBeenCalled(); // reported via the existing convention
  });

  it("runs a teardown registered during rollback, at most once (reentrancy)", () => {
    const root = serverRender(COUNTER_HTML);
    let outer = 0;
    let nested = 0;

    expect(() =>
      enhance(root, (ctx) => {
        ctx.cleanup(() => {
          outer++;
          ctx.cleanup(() => nested++); // registered *during* rollback
        });
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(outer).toBe(1);
    expect(nested).toBe(1);
  });

  it("allows a retry after a failed setup", () => {
    const root = serverRender(COUNTER_HTML);
    const textNode = root.querySelector('[data-ref="n"]') as HTMLElement;
    const [n, setN] = signal(1);

    expect(() =>
      enhance(root, (ctx) => {
        ctx.text("@n", () => n());
        throw new Error("first attempt fails");
      }),
    ).toThrow();

    // The root was never claimed, so a retry must be accepted.
    const stop = enhance(root, (ctx) => ctx.text("@n", () => n()));
    setN(42);
    expect(textNode.textContent).toBe("42"); // retry is live
    expect(root.getAttribute("data-sibu-enhanced")).toBe("true");

    stop();
    setN(43);
    expect(textNode.textContent).toBe("42"); // single binding, cleanly disposed
  });

  it("does not leave a DOM-level disposer behind after a failed setup", () => {
    const root = serverRender(COUNTER_HTML);
    let cleanups = 0;

    expect(() =>
      enhance(root, (ctx) => {
        ctx.cleanup(() => cleanups++);
        throw new Error("boom");
      }),
    ).toThrow();

    expect(cleanups).toBe(1);
    dispose(root); // must not re-run the rolled-back teardown
    expect(cleanups).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ENH-002 — marker lifetime tracks active ownership (Model B)
// ---------------------------------------------------------------------------

describe("ENH-002 — data-sibu-enhanced tracks active ownership", () => {
  it("adds the marker on success and removes it on dispose", () => {
    const root = serverRender(COUNTER_HTML);
    const stop = enhance(root, (ctx) => ctx.text("@n", () => "1"));
    expect(root.getAttribute("data-sibu-enhanced")).toBe("true");

    stop();
    expect(root.hasAttribute("data-sibu-enhanced")).toBe(false);
  });

  it("re-enhances a disposed root; generation 1 stays dead and generation 2 is live", () => {
    const root = serverRender(COUNTER_HTML);
    const textNode = root.querySelector('[data-ref="n"]') as HTMLElement;
    const button = root.querySelector('[data-ref="b"]') as HTMLButtonElement;
    const [a, setA] = signal("a1");
    const [b, setB] = signal("b1");
    let clicksA = 0;
    let clicksB = 0;

    const dispose1 = enhance(root, (ctx) => {
      ctx.text("@n", () => a());
      ctx.on("@b", "click", () => clicksA++);
    });

    // Vacuity guard: generation 1 was genuinely active.
    setA("a2");
    expect(textNode.textContent).toBe("a2");
    button.click();
    expect(clicksA).toBe(1);

    dispose1();

    const dispose2 = enhance(root, (ctx) => {
      ctx.text("@n", () => b());
      ctx.on("@b", "click", () => clicksB++);
    });

    // Generation 2 is live…
    setB("b2");
    expect(textNode.textContent).toBe("b2");
    button.click();
    expect(clicksB).toBe(1);

    // …and generation 1 is still dead (no duplicate effect / listener).
    expect(clicksA).toBe(1);
    setA("a3");
    expect(textNode.textContent).toBe("b2");

    dispose2();
    setB("b3");
    button.click();
    expect(textNode.textContent).toBe("b2");
    expect(clicksB).toBe(1);
    expect(root.hasAttribute("data-sibu-enhanced")).toBe(false);
  });

  it("is idempotent on double dispose", () => {
    const root = serverRender(COUNTER_HTML);
    let cleanups = 0;
    const stop = enhance(root, (ctx) => ctx.cleanup(() => cleanups++));

    stop();
    expect(() => stop()).not.toThrow();
    expect(cleanups).toBe(1);
    expect(root.hasAttribute("data-sibu-enhanced")).toBe(false);
  });

  it("still refuses to double-enhance an ACTIVE root", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = serverRender(COUNTER_HTML);
    const textNode = root.querySelector('[data-ref="n"]') as HTMLElement;
    const [n, setN] = signal(0);
    let secondSetupCalls = 0;

    const dispose1 = enhance(root, (ctx) => ctx.text("@n", () => n()));
    const dispose2 = enhance(root, (ctx) => {
      secondSetupCalls++;
      ctx.text("@n", () => n());
    });

    expect(secondSetupCalls).toBe(0); // never ran — no ambiguous ownership
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("already enhanced"), root);

    setN(3);
    expect(textNode.textContent).toBe("3"); // exactly one binding

    // The refused call's disposer is inert: it must not strip generation 1.
    dispose2();
    expect(root.getAttribute("data-sibu-enhanced")).toBe("true");
    setN(4);
    expect(textNode.textContent).toBe("4"); // generation 1 untouched

    dispose1();
    expect(root.hasAttribute("data-sibu-enhanced")).toBe(false);
  });

  it("a stale generation-1 disposer cannot strip generation 2's marker", () => {
    const root = serverRender(COUNTER_HTML);
    const textNode = root.querySelector('[data-ref="n"]') as HTMLElement;
    const [n, setN] = signal(0);

    const dispose1 = enhance(root, () => {});
    dispose1();

    const dispose2 = enhance(root, (ctx) => ctx.text("@n", () => n()));
    expect(root.getAttribute("data-sibu-enhanced")).toBe("true");

    dispose1(); // stale, replayed
    dispose1();

    expect(root.getAttribute("data-sibu-enhanced")).toBe("true"); // still owned by gen 2
    setN(7);
    expect(textNode.textContent).toBe("7"); // gen 2 still live

    dispose2();
    expect(root.hasAttribute("data-sibu-enhanced")).toBe(false);
  });

  it("DOM-level dispose() also clears the marker, restoring enhanceability", () => {
    const root = serverRender(COUNTER_HTML);
    const textNode = root.querySelector('[data-ref="n"]') as HTMLElement;
    const [n, setN] = signal(0);

    enhance(root, (ctx) => ctx.text("@n", () => n()));
    setN(1);
    expect(textNode.textContent).toBe("1"); // vacuity guard

    dispose(root);
    expect(root.hasAttribute("data-sibu-enhanced")).toBe(false);

    const stop = enhance(root, (ctx) => ctx.text("@n", () => n()));
    setN(5);
    expect(textNode.textContent).toBe("5");
    stop();
  });

  it("commits normally when setup disposes its own root mid-setup", () => {
    // Publicly reachable: `ctx.root` is exposed, so a setup can call
    // dispose(ctx.root). The in-flight enhancement is not yet registered, so the
    // walk cannot reach it — it disposes the *previous* owner and the newer
    // enhancement then commits. Pinned so the semantics are explicit, not
    // accidental: the committed generation is the live one, with no stale marker
    // and no zombie from the generation it replaced.
    const root = serverRender(COUNTER_HTML);
    const textNode = root.querySelector('[data-ref="n"]') as HTMLElement;
    const [a, setA] = signal("a1");
    const [b, setB] = signal("b1");

    const stopOld = enhance(root, (ctx) => ctx.text("@n", () => a()));
    setA("a2");
    expect(textNode.textContent).toBe("a2"); // vacuity guard: old generation live
    stopOld();

    const stop = enhance(root, (ctx) => {
      dispose(ctx.root); // disposes prior owners, not this in-flight setup
      ctx.text("@n", () => b());
    });

    expect(root.getAttribute("data-sibu-enhanced")).toBe("true");
    setB("b2");
    expect(textNode.textContent).toBe("b2"); // committed generation is live
    setA("a3");
    expect(textNode.textContent).toBe("b2"); // replaced generation stays dead

    stop();
    expect(root.hasAttribute("data-sibu-enhanced")).toBe(false);
    setB("b3");
    expect(textNode.textContent).toBe("b2");
  });

  it("runs a setup-returned cleanup exactly once on dispose", () => {
    const root = serverRender(COUNTER_HTML);
    let returned = 0;
    const stop = enhance(root, () => () => {
      returned++;
    });

    stop();
    stop();
    expect(returned).toBe(1);
  });

  it("rolls back ctx resources when setup throws before returning its cleanup", () => {
    const root = serverRender(COUNTER_HTML);
    const button = root.querySelector('[data-ref="b"]') as HTMLButtonElement;
    let listenerCalls = 0;
    let cleanupRuns = 0;
    const returnedCleanup = () => cleanupRuns++;

    expect(() =>
      enhance(root, (ctx) => {
        ctx.on("@b", "click", () => listenerCalls++);
        if (root.isConnected) throw new Error("before return");
        return returnedCleanup; // never reached — setup dies first
      }),
    ).toThrow("before return");

    button.click();
    expect(listenerCalls).toBe(0); // ctx resources rolled back…
    expect(cleanupRuns).toBe(0); // …and no setup-returned cleanup is invented
  });
});

// ---------------------------------------------------------------------------
// ENH-003 — enhanceAll() is transactional across the collection
// ---------------------------------------------------------------------------

describe("ENH-003 — enhanceAll() rolls back on a later failure", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div class="c" id="A"><b data-ref="n">0</b><button data-ref="b">x</button></div>
      <div class="c" id="B"><b data-ref="n">0</b><button data-ref="b">x</button></div>
      <div class="c" id="C"><b data-ref="n">0</b><button data-ref="b">x</button></div>`;
  });

  it("strands nothing when the third setup throws", () => {
    const [n, setN] = signal(1);
    let listenerCalls = 0;
    let seen = 0;
    const cleanups: string[] = [];

    expect(() =>
      enhanceAll(".c", (ctx) => {
        const id = ctx.root.id;
        seen++;
        ctx.text("@n", () => n());
        ctx.on("@b", "click", () => listenerCalls++);
        ctx.cleanup(() => cleanups.push(id));
        if (id === "C") throw new Error("C failed");
      }),
    ).toThrow("C failed"); // original error preserved

    // Vacuity guard: A and B really were enhanced before C blew up.
    expect(seen).toBe(3);
    for (const id of ["A", "B", "C"]) {
      expect(document.querySelector(`#${id} [data-ref="n"]`)?.textContent).toBe("1");
    }

    // Every cleanup ran exactly once; C rolled back inside enhance(), then B, then A.
    expect(cleanups).toEqual(["C", "B", "A"]);

    // No node is left actively enhanced, and no binding survives.
    expect(document.querySelectorAll("[data-sibu-enhanced]").length).toBe(0);
    setN(2);
    for (const id of ["A", "B", "C"]) {
      expect(document.querySelector(`#${id} [data-ref="n"]`)?.textContent).toBe("1");
      (document.querySelector(`#${id} [data-ref="b"]`) as HTMLButtonElement).click();
    }
    expect(listenerCalls).toBe(0);
  });

  it("does not let a rollback failure mask the original setup error", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const [n] = signal(1);
    let aCleaned = 0;

    expect(() =>
      enhanceAll(".c", (ctx) => {
        const id = ctx.root.id;
        ctx.text("@n", () => n());
        if (id === "A") ctx.cleanup(() => aCleaned++);
        if (id === "B") {
          ctx.cleanup(() => {
            throw new Error("rollback Y");
          });
        }
        if (id === "C") throw new Error("setup X");
      }),
    ).toThrow("setup X"); // X, not Y

    expect(aCleaned).toBe(1); // rollback continued past B's broken teardown
    expect(document.querySelectorAll("[data-sibu-enhanced]").length).toBe(0);
    expect(err).toHaveBeenCalled();
  });

  it("keeps the success path intact and remountable", () => {
    const [n, setN] = signal(0);
    const setups: string[] = [];
    const stop = enhanceAll(".c", (ctx) => {
      setups.push(ctx.root.id);
      ctx.text("@n", () => n());
    });

    expect(setups).toEqual(["A", "B", "C"]);
    setN(7);
    expect(Array.from(document.querySelectorAll('.c [data-ref="n"]'), (x) => x.textContent)).toEqual(["7", "7", "7"]);
    expect(document.querySelectorAll("[data-sibu-enhanced]").length).toBe(3);

    stop();
    stop(); // idempotent
    setN(9);
    expect(Array.from(document.querySelectorAll('.c [data-ref="n"]'), (x) => x.textContent)).toEqual(["7", "7", "7"]);
    expect(document.querySelectorAll("[data-sibu-enhanced]").length).toBe(0);

    // Remountable through the same operation that created it.
    const stop2 = enhanceAll(".c", (ctx) => ctx.text("@n", () => n()));
    setN(11);
    expect(Array.from(document.querySelectorAll('.c [data-ref="n"]'), (x) => x.textContent)).toEqual([
      "11",
      "11",
      "11",
    ]);
    stop2();
  });
});

// ---------------------------------------------------------------------------
// Soak — repeated enhance/dispose and repeated failed setups must not accumulate
// ---------------------------------------------------------------------------

describe("enhance() soak — no listener/effect/marker accumulation", () => {
  it("survives 500 enhance → mutate → dispose cycles", () => {
    const root = serverRender(COUNTER_HTML);
    const textNode = root.querySelector('[data-ref="n"]') as HTMLElement;
    const button = root.querySelector('[data-ref="b"]') as HTMLButtonElement;
    const [n, setN] = signal(0);

    let added = 0;
    let removed = 0;
    const origAdd = button.addEventListener.bind(button);
    const origRemove = button.removeEventListener.bind(button);
    vi.spyOn(button, "addEventListener").mockImplementation(((...args: unknown[]) => {
      added++;
      return (origAdd as unknown as (...a: unknown[]) => unknown)(...args);
    }) as typeof button.addEventListener);
    vi.spyOn(button, "removeEventListener").mockImplementation(((...args: unknown[]) => {
      removed++;
      return (origRemove as unknown as (...a: unknown[]) => unknown)(...args);
    }) as typeof button.removeEventListener);

    let clicks = 0;
    for (let i = 0; i < 500; i++) {
      const stop = enhance(root, (ctx) => {
        ctx.text("@n", () => n());
        ctx.on("@b", "click", () => clicks++);
      });
      setN(i);
      expect(textNode.textContent).toBe(String(i)); // each generation really bound
      button.click();
      stop();
    }

    expect(added).toBe(500); // every cycle re-enhanced (no permanent refusal)
    expect(removed).toBe(500); // and every cycle cleaned up
    expect(clicks).toBe(500); // exactly one live listener per cycle
    expect(root.hasAttribute("data-sibu-enhanced")).toBe(false);

    button.click();
    setN(9999);
    expect(clicks).toBe(500); // nothing survived the last dispose
    expect(textNode.textContent).toBe("499");
  });

  it("survives 500 failed setups followed by a successful retry", () => {
    const root = serverRender(COUNTER_HTML);
    const textNode = root.querySelector('[data-ref="n"]') as HTMLElement;
    const button = root.querySelector('[data-ref="b"]') as HTMLButtonElement;
    const [n, setN] = signal(0);
    let cleanups = 0;
    let clicks = 0;

    for (let i = 0; i < 500; i++) {
      expect(() =>
        enhance(root, (ctx) => {
          ctx.text("@n", () => n());
          ctx.on("@b", "click", () => clicks++);
          ctx.cleanup(() => cleanups++);
          throw new Error(`fail ${i}`);
        }),
      ).toThrow(`fail ${i}`);
    }

    expect(cleanups).toBe(500); // one rollback per attempt, no more
    button.click();
    expect(clicks).toBe(0); // zero surviving listeners after 500 failures
    setN(1);
    expect(textNode.textContent).toBe("0"); // zero surviving effects

    const stop = enhance(root, (ctx) => ctx.text("@n", () => n()));
    setN(2);
    expect(textNode.textContent).toBe("2"); // still enhanceable
    stop();
  });
});
