/**
 * offlineStore conflict strategy + adapter-consistency certification.
 *
 * INVARIANT (API contract): every public option must change observable
 * behavior. `conflictStrategy` is part of the exported `SyncAdapter` type, so
 * the three declared values must be distinguishable.
 *
 * INVARIANT (concurrency): one sync() is one transaction against one adapter.
 * `attach()` landing mid-sync must not split a push and its pull across two
 * different adapters.
 */

import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { offlineStore, type SyncAdapter, type SyncConflict } from "../src/data/offlineStore";

interface Todo extends Record<string, unknown> {
  id: string;
  text: string;
}

let dbn = 0;
const freshName = () => `hardening-todos-${dbn++}`;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("offlineStore — conflictStrategy is observable", () => {
  it("client-wins keeps the local edit for a key with a pending change", async () => {
    const adapter: SyncAdapter<Todo> = {
      push: async () => ({ ok: false }),
      pull: async () => [{ id: "1", text: "server" }],
      conflictStrategy: "client-wins",
    };
    const store = await offlineStore<Todo>({ name: freshName(), adapter, autoSync: false });

    await store.put({ id: "1", text: "local" });
    await store.sync();

    expect(store.data()).toEqual([{ id: "1", text: "local" }]);
    store.close();
  });

  it("server-wins overwrites a key that still has a pending local change", async () => {
    const adapter: SyncAdapter<Todo> = {
      push: async () => ({ ok: false }),
      pull: async () => [{ id: "1", text: "server" }],
      conflictStrategy: "server-wins",
    };
    const store = await offlineStore<Todo>({ name: freshName(), adapter, autoSync: false });

    await store.put({ id: "1", text: "local" });
    await store.sync();

    expect(store.data()).toEqual([{ id: "1", text: "server" }]);
    store.close();
  });

  it("both strategies agree on a key with no local conflict", async () => {
    for (const strategy of ["client-wins", "server-wins"] as const) {
      const adapter: SyncAdapter<Todo> = {
        push: async () => ({ ok: true }),
        pull: async () => [{ id: "2", text: "server" }],
        conflictStrategy: strategy,
      };
      const store = await offlineStore<Todo>({ name: freshName(), adapter, autoSync: false });

      await store.sync();
      expect(store.data()).toEqual([{ id: "2", text: "server" }]);
      store.close();
    }
  });

  it("server-wins still leaves the pending change queued for the next push", async () => {
    const adapter: SyncAdapter<Todo> = {
      push: async () => ({ ok: false }),
      pull: async () => [{ id: "1", text: "server" }],
      conflictStrategy: "server-wins",
    };
    const store = await offlineStore<Todo>({ name: freshName(), adapter, autoSync: false });

    await store.put({ id: "1", text: "local" });
    await store.sync();

    // The push failed, so the change must survive for retry regardless of how
    // the pull resolved the item's value.
    expect(store.pendingCount()).toBe(1);
    store.close();
  });

  it("manual defers the decision to resolveConflict", async () => {
    const seen: Array<{ local: unknown; remote: unknown }> = [];
    const adapter: SyncAdapter<Todo> = {
      push: async () => ({ ok: false }),
      pull: async () => [{ id: "1", text: "server" }],
      conflictStrategy: "manual",
      resolveConflict: ({ local, remote }) => {
        seen.push({ local, remote });
        return { id: "1", text: "merged" };
      },
    };
    const store = await offlineStore<Todo>({ name: freshName(), adapter, autoSync: false });

    await store.put({ id: "1", text: "local" });
    await store.sync();

    expect(seen).toEqual([{ local: { id: "1", text: "local" }, remote: { id: "1", text: "server" } }]);
    expect(store.data()).toEqual([{ id: "1", text: "merged" }]);
    store.close();
  });

  it("manual keeps the local record when the resolver returns undefined", async () => {
    const adapter: SyncAdapter<Todo> = {
      push: async () => ({ ok: false }),
      pull: async () => [{ id: "1", text: "server" }],
      conflictStrategy: "manual",
      resolveConflict: () => undefined,
    };
    const store = await offlineStore<Todo>({ name: freshName(), adapter, autoSync: false });

    await store.put({ id: "1", text: "local" });
    await store.sync();

    expect(store.data()).toEqual([{ id: "1", text: "local" }]);
    store.close();
  });

  it("manual supports an async resolver", async () => {
    const adapter: SyncAdapter<Todo> = {
      push: async () => ({ ok: false }),
      pull: async () => [{ id: "1", text: "server" }],
      conflictStrategy: "manual",
      resolveConflict: async ({ local, remote }) => ({
        id: "1",
        text: `${(local as Todo).text}+${remote.text}`,
      }),
    };
    const store = await offlineStore<Todo>({ name: freshName(), adapter, autoSync: false });

    await store.put({ id: "1", text: "local" });
    await store.sync();

    expect(store.data()).toEqual([{ id: "1", text: "local+server" }]);
    store.close();
  });

  it("manual keeps the local record when the resolver throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const adapter: SyncAdapter<Todo> = {
      push: async () => ({ ok: false }),
      pull: async () => [{ id: "1", text: "server" }],
      conflictStrategy: "manual",
      resolveConflict: () => {
        throw new Error("cannot decide");
      },
    };
    const store = await offlineStore<Todo>({ name: freshName(), adapter, autoSync: false });

    await store.put({ id: "1", text: "local" });
    await store.sync();

    expect(store.data()).toEqual([{ id: "1", text: "local" }]);
    warn.mockRestore();
    store.close();
  });

  it("manual without a resolver degrades to client-wins and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const adapter: SyncAdapter<Todo> = {
      push: async () => ({ ok: false }),
      pull: async () => [{ id: "1", text: "server" }],
      conflictStrategy: "manual",
    };
    const store = await offlineStore<Todo>({ name: freshName(), adapter, autoSync: false });

    await store.put({ id: "1", text: "local" });
    await store.sync();

    expect(store.data()).toEqual([{ id: "1", text: "local" }]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("resolveConflict"));
    warn.mockRestore();
    store.close();
  });

  it("does not invoke resolveConflict for a key with no local change", async () => {
    const resolveConflict = vi.fn(() => undefined);
    const adapter: SyncAdapter<Todo> = {
      push: async () => ({ ok: true }),
      pull: async () => [{ id: "9", text: "server" }],
      conflictStrategy: "manual",
      resolveConflict,
    };
    const store = await offlineStore<Todo>({ name: freshName(), adapter, autoSync: false });

    await store.sync();

    expect(resolveConflict).not.toHaveBeenCalled();
    expect(store.data()).toEqual([{ id: "9", text: "server" }]);
    store.close();
  });

  it("passes local: undefined to the resolver when the pending change is a delete", async () => {
    let observed: SyncConflict<Todo> | null = null;
    const adapter: SyncAdapter<Todo> = {
      push: async () => ({ ok: false }),
      pull: async () => [{ id: "1", text: "server" }],
      conflictStrategy: "manual",
      resolveConflict: (c) => {
        observed = c;
        return undefined;
      },
    };
    const store = await offlineStore<Todo>({ name: freshName(), adapter, autoSync: false });

    await store.put({ id: "1", text: "local" });
    await store.sync();
    await store.remove("1");
    await store.sync();

    expect(observed).not.toBeNull();
    expect((observed as unknown as SyncConflict<Todo>).local).toBeUndefined();
    expect((observed as unknown as SyncConflict<Todo>).pending.type).toBe("delete");
    store.close();
  });

  it("client-wins is the default when the adapter omits a strategy", async () => {
    const adapter: SyncAdapter<Todo> = {
      push: async () => ({ ok: false }),
      pull: async () => [{ id: "1", text: "server" }],
    };
    const store = await offlineStore<Todo>({ name: freshName(), adapter, autoSync: false });

    await store.put({ id: "1", text: "local" });
    await store.sync();

    expect(store.data()).toEqual([{ id: "1", text: "local" }]);
    store.close();
  });
});

