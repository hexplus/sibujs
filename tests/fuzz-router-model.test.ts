// Seeded randomized model test for the client router.
//
// Same discipline as the query fuzz: a fixed seed list drives a mulberry32 PRNG
// so every failure replays exactly, and the whole operation log is printed with
// the assertion. No `Math.random()` — safe for ordinary CI.
//
// This searches navigation *interleavings* rather than re-proving the already
// fixed epoch bugs (R-001/R-002/R-005 have targeted regressions): an async
// component resolving after it has been superseded, a guard rejecting while a
// load is in flight, a redirect racing a supersession, back/forward against a
// live navigation, `destroy()` mid-flight.
//
// TWO VACUITY TRAPS were found while writing this, and both are guarded below
// (see rc-findings TEST-005):
//
//   1. `navigate()` does NOT load components — `loadComponent` is only reached
//      from the `Route()` outlet. A fuzz that never mounts an outlet exercises
//      zero async loading, so the "settle/fail a pending load" operations are
//      silently no-ops. This file mounts a real outlet and asserts, at the end
//      of every seed, that loads actually happened.
//   2. `beforeEnter` takes a `Guard` — `(to, from?) => boolean | string` — not
//      the three-argument `next`-style `NavigationGuard`. Passing the wrong
//      shape makes every guarded navigation abort with `reason: "error"`, which
//      looks like a router bug and hides the guard path entirely.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RouteDef } from "../src/plugins/router";
import { createRouter, destroyRouter, Route } from "../src/plugins/router";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

interface PendingLoad {
  id: number;
  path: string;
  settled: boolean;
  settle: () => void;
  fail: (e: Error) => void;
}

let host: HTMLElement;

beforeEach(() => {
  window.history.replaceState({}, "", "/");
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  destroyRouter();
  host.remove();
});

