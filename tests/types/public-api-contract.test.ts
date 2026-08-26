// Compile-time contract tests for the public API.
//
// These assert what SibuJS's TYPE DECLARATIONS permit, which is a different
// question from what its runtime does. The RC certification found the two had
// drifted apart in both directions: tests calling APIs in ways the types forbid
// (`retry: 0`), and types forbidding usage the runtime handles perfectly
// (an `interface` event map). Either direction weakens the evidence a test
// provides, because a test can only say something about the public API if it
// uses that API the way a typed consumer would.
//
// The file is a real vitest file so it shows up in the suite, but its value is
// the compile: `npm run typecheck:tests` fails if any of these stop holding.
// Negative cases use `@ts-expect-error`, which fails the build if the error
// STOPS occurring — so a constraint that is later relaxed cannot silently drift.
import { describe, expect, it } from "vitest";
import { action, copyOnClick } from "../../src/core/rendering/action";
import { input } from "../../src/core/rendering/html";
import { mutation } from "../../src/data/mutation";
import { query } from "../../src/data/query";
import type { defineComponent } from "../../src/patterns/componentProps";
import type { validateProps } from "../../src/patterns/contracts";
import type { withDefaults } from "../../src/patterns/hoc";
import type { machine } from "../../src/patterns/machine";
import { normalize, normalizedStore } from "../../src/performance/normalize";
import type { createSharedScope } from "../../src/platform/microfrontend";
import type { wasm } from "../../src/platform/wasm";
import type { AsyncComponent, Component, LazyComponent, RouteDef } from "../../src/plugins/router";
import { createMemoryRouter, createRouter } from "../../src/plugins/router";
import { eventBus } from "../../src/ui/eventBus";
import { bindField, form } from "../../src/ui/form";

/** Compile-time assertion helper — no runtime cost, no new dependency. */
const expectType = <T>(_value: T): void => undefined;

// ---------------------------------------------------------------------------
// eventBus — an event map declared as an `interface`
// ---------------------------------------------------------------------------
interface AppEvents {
  message: string;
  tick: number;
  payload: { id: number };
}

// A `type` alias gets an implicit index signature; an `interface` does not.
// Both are idiomatic ways to declare an event map, so both must be accepted.
type AppEventsAlias = {
  message: string;
  tick: number;
};

// ---------------------------------------------------------------------------
// normalize — an entity declared as an `interface`
// ---------------------------------------------------------------------------
interface User {
  id: string;
  name: string;
}

