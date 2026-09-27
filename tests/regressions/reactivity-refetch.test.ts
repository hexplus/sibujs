/**
 * Background refreshes must not wipe half-typed forms.
 *
 * The reported scenario: a form rendered under `when(() => q.data(), () => Form())`
 * (or the child-getter form `() => q.data() && Form()`) lost whatever the user
 * was typing every time the query refreshed in the background. `when()`
 * rebuilds when its condition's value changes, and `query()` committed a fresh
 * reference on every refetch, even for an identical payload — so every
 * subscriber of `data` re-ran; with `select` the fetching observer was even
 * notified twice per fetch.
 *
 * Invariants under test:
 *  - An identical fetched payload — from `refetch()`, `refetchInterval`, window
 *    focus, reconnect or `invalidateQueries()` — keeps the previous `data`
 *    reference and notifies nobody; the typed-into input survives untouched.
 *  - `when()` still rebuilds when its condition becomes a different value.
 *  - A changed payload keeps every unchanged nested reference.
 *  - An explicit write (`setQueryData`, `resource.mutate`) of a new top-level
 *    reference always notifies, even after an in-place edit.
 *  - Each observer's `structuralSharing` governs only that observer, and
 *    sharing never reconciles across keys.
 *  - `select` notifies exactly once per fetch, for the owner and for waiters,
 *    and re-runs when a signal it reads changes — without refetching.
 *  - Cyclic data never overflows the stack.
 *  - `resource()` shares structure across refetches the same way.
 *  - Neither directive branches nor `select` leak their reads into the
 *    enclosing reactive scope.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { match, when } from "../../src/core/rendering/directives";
import { div, input, span } from "../../src/core/rendering/html";
import { effect } from "../../src/core/signals/effect";
import { signal } from "../../src/core/signals/signal";
import {
  __resetQueryCache,
  getQueryData,
  invalidateQueries,
  type QueryOptions,
  type QueryResult,
  query,
  setQueryData,
} from "../../src/data/query";
import { resource } from "../../src/data/resource";
import { replaceEqualDeep } from "../../src/data/structuralSharing";

const tick = () => new Promise((r) => setTimeout(r, 0));
// Reactive bindings commit synchronously; when()/match() defer their FIRST
// render to a microtask.
const flushMicrotasks = () => Promise.resolve().then(() => Promise.resolve());

interface User {
  id: number;
  name: string;
  roles: Array<{ id: string }>;
}

/** A structurally identical payload, as a brand-new object graph every call. */
const payload = (): User => ({ id: 1, name: "Ada", roles: [{ id: "admin" }, { id: "editor" }] });

const Form = () => div({ class: "form" }, [input({ id: "draft", type: "text" })]);

const disposers: Array<() => void> = [];

function track<T>(q: QueryResult<T>): QueryResult<T> {
  disposers.push(q.dispose);
  return q;
}

/** Count how many times `read` notifies, excluding the effect's initial run. */
function countNotifications(read: () => unknown): () => number {
  let runs = 0;
  disposers.push(
    effect(() => {
      read();
      runs++;
    }),
  );
  return () => runs - 1;
}

beforeEach(() => {
  __resetQueryCache();
  document.body.innerHTML = "";
});

