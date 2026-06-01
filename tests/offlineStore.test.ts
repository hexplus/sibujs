import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { offlineStore, type SyncAdapter } from "../src/data/offlineStore";

interface Todo extends Record<string, unknown> {
  id: string;
  text: string;
}

// Each test uses a unique DB name so fake-indexeddb state never bleeds across.
let dbn = 0;
const freshName = () => `todos-${dbn++}`;

describe("offlineStore — change coalescing", () => {
  it("coalesces repeated edits to the same key into one pending change", async () => {
    const store = await offlineStore<Todo>({ name: freshName(), autoSync: false });

    await store.put({ id: "1", text: "a" });
    await store.put({ id: "1", text: "b" });
    await store.put({ id: "1", text: "c" });

    // Without coalescing this would be 3; the log is bounded by distinct keys.
    expect(store.pendingCount()).toBe(1);
    expect(store.data()).toEqual([{ id: "1", text: "c" }]);

    store.close();
  });

  it("keeps separate pending changes for distinct keys", async () => {
    const store = await offlineStore<Todo>({ name: freshName(), autoSync: false });

    await store.put({ id: "1", text: "a" });
    await store.put({ id: "2", text: "b" });
    await store.put({ id: "1", text: "a2" });

    expect(store.pendingCount()).toBe(2);

    store.close();
  });

  it("pushes only the coalesced latest change to the adapter", async () => {
    const pushed: unknown[][] = [];
    const adapter: SyncAdapter<Todo> = {
      push: async (changes) => {
        pushed.push(changes);
        return { ok: true };
      },
      pull: async () => [],
      conflictStrategy: "client-wins",
    };

    const store = await offlineStore<Todo>({ name: freshName(), autoSync: false, adapter });
    await store.put({ id: "1", text: "a" });
    await store.put({ id: "1", text: "final" });

    await store.sync();

    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toHaveLength(1); // single coalesced change
    expect((pushed[0][0] as { item: Todo }).item.text).toBe("final");
    expect(store.pendingCount()).toBe(0);

    store.close();
  });
});

describe("offlineStore — rejected push", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it("retains changes and surfaces a warning when the adapter rejects", async () => {
    const adapter: SyncAdapter<Todo> = {
      push: async () => ({ ok: false, error: "server down" }),
      pull: async () => [],
      conflictStrategy: "client-wins",
    };

    const store = await offlineStore<Todo>({ name: freshName(), autoSync: false, adapter });
    await store.put({ id: "1", text: "a" });
    await store.sync();

    // Unsynced change is NOT dropped (correct), and the rejection is visible.
    expect(store.pendingCount()).toBe(1);
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.some((c) => String(c[0]).includes("push rejected"))).toBe(true);

    store.close();
  });
});