describe("public API type contracts", () => {
  it("eventBus accepts an interface event map", () => {
    const bus = eventBus<AppEvents>();
    bus.on("message", (data) => expectType<string>(data));
    bus.on("tick", (data) => expectType<number>(data));
    bus.on("payload", (data) => expectType<{ id: number }>(data));
    bus.emit("message", "hello");
    bus.emit("tick", 1);

    const aliased = eventBus<AppEventsAlias>();
    aliased.emit("message", "hello");

    // Key and payload types are still enforced.
    // @ts-expect-error "nope" is not a declared event
    bus.on("nope", () => {});
    // @ts-expect-error "tick" carries a number, not a string
    bus.emit("tick", "not-a-number");

    expect(typeof bus.clear).toBe("function");
  });

  it("normalize accepts an interface entity", () => {
    const user: User = { id: "1", name: "Ada" };
    const result = normalize<User>(user, { name: "users" });
    expect(result.entities.users).toBeTruthy();

    const store = normalizedStore<User>({ name: "users" });
    store.add(user);
    expectType<User | undefined>(store.get("1"));
    expectType<User[]>(store.getAll());
    store.update("1", { name: "Grace" });
    expect(typeof store.remove).toBe("function");
  });

  it("query options accept every documented valid shape", () => {
    const fetcher = async () => "value";

    query("k1", fetcher);
    query("k2", fetcher, { staleTime: 0, cacheTime: 300_000, enabled: false });
    query("k3", fetcher, { retry: { maxRetries: 0 } });
    query("k4", fetcher, {
      retry: { maxRetries: 3, strategy: "exponential", baseDelay: 100, shouldRetry: () => true },
    });
    // A key may be a function, for a reactive key.
    query(() => "k5", fetcher);

    // `retry` is a RetryOptions object, not a count. This is the exact misuse
    // that survived into a test before `tests/` was type-checked: `0` reads as
    // "no retries" but evaluates to `maxRetries ?? 3`.
    // @ts-expect-error retry is RetryOptions, not a number
    query("k6", fetcher, { retry: 0 });
    // @ts-expect-error staleTime is a number of milliseconds
    query("k7", fetcher, { staleTime: "0" });
    // @ts-expect-error unknown options are rejected
    query("k8", fetcher, { retires: 3 });

    expect(true).toBe(true);
  });

  it("query infers its data type through select", () => {
    const q = query("typed", async () => ({ count: 1 }));
    expectType<{ count: number } | undefined>(q.data());
    expectType<boolean>(q.loading());
    expectType<Error | undefined>(q.error());
  });

  it("mutation options and callbacks are typed", () => {
    const m = mutation(async (input: { name: string }) => ({ id: 1, name: input.name }));
    // `mutate` is fire-and-forget; `mutateAsync` is the awaitable form.
    expectType<(variables: { name: string }) => void>(m.mutate);
    expectType<(variables: { name: string }) => Promise<{ id: number; name: string }>>(m.mutateAsync);
    expectType<{ id: number; name: string } | undefined>(m.data());
    expectType<boolean>(m.isIdle());
    expectType<boolean>(m.isSuccess());

    // @ts-expect-error the mutation input is { name: string }
    void m.mutate({ nome: "typo" });

    expect(typeof m.reset).toBe("function");
  });

  it("AsyncComponent accepts a plain promise-returning function", () => {
    // RC-003: the runtime classifies by RESULT, not by `async` syntax, so a
    // plain arrow returning a promise must satisfy the published type too.
    const plain: AsyncComponent = () => Promise.resolve(document.createElement("div"));
    const asyncFn: AsyncComponent = async () => document.createElement("div");
    const sync: Component = () => document.createElement("div");
    const lazy: LazyComponent = () => Promise.resolve({ default: () => document.createElement("div") });

    // All four forms must be assignable to a route definition.
    const routes: RouteDef[] = [
      { path: "/sync", component: sync },
      { path: "/plain", component: plain },
      { path: "/async", component: asyncFn },
      { path: "/lazy", component: lazy },
      { path: "/shorthand", lazy: () => Promise.resolve({ default: sync }) },
      { path: "/redirect", redirect: "/sync" },
    ];
    expect(routes).toHaveLength(6);
  });

  it("createRouter and createMemoryRouter have usable signatures", () => {
    const routes: RouteDef[] = [{ path: "/", component: () => document.createElement("div") }];

    const router = createRouter(routes, { mode: "history" });
    expectType<string>(router.currentRoute.path);
    expectType<boolean>(router.isReady);

    // Advertised for testing/SSR — must be constructible from a server-oriented
    // project without extra ceremony.
    const memory = createMemoryRouter(routes, "/");
    expectType<string>(memory.currentPath());
    void memory.push("/").then((r) => {
      // The result is a discriminated union; `route` is only present on success.
      if (r.success) expectType<string>(r.route.path);
      else expectType<string>(r.type);
    });

    // @ts-expect-error a route needs a path
    const bad: RouteDef[] = [{ component: () => document.createElement("div") }];
    void bad;

    router.destroy?.();
  });
  it("4.0 widened generics accept an interface (TYPE-002)", () => {
    // Every one of these rejected an `interface` before 4.0, because the
    // constraint was `Record<string, unknown>` and an interface has no implicit
    // index signature. The runtime always accepted them. Widening to
    // `T extends object` is backwards-compatible: it accepts strictly more, so
    // nothing that compiled against 3.x stops compiling.
    interface Ctx extends Record<string, unknown> {
      count: number;
    }
    interface PlainCtx {
      count: number;
    }
    interface Props {
      title: string;
    }
    interface Shared {
      user: string;
    }
    interface WasmExports {
      add: (a: number, b: number) => number;
    }

    // The OLD style (an interface that explicitly extends the index signature)
    // must keep working — this is the migration-compatibility half.
    type StillWorks = typeof machine<"idle" | "busy", "go", Ctx>;
    // The NEW style — a plain interface — is what used to fail.
    type NowWorks = typeof machine<"idle" | "busy", "go", PlainCtx>;
    type Components = typeof defineComponent<Props>;
    type Scope = typeof createSharedScope<Shared>;
    type Wasm = typeof wasm<WasmExports>;
    type Defaults = typeof withDefaults<Props>;
    type Contracts = typeof validateProps<Props>;

    expectType<StillWorks | undefined>(undefined);
    expectType<NowWorks | undefined>(undefined);
    expectType<Components | undefined>(undefined);
    expectType<Scope | undefined>(undefined);
    expectType<Wasm | undefined>(undefined);
    expectType<Defaults | undefined>(undefined);
    expectType<Contracts | undefined>(undefined);
    expect(true).toBe(true);
  });

  it("an action with an optional param can be applied without one (TYPE-009)", () => {
    const el = document.createElement("div");

    // `copyOnClick` is `ActionFn<(() => string) | undefined>` — its text getter
    // is optional. Before 4.0 the two-argument overload demanded
    // `ActionFn<void>`, so this did not compile despite being the documented
    // usage and exactly what the runtime does.
    action(el, copyOnClick);

    // The explicit three-argument form keeps working — the overload is additive.
    action(el, copyOnClick, undefined);
    action(el, copyOnClick, () => "custom");

    expect(el).toBeTruthy();
  });

  it("bindField preserves the field's value type (TYPE-010)", () => {
    const f = form({ name: { initial: "ada" } });
    const bound = bindField(f.fields.name);

    // Was `() => unknown`, which forced a cast at every call site even though
    // the helper documents itself as returning props ready for a tag factory.
    expectType<() => string>(bound.value);

    // And it now spreads onto a typed tag factory with no cast at all.
    const el = input(bindField(f.fields.name));
    expect(el.tagName).toBe("INPUT");

    // Residual, deliberately not fixed: a `<select multiple>` binds `string[]`
    // while `SelectProps.value` is `reactive<string>`. Modelling multi-select in
    // the tag-factory prop types is a wider change. See final-pre-rc-findings.
    const multi = form({ tags: { initial: ["a"] as string[] } });
    expectType<() => string[]>(bindField(multi.fields.tags).value);
  });
});
