// ============================================================================
// offlineStore.ts — extra coverage: get/query/remove, full sync round
// (push + pull + conflict avoidance + lastSynced persistence), pull-only sync,
// push-rejected warning, sync skipped without adapter / while syncing / when
// closed, auto-sync on the "online" event, close() removing the handler,
// and reloading persisted lastSynced + pending changes on reopen.
// ============================================================================

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { offlineStore, type SyncAdapter, syncAdapter } from "../src/data/offlineStore";

interface Todo extends Record<string, unknown> {
  id: string;
  text: string;
}

let dbn = 0;
const freshName = () => `cov2-todos-${dbn++}`;
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("offlineStore.ts coverage2", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("get / query / remove", () => {
    it("get returns a single item by key, query filters, remove deletes + queues a change", async () => {
      const store = await offlineStore<Todo>({ name: freshName(), autoSync: false });

      await store.put({ id: "1", text: "alpha" });
      await store.put({ id: "2", text: "beta" });
      await store.put({ id: "3", text: "alphabet" });

      expect(await store.get("2")).toEqual({ id: "2", text: "beta" });
      expect(await store.get("nope")).toBeUndefined();

      const matches = store.query((t) => t.text.startsWith("alpha"));
      expect(matches.map((t) => t.id).sort()).toEqual(["1", "3"]);

      // After three puts the change log has 3 distinct keys.
      expect(store.pendingCount()).toBe(3);

      await store.remove("2");
      expect(await store.get("2")).toBeUndefined();
      expect(
        store
          .data()
          .map((t) => t.id)
          .sort(),
      ).toEqual(["1", "3"]);

      store.close();
    });

    it("remove is a no-op for a missing key", async () => {
      const store = await offlineStore<Todo>({ name: freshName(), autoSync: false });
      await store.remove("ghost");
      expect(store.data()).toEqual([]);
      expect(store.pendingCount()).toBe(0);
      store.close();
    });
  });

  describe("sync — full round (push then pull)", () => {
    it("pushes pending changes, pulls remote items, updates lastSynced, and clears the change log", async () => {
      const push = vi.fn(async () => ({ ok: true }) as const);
      const pull = vi.fn(async (_since: number | null) => [{ id: "r1", text: "remote" }]);
      const adapter: SyncAdapter<Todo> = { push, pull, conflictStrategy: "server-wins" };

      const store = await offlineStore<Todo>({ name: freshName(), autoSync: false, adapter });

      await store.put({ id: "local1", text: "local" });
      expect(store.pendingCount()).toBe(1);

      await store.sync();

      expect(push).toHaveBeenCalledTimes(1);
      // First sync pulls with since = null.
      expect(pull).toHaveBeenCalledWith(null);
      // Pushed change accepted -> change log cleared.
      expect(store.pendingCount()).toBe(0);
      // Remote item merged into local data.
      expect(store.data().some((t) => t.id === "r1")).toBe(true);
      expect(store.lastSynced()).not.toBeNull();
      expect(store.isSyncing()).toBe(false);

      store.close();
    });

    it("does not clobber items that still have pending local edits", async () => {
      // Pull returns an item whose key is also pending locally -> filtered out.
      const push = vi.fn(async () => ({ ok: false, error: "server down" }) as const);
      const pull = vi.fn(async () => [{ id: "conflicted", text: "server-version" }]);
      const adapter: SyncAdapter<Todo> = { push, pull, conflictStrategy: "client-wins" };
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const store = await offlineStore<Todo>({ name: freshName(), autoSync: false, adapter });
      await store.put({ id: "conflicted", text: "local-version" });

      await store.sync();

      // Push was rejected -> warning surfaced and changes retained.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("[offlineStore] push rejected"));
      expect(store.pendingCount()).toBe(1);
      // Local edit must win over the pulled server version for this key.
      expect(store.data().find((t) => t.id === "conflicted")?.text).toBe("local-version");

      store.close();
    });
  });

  describe("sync — pull only (no pending changes)", () => {
    it("skips push when the change log is empty and still pulls", async () => {
      const push = vi.fn(async () => ({ ok: true }) as const);
      const pull = vi.fn(async () => [{ id: "x", text: "pulled" }]);
      const adapter = syncAdapter<Todo>({ push, pull, conflictStrategy: "server-wins" });

      const store = await offlineStore<Todo>({ name: freshName(), autoSync: false, adapter });
      await store.sync();

      expect(push).not.toHaveBeenCalled();
      expect(pull).toHaveBeenCalledTimes(1);
      expect(store.data()).toEqual([{ id: "x", text: "pulled" }]);
      store.close();
    });
  });

  describe("sync — guards", () => {
    it("no-ops without an adapter", async () => {
      const store = await offlineStore<Todo>({ name: freshName(), autoSync: false });
      await store.sync();
      expect(store.isSyncing()).toBe(false);
      store.close();
    });

    it("attach() supplies an adapter that a later sync uses", async () => {
      const pull = vi.fn(async () => [{ id: "a", text: "attached" }]);
      const store = await offlineStore<Todo>({ name: freshName(), autoSync: false });
      // No adapter yet.
      await store.sync();
      expect(pull).not.toHaveBeenCalled();

      store.attach({ push: async () => ({ ok: true }), pull, conflictStrategy: "server-wins" });
      await store.sync();
      expect(pull).toHaveBeenCalled();
      expect(store.data()).toEqual([{ id: "a", text: "attached" }]);
      store.close();
    });

    it("does not start a second sync while one is in progress", async () => {
      let resolvePull: (v: Todo[]) => void = () => {};
      const pull = vi.fn(
        () =>
          new Promise<Todo[]>((res) => {
            resolvePull = res;
          }),
      );
      const adapter = syncAdapter<Todo>({
        push: async () => ({ ok: true }),
        pull,
        conflictStrategy: "server-wins",
      });
      const store = await offlineStore<Todo>({ name: freshName(), autoSync: false, adapter });

      const first = store.sync();
      // sync() awaits several IndexedDB reads + the push before reaching pull;
      // wait deterministically until pull is invoked (robust under parallel load)
      // rather than assuming a single macrotask is enough.
      for (let i = 0; i < 100 && pull.mock.calls.length === 0; i++) await tick();
      // First sync is now awaiting the in-flight pull.
      expect(store.isSyncing()).toBe(true);
      expect(pull).toHaveBeenCalledTimes(1);

      // Second call returns immediately (isSyncing guard) without re-invoking pull.
      await store.sync();
      expect(pull).toHaveBeenCalledTimes(1);

      resolvePull([]);
      await first;
      expect(store.isSyncing()).toBe(false);
      store.close();
    });

    it("surfaces sync failures from a throwing adapter without rejecting", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const adapter = syncAdapter<Todo>({
        push: async () => ({ ok: true }),
        pull: async () => {
          throw new Error("network error");
        },
        conflictStrategy: "server-wins",
      });
      const store = await offlineStore<Todo>({ name: freshName(), autoSync: false, adapter });

      await expect(store.sync()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith("[offlineStore] sync failed", expect.any(Error));
      expect(store.isSyncing()).toBe(false);
      store.close();
    });
  });

  describe("auto-sync on online event + close", () => {
    it("syncs when the window fires 'online' and stops after close()", async () => {
      const pull = vi.fn(async () => [] as Todo[]);
      const adapter = syncAdapter<Todo>({
        push: async () => ({ ok: true }),
        pull,
        conflictStrategy: "server-wins",
      });
      const store = await offlineStore<Todo>({ name: freshName(), autoSync: true, adapter });

      window.dispatchEvent(new Event("online"));
      await tick();
      await tick();
      expect(pull).toHaveBeenCalled();

      const before = pull.mock.calls.length;
      store.close();
      // After close the online handler is detached.
      window.dispatchEvent(new Event("online"));
      await tick();
      await tick();
      expect(pull.mock.calls.length).toBe(before);
    });
  });

  describe("persistence across reopen", () => {
    it("reloads persisted lastSynced and pending changes on a fresh open", async () => {
      const name = freshName();
      const adapter = syncAdapter<Todo>({
        push: async () => ({ ok: true }),
        pull: async () => [],
        conflictStrategy: "server-wins",
      });

      const first = await offlineStore<Todo>({ name, autoSync: false, adapter });
      await first.put({ id: "p1", text: "persist" });
      await first.sync(); // persists lastSynced, clears pending
      const lastSynced = first.lastSynced();
      expect(lastSynced).not.toBeNull();
      // Queue a change that is NOT synced before closing.
      await first.put({ id: "p2", text: "unsynced" });
      expect(first.pendingCount()).toBe(1);
      first.close();

      // Reopen the same DB: lastSynced + the pending change should be restored.
      const second = await offlineStore<Todo>({ name, autoSync: false });
      expect(second.lastSynced()).toBe(lastSynced);
      expect(second.pendingCount()).toBe(1);
      expect(second.data().some((t) => t.id === "p2")).toBe(true);
      second.close();
    });
  });
});