afterEach(() => {
  while (disposers.length) disposers.pop()?.();
  __resetQueryCache();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// The user's scenario, end to end
// ---------------------------------------------------------------------------

type Trigger = {
  name: string;
  options?: QueryOptions<User>;
  fire: (key: string, q: QueryResult<User>) => Promise<void>;
};

const triggers: Trigger[] = [
  {
    name: "refetch()",
    fire: async (_key, q) => {
      await q.refetch();
    },
  },
  {
    name: "refetchInterval",
    options: { refetchInterval: 10 },
    fire: async () => {
      // Wait out two intervals' worth of background refreshes.
      await new Promise((r) => setTimeout(r, 35));
      await tick();
    },
  },
  {
    name: "window focus",
    options: { refetchOnWindowFocus: true },
    fire: async () => {
      globalThis.dispatchEvent(new Event("focus"));
      await tick();
    },
  },
  {
    name: "reconnect",
    options: { refetchOnReconnect: true },
    fire: async () => {
      globalThis.dispatchEvent(new Event("online"));
      await tick();
    },
  },
  {
    name: "invalidateQueries()",
    fire: async (key) => {
      invalidateQueries(key);
      await tick();
    },
  },
];

const variants: Array<{ name: string; render: (q: QueryResult<User>) => HTMLElement }> = [
  {
    name: "when(() => q.data(), () => Form())",
    render: (q) =>
      div([
        when(
          () => q.data(),
          () => Form(),
        ),
      ]),
  },
  { name: "() => q.data() && Form()", render: (q) => div(() => q.data() && Form()) },
];

describe("regression: a background refresh with an identical payload keeps a half-typed form", () => {
  for (const variant of variants) {
    for (const trigger of triggers) {
      it(`regression: ${variant.name} survives ${trigger.name}`, async () => {
        const key = `form:${variant.name}:${trigger.name}`;
        const fetcher = vi.fn(async () => payload());
        const q = track(query(key, fetcher, trigger.options));
        await tick();

        const host = variant.render(q);
        document.body.appendChild(host);
        await flushMicrotasks();

        const field = host.querySelector<HTMLInputElement>("#draft");
        expect(field).not.toBeNull();
        (field as HTMLInputElement).value = "half-typ";
        field?.dispatchEvent(new Event("input"));
        const before = q.data();
        const callsBefore = fetcher.mock.calls.length;

        await trigger.fire(key, q);
        await flushMicrotasks();

        // The trigger really did deliver a new result.
        expect(fetcher.mock.calls.length).toBeGreaterThan(callsBefore);
        expect(q.data()).toBe(before);
        const after = host.querySelector<HTMLInputElement>("#draft");
        expect(after).toBe(field);
        expect(after?.value).toBe("half-typ");
      });
    }
  }
});

// ---------------------------------------------------------------------------
// when(): the condition's value, compared by identity
// ---------------------------------------------------------------------------

describe("when() rebuilds when its condition's value changes", () => {
  it("an identical background refetch keeps the form under when(() => q.data(), …) via structural sharing", async () => {
    const q = track(query("when:identical", async () => payload()));
    await tick();
    const factory = vi.fn(() => Form());
    const host = div([when(() => q.data(), factory)]);
    document.body.appendChild(host);
    await flushMicrotasks();
    const field = host.querySelector<HTMLInputElement>("#draft") as HTMLInputElement;
    field.value = "half-typ";

    await q.refetch();
    await q.refetch();
    await flushMicrotasks();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(host.querySelector("#draft")).toBe(field);
    expect(field.value).toBe("half-typ");
  });

  it("regression: switching from one truthy record to another rebuilds with the new value", async () => {
    const [selectedUser, setSelectedUser] = signal<User | null>({ ...payload(), name: "Ada" });
    const UserCard = (user: User) => div({ class: "card" }, user.name);
    const host = div([
      when(
        () => selectedUser(),
        () => UserCard(selectedUser() as User),
      ),
    ]);
    document.body.appendChild(host);
    await flushMicrotasks();
    expect(host.textContent).toBe("Ada");

    setSelectedUser({ ...payload(), id: 2, name: "Grace" });
    await flushMicrotasks();
    expect(host.textContent).toBe("Grace");

    // A flip to falsy and back still switches branches.
    setSelectedUser(null);
    await flushMicrotasks();
    expect(host.querySelector(".card")).toBeNull();
    setSelectedUser({ ...payload(), id: 3, name: "Edsger" });
    await flushMicrotasks();
    expect(host.textContent).toBe("Edsger");
  });

  it("regression: a query switching to a different record rebuilds when(() => q.data(), …)", async () => {
    const [id, setId] = signal(1);
    const q = track(
      query(
        () => `when:record:${id()}`,
        async ({ key }) => ({ ...payload(), id: Number(key.split(":")[2]), name: key.endsWith("1") ? "Ada" : "Grace" }),
      ),
    );
    await tick();
    const host = div([
      when(
        () => q.data(),
        () => span((q.data() as User).name),
      ),
    ]);
    document.body.appendChild(host);
    await flushMicrotasks();
    expect(host.textContent).toBe("Ada");

    setId(2);
    await tick();
    await flushMicrotasks();
    expect(q.data()?.name).toBe("Grace");
    expect(host.textContent).toBe("Grace");
  });

  it("regression: a signal read eagerly inside a when() branch does not re-run the condition", async () => {
    const [on, setOn] = signal(false);
    const [label, setLabel] = signal("a");
    const condition = vi.fn(() => on());
    const host = div([when(condition, () => span(`label ${label()}`))]);
    document.body.appendChild(host);
    await flushMicrotasks();
    // The FIRST render runs from a microtask, outside the binding; a flip runs
    // the branch factory inside the condition's own reactive run.
    setOn(true);
    await flushMicrotasks();
    expect(host.textContent).toBe("label a");
    const runs = condition.mock.calls.length;

    setLabel("b");
    await flushMicrotasks();
    expect(condition.mock.calls.length).toBe(runs);
  });

  it("regression: a signal read eagerly inside a match() case does not re-run the selector", async () => {
    const [mode, setMode] = signal<"a" | "b">("b");
    const [label, setLabel] = signal("x");
    const selector = vi.fn(() => mode());
    const host = div([match(selector, { a: () => span(`a ${label()}`), b: () => span("b") })]);
    document.body.appendChild(host);
    await flushMicrotasks();
    setMode("a");
    await flushMicrotasks();
    expect(host.textContent).toBe("a x");
    const runs = selector.mock.calls.length;

    setLabel("y");
    await flushMicrotasks();
    expect(selector.mock.calls.length).toBe(runs);
  });
});

// ---------------------------------------------------------------------------
// query(): structural sharing
// ---------------------------------------------------------------------------

describe("query() structural sharing", () => {
  it("regression: an identical refetch does not notify data subscribers", async () => {
    const q = track(query("share:identical", async () => payload()));
    await tick();
    const notifications = countNotifications(() => q.data());
    const before = q.data();

    await q.refetch();
    await q.refetch();
    expect(q.data()).toBe(before);
    expect(getQueryData("share:identical")).toBe(before);
    expect(notifications()).toBe(0);
  });

  it("regression: a changed payload keeps every unchanged nested reference", async () => {
    let version = 0;
    const q = track(
      query("share:partial", async () => ({
        profile: { name: "Ada" },
        settings: { theme: version === 0 ? "dark" : "light" },
        items: [{ id: 1 }, { id: 2, qty: version === 0 ? 1 : 5 }, { id: 3 }],
      })),
    );
    await tick();
    const before = q.data();
    if (!before) throw new Error("expected data");

    version = 1;
    await q.refetch();
    const after = q.data();
    if (!after) throw new Error("expected data");

    expect(after).not.toBe(before);
    expect(after.profile).toBe(before.profile);
    expect(after.settings).not.toBe(before.settings);
    expect(after.settings.theme).toBe("light");
    expect(after.items).not.toBe(before.items);
    expect(after.items[0]).toBe(before.items[0]);
    expect(after.items[1]).not.toBe(before.items[1]);
    expect(after.items[2]).toBe(before.items[2]);
  });

  it("two observers of one key hold the SAME shared reference", async () => {
    let version = 0;
    const fetcher = async () => ({ a: { x: 1 }, b: { y: version } });
    const q1 = track(query("share:observers", fetcher));
    const q2 = track(query("share:observers", fetcher));
    await tick();

    version = 1;
    await q1.refetch();
    await tick();
    expect(q1.data()).toBe(q2.data());
    expect(q1.data()).toBe(getQueryData("share:observers"));
  });

  it("compares Date, Map and class instances by identity, never structurally", async () => {
    class Point {
      constructor(public x: number) {}
    }
    const q = track(query("share:opaque", async () => ({ when: new Date(0), point: new Point(1), tags: new Map() })));
    await tick();
    const before = q.data();
    if (!before) throw new Error("expected data");

    await q.refetch();
    const after = q.data();
    if (!after) throw new Error("expected data");
    expect(after).not.toBe(before);
    expect(after.when).not.toBe(before.when);
    expect(after.point).not.toBe(before.point);
    expect(after.point).toBeInstanceOf(Point);
    expect(after.tags).toBeInstanceOf(Map);
  });

  it("structuralSharing: false commits every result as-is", async () => {
    const q = track(query("share:off", async () => payload(), { structuralSharing: false }));
    await tick();
    const notifications = countNotifications(() => q.data());
    const before = q.data();

    await q.refetch();
    expect(q.data()).not.toBe(before);
    expect(notifications()).toBe(1);
  });

  it("a custom structuralSharing function decides what is committed", async () => {
    let version = 1;
    const sharing = vi.fn((prev: { version: number; at: number }, next: { version: number; at: number }) =>
      prev.version === next.version ? prev : next,
    );
    const q = track(
      query("share:custom", async () => ({ version, at: Math.random() }), { structuralSharing: sharing }),
    );
    await tick();
    const notifications = countNotifications(() => q.data());
    const before = q.data();

    await q.refetch();
    expect(q.data()).toBe(before);
    expect(notifications()).toBe(0);

    version = 2;
    await q.refetch();
    expect(q.data()?.version).toBe(2);
    expect(notifications()).toBe(1);
    expect(sharing).toHaveBeenCalled();
  });

  it("a throwing custom structuralSharing is reported, and the fetch still succeeds unshared", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const onError = vi.fn();
    const q = track(
      query("share:throws", async () => payload(), {
        onError,
        structuralSharing: () => {
          throw new Error("sharing broke");
        },
      }),
    );
    await tick();
    await q.refetch();
    expect(q.error()).toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
    expect(q.data()?.name).toBe("Ada");
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it("onSuccess receives the shared value this observer holds", async () => {
    const received: User[] = [];
    const q = track(query("share:onSuccess", async () => payload(), { onSuccess: (d) => received.push(d) }));
    await tick();
    await q.refetch();
    expect(received).toHaveLength(2);
    expect(received[1]).toBe(q.data());
    expect(received[1]).toBe(received[0]);
  });

  // Guard for the sharing change itself: `isStale` used to recompute only off
  // `data()`, which an identical refetch no longer touches.
  it("isStale still turns fresh after an identical refetch", async () => {
    vi.useFakeTimers();
    const fetcher = async () => payload();
    const seed = query("share:stale", fetcher, { staleTime: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    const cached = getQueryData("share:stale");
    seed.dispose();

    await vi.advanceTimersByTimeAsync(1500);
    // Mounts on the aged entry: stale, so it refetches — the same payload.
    const q = track(query("share:stale", fetcher, { staleTime: 1000 }));
    expect(q.isStale()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(q.data()).toBe(cached);
    expect(q.isStale()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Explicit writes: setQueryData() and resource.mutate()
// ---------------------------------------------------------------------------

interface Todos {
  items: Array<{ id: number }>;
  meta: { owner: string };
}

const todos = (): Todos => ({ items: [{ id: 1 }, { id: 2 }], meta: { owner: "ada" } });

describe("explicit writes commit a new reference when given one", () => {
  it("regression: setQueryData with an in-place edit and a shallow copy notifies", async () => {
    const q = track(query("explicit:inplace", async () => todos()));
    await tick();
    const notifications = countNotifications(() => q.data());
    const before = q.data();

    setQueryData<Todos>("explicit:inplace", (prev) => {
      (prev as Todos).items.push({ id: 3 });
      return { ...(prev as Todos) };
    });
    expect(notifications()).toBe(1);
    expect(q.data()).not.toBe(before);
    expect(q.data()?.items).toHaveLength(3);
    expect(getQueryData("explicit:inplace")).toBe(q.data());
  });

  it("regression: setQueryData with deeply equal data notifies but keeps nested references", async () => {
    const q = track(query("explicit:equal", async () => todos()));
    await tick();
    const notifications = countNotifications(() => q.data());
    const before = q.data() as Todos;

    setQueryData("explicit:equal", todos());
    const after = q.data() as Todos;
    expect(notifications()).toBe(1);
    expect(after).not.toBe(before);
    expect(after.items).toBe(before.items);
    expect(after.meta).toBe(before.meta);
  });

  it("setQueryData returning prev itself changes nothing", async () => {
    const q = track(query("explicit:same", async () => todos()));
    await tick();
    const notifications = countNotifications(() => q.data());
    const before = q.data();
    setQueryData<Todos>("explicit:same", (prev) => prev as Todos);
    expect(q.data()).toBe(before);
    expect(notifications()).toBe(0);
  });

  it("regression: setQueryData overrides a custom sharing function answering prev", async () => {
    const q = track(
      query("explicit:custom", async () => todos(), {
        structuralSharing: (prev) => prev,
      }),
    );
    await tick();
    const notifications = countNotifications(() => q.data());
    setQueryData<Todos>("explicit:custom", (prev) => ({ ...(prev as Todos), meta: { owner: "grace" } }));
    expect(notifications()).toBe(1);
    expect(q.data()?.meta.owner).toBe("grace");
  });

  it("regression: resource.mutate with an in-place edit and a shallow copy notifies", async () => {
    const r = resource(async () => todos());
    disposers.push(r.dispose);
    await tick();
    const notifications = countNotifications(() => r.data());
    const before = r.data();

    r.mutate((prev) => {
      (prev as Todos).items.push({ id: 3 });
      return { ...(prev as Todos) };
    });
    expect(notifications()).toBe(1);
    expect(r.data()).not.toBe(before);
    expect(r.data()?.items).toHaveLength(3);
  });

  it("regression: resource.mutate overrides a custom sharing function answering prev", async () => {
    const r = resource(async () => todos(), { structuralSharing: (prev) => prev });
    disposers.push(r.dispose);
    await tick();
    const notifications = countNotifications(() => r.data());
    r.mutate((prev) => ({ ...(prev as Todos), meta: { owner: "grace" } }));
    expect(notifications()).toBe(1);
    expect(r.data()?.meta.owner).toBe("grace");
  });
});

// ---------------------------------------------------------------------------
// Per-observer settings, per-key reconciliation
// ---------------------------------------------------------------------------

describe("each observer's structuralSharing governs only that observer", () => {
  it("regression: a `false` observer is notified when a default observer owns the refetch", async () => {
    const fetcher = async () => payload();
    const shared = track(query("mixed:false", fetcher));
    const raw = track(query("mixed:false", fetcher, { structuralSharing: false }));
    await tick();
    const sharedN = countNotifications(() => shared.data());
    const rawN = countNotifications(() => raw.data());
    const rawBefore = raw.data();

    await shared.refetch();
    expect(sharedN()).toBe(0);
    expect(rawN()).toBe(1);
    expect(raw.data()).not.toBe(rawBefore);
  });

  it("a default observer stays shared when a `false` observer owns the refetch", async () => {
    const fetcher = async () => payload();
    const shared = track(query("mixed:false-owner", fetcher));
    const raw = track(query("mixed:false-owner", fetcher, { structuralSharing: false }));
    await tick();
    const sharedN = countNotifications(() => shared.data());
    const before = shared.data();

    await raw.refetch();
    expect(shared.data()).toBe(before);
    expect(sharedN()).toBe(0);
  });

  it("regression: a custom function is applied to its own observer only, against its own previous value", async () => {
    const fetcher = async () => payload();
    const seen: [User, User][] = [];
    const custom = track(
      query("mixed:custom", fetcher, {
        structuralSharing: (prev, next) => {
          seen.push([prev, next]);
          return next;
        },
      }),
    );
    const shared = track(query("mixed:custom", fetcher));
    await tick();
    const customN = countNotifications(() => custom.data());
    const sharedN = countNotifications(() => shared.data());
    const customBefore = custom.data();

    await shared.refetch();
    // The default observer is not governed by the custom function...
    expect(sharedN()).toBe(0);
    // ...and the custom observer applied its own function, which says "take
    // next", to its own previous value.
    expect(customN()).toBe(1);
    expect(seen.at(-1)?.[0]).toBe(customBefore);
    expect(custom.data()).toBe(seen.at(-1)?.[1]);
  });
});

describe("sharing never reconciles across keys", () => {
  it("regression: after user/1 -> user/2 the observer holds user/2's own references", async () => {
    const [id, setId] = signal(1);
    const fetchUser = async ({ key }: { key: string }) => ({
      id: Number(key.split("/")[1]),
      settings: { theme: "dark", locale: "en" },
    });
    const q = track(query(() => `user/${id()}`, fetchUser));
    await tick();
    const user1 = getQueryData<{ settings: object }>("user/1");
    // Another observer of user/2, so the key's shared reference exists already.
    const other = track(query("user/2", fetchUser));
    await tick();

    setId(2);
    await tick();
    const data = q.data();
    expect(data?.id).toBe(2);
    expect(data).toBe(getQueryData("user/2"));
    expect(data).toBe(other.data());
    expect(data?.settings).not.toBe(user1?.settings);

    // An in-place edit of user/2's data must not reach user/1's cache.
    (data?.settings as { theme: string }).theme = "light";
    expect(getQueryData<{ settings: { theme: string } }>("user/1")?.settings.theme).toBe("dark");
  });
});

// ---------------------------------------------------------------------------
// query(): select
// ---------------------------------------------------------------------------

describe("query() select", () => {
  it("regression: select notifies data subscribers exactly once per fetch", async () => {
    let version = 0;
    const select = vi.fn((d: { v: number }) => ({ v: d.v * 10 }));
    // Sharing off, and a payload that changes every fetch, so a notification is
    // due every time — the assertion is about how MANY arrive.
    const q = track(
      query("select:once", async () => ({ v: ++version }), {
        select,
        structuralSharing: false,
      }),
    );
    await tick();
    const notifications = countNotifications(() => q.data());

    await q.refetch();
    expect(notifications()).toBe(1);
    await q.refetch();
    expect(notifications()).toBe(2);
    expect(q.data()).toEqual({ v: 30 });
  });

  it("regression: a dedup waiter with select is notified once per fetch too", async () => {
    let version = 0;
    const opts = { select: (d: { v: number }) => ({ v: d.v }), structuralSharing: false } as const;
    const fetcher = async () => ({ v: ++version });
    const owner = track(query("select:waiter", fetcher, opts));
    const waiter = track(query("select:waiter", fetcher, opts));
    await tick();
    const ownerN = countNotifications(() => owner.data());
    const waiterN = countNotifications(() => waiter.data());

    // Both observers refetch; the second deduplicates onto the first's request.
    invalidateQueries("select:waiter");
    await tick();
    await tick();
    expect(ownerN()).toBe(1);
    expect(waiterN()).toBe(1);
  });

  it("regression: with select, an identical refetch notifies nobody", async () => {
    const q = track(query("select:identical", async () => payload(), { select: (u) => ({ ...u }) }));
    await tick();
    const notifications = countNotifications(() => q.data());
    const before = q.data();

    await q.refetch();
    expect(q.data()).toBe(before);
    expect(notifications()).toBe(0);
  });

  it("regression: a signal read inside select re-runs the selection without refetching", async () => {
    const [factor, setFactor] = signal(1);
    const fetcher = vi.fn(async () => ({ v: 1 }));
    // Seed the cache so the second observer applies `select` on mount — where a
    // tracked read used to become a key-effect dependency.
    track(query("select:signal", fetcher));
    await tick();
    const q = track(query("select:signal", fetcher, { select: (d) => ({ v: d.v * factor() }) }));
    await tick();
    const calls = fetcher.mock.calls.length;

    setFactor(2);
    await tick();
    expect(fetcher.mock.calls.length).toBe(calls);
    expect(q.data()).toEqual({ v: 2 });
  });

  it("regression: a filtering select follows its filter signal, and an identical refetch after it notifies nobody", async () => {
    type Row = { id: number; kind: string };
    const [filter, setFilter] = signal("a");
    const fetcher = vi.fn(
      async (): Promise<Row[]> => [
        { id: 1, kind: "a" },
        { id: 2, kind: "b" },
        { id: 3, kind: "a" },
      ],
    );
    const q = track(query("select:filter", fetcher, { select: (d) => d.filter((x) => x.kind === filter()) }));
    await tick();
    expect(q.data()?.map((r) => r.id)).toEqual([1, 3]);
    const calls = fetcher.mock.calls.length;

    setFilter("b");
    expect(q.data()?.map((r) => r.id)).toEqual([2]);
    expect(fetcher.mock.calls.length).toBe(calls);

    const notifications = countNotifications(() => q.data());
    const before = q.data();
    await q.refetch();
    expect(q.data()).toBe(before);
    expect(notifications()).toBe(0);
  });

  it("a throwing select keeps the previous data and reports the error", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let fail = false;
    let version = 0;
    const q = track(
      query("select:throws", async () => ({ v: ++version }), {
        select: (d) => {
          if (fail) throw new Error("select broke");
          return d;
        },
      }),
    );
    await tick();
    const before = q.data();
    fail = true;
    await q.refetch();
    expect(q.data()).toBe(before);
    expect(q.error()).toBeUndefined();
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Cyclic data
// ---------------------------------------------------------------------------

interface TreeNode {
  name: string;
  meta: { tag: string };
  children: Array<{ name: string; parent: TreeNode }>;
}

function tree(childName = "leaf"): TreeNode {
  const root: TreeNode = { name: "root", meta: { tag: "x" }, children: [] };
  root.children.push({ name: childName, parent: root });
  return root;
}

describe("cyclic data", () => {
  it("regression: replaceEqualDeep does not overflow on back-references", () => {
    const prev = tree();
    const next = tree();
    let result: TreeNode | undefined;
    expect(() => {
      result = replaceEqualDeep(prev, next);
    }).not.toThrow();
    // The graph stays self-consistent: the child's back-reference points at the
    // root that was actually returned.
    expect(result?.children[0].parent).toBe(result);
  });

  it("regression: a changed sibling of a cycle yields a consistent graph", () => {
    const prev = tree();
    const next = tree("renamed");
    const result = replaceEqualDeep(prev, next);
    expect(result.children[0].name).toBe("renamed");
    expect(result.children[0].parent).toBe(result);
  });

  it("regression: a query over cyclic data refetches without reporting errors", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const q = track(query("cyclic", async () => tree()));
    await tick();
    await q.refetch();
    await q.refetch();
    expect(errors).not.toHaveBeenCalled();
    expect(q.error()).toBeUndefined();
    const data = q.data() as TreeNode;
    expect(data.children[0].parent).toBe(data);
    errors.mockRestore();
  });

  it("regression: a resource over cyclic data refetches without reporting errors", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = resource(async () => tree());
    disposers.push(r.dispose);
    await tick();
    await r.refetch();
    expect(errors).not.toHaveBeenCalled();
    expect(r.data()?.children[0].parent).toBe(r.data());
    errors.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// resource(): same sharing contract
// ---------------------------------------------------------------------------

describe("resource() structural sharing", () => {
  it("regression: resource refetch with equal data does not notify", async () => {
    const r = resource(async () => payload());
    disposers.push(r.dispose);
    await tick();
    const notifications = countNotifications(() => r.data());
    const before = r.data();

    await r.refetch();
    expect(r.data()).toBe(before);
    expect(notifications()).toBe(0);
  });

  it("resource mutate of a new reference notifies and keeps unchanged nested references", async () => {
    const r = resource(async () => payload());
    disposers.push(r.dispose);
    await tick();
    const notifications = countNotifications(() => r.data());
    const before = r.data();

    r.mutate(payload());
    expect(notifications()).toBe(1);
    expect(r.data()).not.toBe(before);
    expect(r.data()?.roles).toBe(before?.roles);

    r.mutate((prev) => ({ ...(prev as User), name: "Grace" }));
    expect(r.data()?.name).toBe("Grace");
    expect(r.data()?.roles).toBe(before?.roles);
    expect(notifications()).toBe(2);
  });

  it("regression: a when() over resource data keeps a half-typed form across refetch", async () => {
    const r = resource(async () => payload());
    disposers.push(r.dispose);
    await tick();
    const host = div([
      when(
        () => r.data(),
        () => Form(),
      ),
    ]);
    document.body.appendChild(host);
    await flushMicrotasks();
    const field = host.querySelector<HTMLInputElement>("#draft") as HTMLInputElement;
    field.value = "half-typ";

    await r.refetch();
    await flushMicrotasks();
    expect(host.querySelector("#draft")).toBe(field);
    expect(field.value).toBe("half-typ");
  });

  it("resource structuralSharing: false commits every result as-is", async () => {
    const r = resource(async () => payload(), { structuralSharing: false });
    disposers.push(r.dispose);
    await tick();
    const before = r.data();
    await r.refetch();
    expect(r.data()).not.toBe(before);
  });
});
