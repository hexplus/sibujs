import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Scenarios run against BUILT public entry points (see
// `entrypoint-interop-cjs.test.ts` and `entrypoint-interop-esm.test.ts`): core
// directives from `sibujs`, router components from `sibujs/plugins`. Nothing
// here imports source — the types below are type-only.
//
// Each CommonJS entry point is bundled on its own, so `sibujs` and
// `sibujs/plugins` each carry a copy of the rendering modules. A core
// directive must still find the range a plugin renders, wait for the content
// a plugin registers as pending, and run the teardown a plugin registered on
// its anchor — exactly once, with nothing reacting afterwards.
// ---------------------------------------------------------------------------

type Core = typeof import("../index");
type Plugins = typeof import("../plugins");
export interface Entrypoints {
  core: Core;
  plugins: Plugins;
}

/** The shared readiness bookkeeping (see src/core/rendering/range.ts), read for leak checks. */
interface RangeState {
  registrations: Set<unknown>;
  listeners: Set<unknown>;
}
const rangeState = () => (globalThis as Record<symbol, unknown>)[Symbol.for("sibujs.ranges.v1")] as RangeState;

const flush = async (turns = 8) => {
  for (let i = 0; i < turns; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

export function interopSuite(label: string, load: () => Promise<Entrypoints>): void {
  describe(label, () => {
    let core!: Core;
    let plugins!: Plugins;
    let host!: HTMLElement;
    let registrations = 0;
    let listeners = 0;

    beforeAll(async () => {
      ({ core, plugins } = await load());
    });

    beforeEach(() => {
      host = document.createElement("div");
      document.body.appendChild(host);
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      registrations = rangeState()?.registrations.size ?? 0;
      listeners = rangeState()?.listeners.size ?? 0;
    });

    afterEach(() => {
      core.dispose(host);
      host.remove();
      plugins.destroyRouter();
      vi.restoreAllMocks();
    });

    /** Nothing registered as pending or listening is left behind. */
    const expectReleased = () => {
      expect(rangeState().registrations.size).toBe(registrations);
      expect(rangeState().listeners.size).toBe(listeners);
    };

    /** A page whose root carries a disposer and a binding on `label`. */
    function page(cls: string) {
      const [label, setLabel] = core.signal(cls);
      const stats = { factory: vi.fn(), cleanup: vi.fn(), runs: 0 };
      const component = () => {
        stats.factory();
        const el = core.div({ class: cls }, () => {
          stats.runs++;
          return label();
        });
        core.registerDisposer(el, stats.cleanup);
        return el;
      };
      return { component, setLabel, stats };
    }

    it("a core when() waits for a plugin Suspense's content before its custom enter", async () => {
      const [on, setOn] = core.signal(false);
      const content = deferred<HTMLElement>();
      const seen: boolean[] = [];
      const enter = vi.fn(() => {
        seen.push(host.querySelector(".content") !== null);
      });
      host.appendChild(
        core.when(
          on,
          () =>
            core.Fragment([core.span({ class: "heading" }, "h"), plugins.Suspense({ nodes: () => content.promise })]),
          { transition: { enter, waitForContent: 1000 } },
        ),
      );
      await flush();
      setOn(true);
      await flush();
      expect(enter).not.toHaveBeenCalled();
      content.resolve(core.div({ class: "content" }, "content"));
      await flush();
      expect(enter).toHaveBeenCalledTimes(1);
      expect(seen).toEqual([true]);
      expectReleased();
    });

    it("a core when() containing a Route removes and disposes its page, once, when switched off", async () => {
      const a = page("page-a");
      const b = page("page-b");
      plugins.createRouter(
        [
          { path: "/a", component: a.component },
          { path: "/b", component: b.component },
        ],
        { mode: "memory", url: "/a" },
      );
      const [on, setOn] = core.signal(true);
      host.appendChild(
        core.when(
          on,
          () => plugins.Route(),
          () => core.span({ class: "off" }, "off"),
        ),
      );
      await flush();
      expect(host.querySelector(".page-a")).not.toBeNull();
      setOn(false);
      await flush();
      expect(host.querySelector(".page-a")).toBeNull();
      expect(host.querySelector(".off")).not.toBeNull();
      expect(a.stats.cleanup).toHaveBeenCalledTimes(1);
      // The removed outlet renders nothing more, and its page reacts no more.
      const runs = a.stats.runs;
      a.setLabel("changed");
      await plugins.navigate("/b");
      await flush();
      expect(b.stats.factory).not.toHaveBeenCalled();
      expect(host.querySelector(".page-b")).toBeNull();
      expect(a.stats.runs).toBe(runs);
      expect(a.stats.cleanup).toHaveBeenCalledTimes(1);
      expectReleased();
    });

    it("a core match() case rendering a plugin range is removed and disposed with the case", async () => {
      const content = page("content");
      const [key, setKey] = core.signal<"a" | "b">("a");
      host.appendChild(
        core.match(key, {
          a: () => plugins.Suspense({ nodes: () => Promise.resolve(content.component()) }),
          b: () => core.span({ class: "b" }, "b"),
        }),
      );
      await flush();
      expect(host.querySelector(".content")).not.toBeNull();
      setKey("b");
      await flush();
      expect(host.querySelector(".content")).toBeNull();
      expect(host.querySelector(".b")).not.toBeNull();
      expect(content.stats.cleanup).toHaveBeenCalledTimes(1);
      const runs = content.stats.runs;
      content.setLabel("changed");
      await flush();
      expect(content.stats.runs).toBe(runs);
      expectReleased();
    });

    it("nested outlets in a fragment branch are removed and disposed, once each", async () => {
      const layoutCleanup = vi.fn();
      const child = page("child");
      plugins.createRouter(
        [
          {
            path: "/l",
            component: () => {
              const el = core.div({ class: "layout" }, plugins.Outlet());
              core.registerDisposer(el, layoutCleanup);
              return el;
            },
            children: [{ path: "/c", component: child.component }],
          },
        ],
        { mode: "memory", url: "/l/c" },
      );
      const [on, setOn] = core.signal(true);
      host.appendChild(core.when(on, () => core.Fragment([core.span({ class: "heading" }, "h"), plugins.Route()])));
      await flush();
      expect(host.querySelector(".layout .child")).not.toBeNull();
      setOn(false);
      await flush();
      expect(host.querySelector(".layout")).toBeNull();
      expect(host.querySelector(".heading")).toBeNull();
      expect(layoutCleanup).toHaveBeenCalledTimes(1);
      expect(child.stats.cleanup).toHaveBeenCalledTimes(1);
      const runs = child.stats.runs;
      child.setLabel("changed");
      await flush();
      expect(child.stats.runs).toBe(runs);
      expect(child.stats.factory).toHaveBeenCalledTimes(1);
      expectReleased();
    });

    it("a Route removed while its page loads never inserts it; the late page is disposed once", async () => {
      const gate = deferred();
      const p = page("late");
      plugins.createRouter(
        [
          {
            path: "/a",
            component: async () => {
              await gate.promise;
              return p.component();
            },
          },
        ],
        { mode: "memory", url: "/a" },
      );
      const [on, setOn] = core.signal(true);
      host.appendChild(core.when(on, () => core.Fragment([plugins.Route()])));
      await flush();
      setOn(false);
      await flush();
      gate.resolve();
      await flush();
      expect(document.querySelector(".late")).toBeNull();
      expect(p.stats.cleanup.mock.calls.length).toBe(p.stats.factory.mock.calls.length);
      expectReleased();
    });

    it("a plugin Suspense removed while pending never inserts its content; it is disposed once", async () => {
      const content = deferred<HTMLElement>();
      const p = page("late");
      const [on, setOn] = core.signal(true);
      host.appendChild(core.when(on, () => plugins.Suspense({ nodes: () => content.promise })));
      await flush();
      setOn(false);
      await flush();
      content.resolve(p.component());
      await flush();
      expect(document.querySelector(".late")).toBeNull();
      expect(p.stats.cleanup).toHaveBeenCalledTimes(1);
      expectReleased();
    });

    it("disposing a plugin anchor through core dispose() runs the plugin's teardown", async () => {
      const a = page("page-a");
      plugins.createRouter([{ path: "/a", component: a.component }], { mode: "memory", url: "/a" });
      const anchor = plugins.Route();
      host.appendChild(anchor);
      await flush();
      expect(host.querySelector(".page-a")).not.toBeNull();
      core.dispose(anchor);
      expect(host.querySelector(".page-a")).toBeNull();
      expect(a.stats.cleanup).toHaveBeenCalledTimes(1);
      core.dispose(anchor);
      expect(a.stats.cleanup).toHaveBeenCalledTimes(1);
      expectReleased();
    });
  });
}
