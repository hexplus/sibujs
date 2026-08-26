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
import { mutation } from "../../src/data/mutation";
import { query } from "../../src/data/query";
import { normalize, normalizedStore } from "../../src/performance/normalize";
import type { AsyncComponent, Component, LazyComponent, RouteDef } from "../../src/plugins/router";
import { createMemoryRouter, createRouter } from "../../src/plugins/router";
import { eventBus } from "../../src/ui/eventBus";

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
});