describe("offlineStore — adapter consistency within one sync", () => {
  it("uses one adapter for both push and pull even if attach() lands mid-sync", async () => {
    const gate = deferred<void>();
    const calls: string[] = [];

    const adapterA: SyncAdapter<Todo> = {
      push: async () => {
        calls.push("A.push");
        await gate.promise;
        return { ok: true };
      },
      pull: async () => {
        calls.push("A.pull");
        return [];
      },
      conflictStrategy: "client-wins",
    };

    const adapterB: SyncAdapter<Todo> = {
      push: async () => {
        calls.push("B.push");
        return { ok: true };
      },
      pull: async () => {
        calls.push("B.pull");
        return [];
      },
      conflictStrategy: "client-wins",
    };

    const store = await offlineStore<Todo>({ name: freshName(), adapter: adapterA, autoSync: false });
    await store.put({ id: "1", text: "a" });

    const syncing = store.sync();
    await Promise.resolve();

    store.attach(adapterB);
    gate.resolve();
    await syncing;

    expect(calls).toEqual(["A.push", "A.pull"]);
    store.close();
  });

  it("uses the newly attached adapter for the NEXT sync", async () => {
    const calls: string[] = [];
    const mk = (label: string): SyncAdapter<Todo> => ({
      push: async () => {
        calls.push(`${label}.push`);
        return { ok: true };
      },
      pull: async () => {
        calls.push(`${label}.pull`);
        return [];
      },
      conflictStrategy: "client-wins",
    });

    const store = await offlineStore<Todo>({ name: freshName(), adapter: mk("A"), autoSync: false });
    await store.put({ id: "1", text: "a" });
    await store.sync();

    store.attach(mk("B"));
    await store.put({ id: "2", text: "b" });
    await store.sync();

    expect(calls).toEqual(["A.push", "A.pull", "B.push", "B.pull"]);
    store.close();
  });

  it("applies the snapshotted adapter's conflict strategy, not a later one", async () => {
    const gate = deferred<void>();

    const adapterA: SyncAdapter<Todo> = {
      push: async () => {
        await gate.promise;
        return { ok: false };
      },
      pull: async () => [{ id: "1", text: "server" }],
      conflictStrategy: "client-wins",
    };
    const adapterB: SyncAdapter<Todo> = {
      push: async () => ({ ok: false }),
      pull: async () => [{ id: "1", text: "server-b" }],
      conflictStrategy: "server-wins",
    };

    const store = await offlineStore<Todo>({ name: freshName(), adapter: adapterA, autoSync: false });
    await store.put({ id: "1", text: "local" });

    const syncing = store.sync();
    await Promise.resolve();
    store.attach(adapterB);
    gate.resolve();
    await syncing;

    // A's client-wins governed this transaction end to end.
    expect(store.data()).toEqual([{ id: "1", text: "local" }]);
    store.close();
  });

  it("does not start a second sync while one is in flight", async () => {
    const gate = deferred<void>();
    let pushes = 0;
    const adapter: SyncAdapter<Todo> = {
      push: async () => {
        pushes++;
        await gate.promise;
        return { ok: true };
      },
      pull: async () => [],
      conflictStrategy: "client-wins",
    };

    const store = await offlineStore<Todo>({ name: freshName(), adapter, autoSync: false });
    await store.put({ id: "1", text: "a" });

    const first = store.sync();
    await Promise.resolve();
    const second = store.sync();

    gate.resolve();
    await Promise.all([first, second]);

    expect(pushes).toBe(1);
    store.close();
  });

  it("stops a sync cleanly when close() lands mid-flight", async () => {
    const gate = deferred<void>();
    const pull = vi.fn(async () => [] as Todo[]);
    const adapter: SyncAdapter<Todo> = {
      push: async () => {
        await gate.promise;
        return { ok: true };
      },
      pull,
      conflictStrategy: "client-wins",
    };

    const store = await offlineStore<Todo>({ name: freshName(), adapter, autoSync: false });
    await store.put({ id: "1", text: "a" });

    const syncing = store.sync();
    await Promise.resolve();
    store.close();
    gate.resolve();
    await syncing;

    expect(pull).not.toHaveBeenCalled();
  });
});
