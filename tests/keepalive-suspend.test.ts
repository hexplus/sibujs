import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { when } from "../src/core/rendering/directives";
import { dispose } from "../src/core/rendering/dispose";
import { div, input, span } from "../src/core/rendering/html";
import { type LifecycleScope, lifecycleScope } from "../src/core/signals/lifecycleScope";
import { signal } from "../src/core/signals/signal";
import { createRouter, destroyRouter, KeepAliveRoute, navigate, route, Suspense } from "../src/plugins/router";

// ---------------------------------------------------------------------------
// `KeepAliveRoute({ suspendInactive: true })`: a cached page is paused while
// hidden — DOM, state and route context kept, reactive work suspended and
// caught up once when it is shown again. The default keeps it live.
// ---------------------------------------------------------------------------

let host: HTMLElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  dispose(host);
  host.remove();
  destroyRouter();
  vi.restoreAllMocks();
});

const flush = async (turns = 6) => {
  for (let i = 0; i < turns; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const [label, setLabel] = signal("x");

/** A page that counts its binding runs, its scoped effect runs and its hooks. */
function probePage(name: string) {
  const log = { binding: 0, effect: 0, cleanups: 0, hooks: [] as string[], routePaths: [] as string[] };
  let scope!: LifecycleScope;
  let field!: HTMLInputElement;
  const component = () => {
    scope = lifecycleScope();
    scope.effect((onCleanup) => {
      label();
      log.effect++;
      onCleanup(() => log.cleanups++);
    });
    scope.onPause(() => log.hooks.push("pause"));
    scope.onResume(() => log.hooks.push("resume"));
    field = input({ class: `field-${name}` });
    return div({ class: `page-${name}` }, [
      span({ class: "label" }, () => {
        log.binding++;
        log.routePaths.push(route().path);
        return label();
      }),
      field,
    ]);
  };
  return { component, log, scope: () => scope, field: () => field };
}

function setup(options: Parameters<typeof KeepAliveRoute>[0], pages: Record<string, () => Element>) {
  createRouter(
    Object.entries(pages).map(([path, component]) => ({ path, component, name: path.slice(1) })),
    { mode: "memory", url: "/a" },
  );
  const outlet = KeepAliveRoute(options);
  host.appendChild(outlet);
  return outlet;
}

describe("suspendInactive: true", () => {
  it("a hidden page does not react; shown again it keeps its DOM and state, and catches up once", async () => {
    const a = probePage("a");
    setup({ suspendInactive: true }, { "/a": a.component, "/b": () => div("b") });
    await flush();
    const pageA = host.querySelector(".page-a");
    a.field().value = "typed";
    expect(a.log).toMatchObject({ binding: 1, effect: 1 });
    await navigate("/b");
    await flush();
    expect(a.scope().state()).toBe("paused");
    setLabel("y");
    setLabel("z");
    await flush();
    expect(a.log).toMatchObject({ binding: 1, effect: 1, cleanups: 0 });
    await navigate("/a");
    await flush();
    expect(host.querySelector(".page-a")).toBe(pageA);
    expect(a.field().value).toBe("typed");
    expect(a.log).toMatchObject({ binding: 2, effect: 2, cleanups: 1 });
    expect(host.querySelector(".label")?.textContent).toBe("z");
    expect(a.scope().state()).toBe("active");
    expect(a.log.hooks).toEqual(["pause", "resume"]);
  });

  it("the route context is updated before the catch-up, which reads the route it is shown for", async () => {
    const a = probePage("a");
    setup({ suspendInactive: true }, { "/a": a.component, "/b": () => div("b") });
    await flush();
    await navigate("/b");
    await flush();
    setLabel(`r${Math.random()}`);
    await navigate("/a");
    await flush();
    expect(a.log.routePaths).toEqual(["/a", "/a"]);
  });

  it("async work completing while hidden is held, and committed when shown again", async () => {
    const content = deferred<HTMLElement>();
    setup(
      { suspendInactive: true },
      {
        "/a": () => div({ class: "page-a" }, [Suspense({ nodes: () => content.promise })]),
        "/b": () => div("b"),
      },
    );
    await flush();
    const pageA = host.querySelector(".page-a") as HTMLElement;
    await navigate("/b");
    await flush();
    content.resolve(div({ class: "late" }, "late"));
    await flush();
    // Not committed into the hidden page.
    expect(pageA.querySelector(".late")).toBeNull();
    await navigate("/a");
    await flush();
    expect(host.querySelector(".page-a")).toBe(pageA);
    expect(host.querySelector(".page-a .late")).not.toBeNull();
  });

  it("eviction ends a suspended page without a catch-up run", async () => {
    const a = probePage("a");
    setup({ suspendInactive: true, max: 1 }, { "/a": a.component, "/b": () => div("b"), "/c": () => div("c") });
    await flush();
    await navigate("/b");
    await flush();
    setLabel(`e${Math.random()}`);
    await navigate("/c"); // evicts /a
    await flush();
    expect(a.scope().state()).toBe("ended");
    expect(a.log).toMatchObject({ binding: 1, effect: 1, cleanups: 1 });
  });

  it("outlet disposal ends a suspended page without a catch-up run", async () => {
    const a = probePage("a");
    const outlet = setup({ suspendInactive: true }, { "/a": a.component, "/b": () => div("b") });
    await flush();
    await navigate("/b");
    await flush();
    setLabel(`d${Math.random()}`);
    dispose(outlet);
    await flush();
    expect(a.scope().state()).toBe("ended");
    expect(a.log).toMatchObject({ binding: 1, effect: 1, cleanups: 1 });
  });

  it("include / exclude: a page that is not cached is disposed as before", async () => {
    const a = probePage("a");
    setup({ suspendInactive: true, include: ["b"] }, { "/a": a.component, "/b": () => div("b") });
    await flush();
    await navigate("/b");
    await flush();
    expect(a.scope().state()).toBe("ended");
    expect(host.querySelector(".page-a")).toBeNull();
  });

  it("inside a paused branch, showing the cached page does not resume it until the branch resumes", async () => {
    const a = probePage("a");
    createRouter(
      [
        { path: "/a", component: a.component },
        { path: "/b", component: () => div("b") },
      ],
      { mode: "memory", url: "/a" },
    );
    const [outer, setOuter] = signal(true);
    let shell: HTMLElement | null = null;
    host.appendChild(
      when(
        outer,
        () => (shell ??= div({ class: "shell" }, [KeepAliveRoute({ suspendInactive: true })])),
        () => span("other"),
        { transition: { leave: () => new Promise<void>(() => {}) } },
      ),
    );
    await flush();
    await navigate("/b");
    await flush();
    setOuter(false); // the branch holding the outlet pauses
    await navigate("/a");
    setLabel(`n${Math.random()}`);
    await flush();
    expect(a.log).toMatchObject({ binding: 1, effect: 1 });
    expect(a.scope().state()).toBe("paused");
    setOuter(true);
    await flush();
    expect(host.querySelector(".page-a")).not.toBeNull();
    expect(a.scope().state()).toBe("active");
    expect(a.log).toMatchObject({ binding: 2, effect: 2 });
  });
});

describe("default: cached pages stay live", () => {
  it("a hidden page keeps reacting, as before", async () => {
    const a = probePage("a");
    setup(undefined, { "/a": a.component, "/b": () => div("b") });
    await flush();
    await navigate("/b");
    await flush();
    setLabel(`l${Math.random()}`);
    await flush();
    expect(a.log.effect).toBe(2);
    expect(a.scope().state()).toBe("active");
    expect(a.log.hooks).toEqual([]);
  });
});