function runSeed(seed: number, steps: number) {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];

  const log: string[] = [];
  const pendingLoads: PendingLoad[] = [];
  let nextLoad = 0;
  let guardMode: "allow" | "reject" | "redirect" = "allow";
  /** Times an async element was observed committed — proves I5 is not vacuous. */
  let asyncCommits = 0;
  /** Counts guard verdicts actually exercised, to prove I4 is not vacuous. */
  let guardRejectionsObserved = 0;

  const el = (text: string) => {
    const d = document.createElement("div");
    d.textContent = text;
    return d;
  };

  /** An async component whose resolution is driven by the operation stream. */
  const deferredComponent = (path: string) => () =>
    new Promise<Element>((resolve, reject) => {
      const id = nextLoad++;
      pendingLoads.push({
        id,
        path,
        settled: false,
        settle: () => resolve(el(`${path}#${id}`)),
        fail: (e) => reject(e),
      });
    });

  const routes: RouteDef[] = [
    { path: "/", component: () => el("/") },
    { path: "/a", component: () => el("/a") },
    { path: "/b", component: () => el("/b") },
    { path: "/old", redirect: "/a" },
    {
      path: "/guarded",
      component: () => el("/guarded"),
      // `Guard`, not `NavigationGuard` — returns a verdict, takes no `next`.
      beforeEnter: () => (guardMode === "allow" ? true : guardMode === "reject" ? false : "/a"),
    },
    { path: "/async1", component: deferredComponent("/async1") },
    { path: "/async2", component: deferredComponent("/async2") },
    // Reserved for the terminal consistency check and never chosen by the
    // operation stream. A route the fuzz has failed is legitimately blocked by
    // `ComponentLoader`'s error cache for `errorRetryDelay`, so reusing one for
    // the terminal assertion would fail on correct behaviour.
    { path: "/terminal", component: deferredComponent("/terminal") },
  ];

  const PATHS = ["/", "/a", "/b", "/old", "/guarded", "/async1", "/async2"] as const;
  const router = createRouter(routes, { mode: "history" });
  host.appendChild(Route());

  const unsettledLoads = () => pendingLoads.filter((p) => !p.settled);

  function checkInvariants(step: number, lastOp: string) {
    const ctx = `seed=${seed} step=${step} op=${lastOp}\nlog:\n${log.join("\n")}`;
    const path = router.currentRoute.path;

    // I1: the router's path is always coherent — a rejected guard or a
    // cancelled navigation must not leave a half-applied path.
    expect(typeof path, `I1 path is not a string\n${ctx}`).toBe("string");
    expect(path.startsWith("/"), `I1 incoherent path ${JSON.stringify(path)}\n${ctx}`).toBe(true);

    // I2: a redirect route is a transition, never a destination.
    expect(path, `I2 router settled on a redirect source\n${ctx}`).not.toBe("/old");

    // I3: route context stays internally consistent.
    const rc = router.currentRoute;
    expect(Array.isArray(rc.matched), `I3 matched is not an array\n${ctx}`).toBe(true);
    expect(typeof rc.params, `I3 params missing\n${ctx}`).toBe("object");
    expect(typeof rc.query, `I3 query missing\n${ctx}`).toBe("object");

    // I4 is asserted at the point of navigation, not here: `beforeEnter` runs
    // on ENTRY, so flipping `guardMode` to "reject" while the router is already
    // sitting on /guarded is not a violation — an earlier revision of this file
    // asserted continuously and reported exactly that false positive.

    // I5: THE OUTLET HOLDS AT MOST ONE ROUTE'S CONTENT.
    //
    // Two weaker formulations were tried first and both were WRONG — recorded
    // here so they are not reintroduced (see rc-findings TEST-005):
    //
    //   * "the outlet always shows `router.currentRoute`" — false. The outlet
    //     deliberately keeps the previous element on screen while the next
    //     component loads, instead of blanking. A mismatch is by design.
    //   * "committed async load ids never decrease" — false. `ComponentLoader`
    //     caches a resolved component per route definition, so navigating back
    //     to an earlier route legitimately re-renders content built from an
    //     older load id.
    //
    // What genuinely must hold is that a commit REPLACES rather than
    // ACCUMULATES: two routes' elements must never be in the outlet at once.
    // That is what `cleanupNodes()` exists to guarantee, and a stale commit
    // landing beside a live one violates it.
    const bodies = Array.from(host.querySelectorAll("div")).map((d) => d.textContent ?? "");
    const routeBodies = bodies.filter((t) => /^\/(a|b|guarded|async1|async2)?(#\d+)?$/.test(t));
    expect(
      routeBodies.length,
      `I5 outlet accumulated ${routeBodies.length} route elements: ${JSON.stringify(routeBodies)}\n${ctx}`,
    ).toBeLessThanOrEqual(1);
    if (routeBodies.length === 1 && routeBodies[0].includes("#")) asyncCommits++;
  }

  return (async () => {
    await flush();

    for (let step = 0; step < steps; step++) {
      const op = pick([
        "navigate",
        "navigate",
        "replace",
        "back",
        "forward",
        "settleLoad",
        "settleLoad",
        "failLoad",
        "guardAllow",
        "guardReject",
        "guardRedirect",
      ] as const);
      let desc: string = op;

      switch (op) {
        case "navigate": {
          const to = pick(PATHS);
          if (to === "/guarded" && guardMode === "reject") {
            // I4, asserted where it actually applies: a guard that returns
            // `false` must make the navigation fail rather than commit. Awaited
            // so the verdict is observed on this exact navigation and cannot be
            // confused with a later one.
            const result = await router.push(to).catch(() => null);
            if (result) {
              expect(result.success, `I4 rejected guard reported success (seed=${seed} step=${step})`).toBe(false);
              guardRejectionsObserved++;
            }
            expect(
              router.currentRoute.path,
              `I4 rejected guard committed /guarded (seed=${seed} step=${step})`,
            ).not.toBe("/guarded");
          } else {
            void router.push(to).catch(() => {});
          }
          desc = `navigate ${to}${to === "/guarded" ? ` [guard=${guardMode}]` : ""}`;
          break;
        }
        case "replace": {
          const to = pick(PATHS);
          void router.replace(to).catch(() => {});
          desc = `replace ${to}`;
          break;
        }
        case "back":
          router.back();
          desc = "back";
          break;
        case "forward":
          router.forward();
          desc = "forward";
          break;
        case "settleLoad": {
          const u = unsettledLoads();
          if (!u.length) break;
          const p = pick(u);
          p.settled = true;
          p.settle();
          desc = `settleLoad load${p.id} (${p.path})`;
          break;
        }
        case "failLoad": {
          const u = unsettledLoads();
          if (!u.length) break;
          const p = pick(u);
          p.settled = true;
          p.fail(new Error(`load${p.id} failed`));
          desc = `failLoad load${p.id} (${p.path})`;
          break;
        }
        case "guardAllow":
          guardMode = "allow";
          desc = "guardMode=allow";
          break;
        case "guardReject":
          guardMode = "reject";
          desc = "guardMode=reject";
          break;
        case "guardRedirect":
          guardMode = "redirect";
          desc = "guardMode=redirect";
          break;
      }

      log.push(`${step}: ${desc}`);
      await flush();
      checkInvariants(step, desc);
    }

    // --- terminal drain -----------------------------------------------------
    for (const p of unsettledLoads()) {
      p.settled = true;
      p.settle();
    }
    await flush();
    checkInvariants(steps, "terminal drain");

    // Per-seed vacuity floor: if the outlet never asked for a component, every
    // settle/fail operation was a silent no-op and this seed proved nothing.
    // (`navigate()` does not load components — only the `Route()` outlet does.)
    expect(nextLoad, `seed ${seed} exercised no async component loads — fuzz is vacuous`).toBeGreaterThan(0);

    // TERMINAL CONSISTENCY — the strongest ownership check available.
    // With every load drained and every navigation settled, the outlet must
    // agree with the router. Any stale commit, dropped commit, or wedged
    // navigation shows up here regardless of how the interleaving got there.
    guardMode = "allow";
    void router.push("/terminal").catch(() => {});
    await flush();
    for (const p of unsettledLoads()) {
      p.settled = true;
      p.settle();
    }
    await flush();
    expect(router.currentRoute.path, `terminal: router did not commit /terminal (seed=${seed})`).toBe("/terminal");
    expect(host.textContent, `terminal: outlet disagrees with router (seed=${seed})`).toContain("/terminal#");

    // A settled router must still be a working router.
    await router.push("/b").catch(() => {});
    await flush();
    expect(router.currentRoute.path, `terminal navigation did not commit (seed=${seed})`).toBe("/b");
    expect(host.textContent, `terminal: outlet did not follow to /b (seed=${seed})`).toContain("/b");

    expect(() => destroyRouter()).not.toThrow();
    expect(() => destroyRouter()).not.toThrow();

    return { asyncCommits, guardRejectionsObserved, loads: nextLoad };
  })();
}

describe("client router — seeded model fuzzing", () => {
  const SEEDS = [1, 42, 123456, 999999, 7, 31337];
  const totals = { asyncCommits: 0, guardRejectionsObserved: 0, loads: 0 };

  for (const seed of SEEDS) {
    it(`survives 250 navigation operations under seed ${seed}`, async () => {
      const t = await runSeed(seed, 250);
      totals.asyncCommits += t.asyncCommits;
      totals.guardRejectionsObserved += t.guardRejectionsObserved;
      totals.loads += t.loads;
    });
  }

  // Suite-level vacuity accounting. Any individual seed may legitimately fail
  // to reach a given state within 250 steps, but across the whole seed set both
  // interesting paths must have been exercised — otherwise the invariants above
  // are decoration.
  it("exercised the paths its invariants depend on", () => {
    expect(totals.loads, "no async component loads across any seed").toBeGreaterThan(0);
    expect(totals.asyncCommits, "no async element ever committed — I5 proved nothing").toBeGreaterThan(0);
    expect(
      totals.guardRejectionsObserved,
      "no rejecting guard exercised across any seed — I4 proved nothing",
    ).toBeGreaterThan(0);
  });
});
