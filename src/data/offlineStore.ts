/**
 * Offline-first data store backed by IndexedDB with reactive state.
 * Provides automatic sync when connectivity returns.
 *
 * WARNING: The sync adapter is responsible for CSRF protection. This store
 * does not attach CSRF tokens automatically — when push/pull hit a server
 * that requires them, the caller must include the token in their adapter
 * (e.g. via request headers). Missing tokens can expose the app to
 * cross-site request forgery on sync operations triggered by the "online"
 * event.
 */

import { signal } from "../core/signals/signal";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OfflineStoreOptions<T> {
  /** IndexedDB database name */
  name: string;
  /** Version for schema migrations */
  version?: number;
  /** Key path in the stored objects (default: "id") */
  keyPath?: string;
  /** Sync adapter for remote push/pull */
  adapter?: SyncAdapter<T>;
  /** Auto-sync when online status changes (default: true) */
  autoSync?: boolean;
}

/**
 * How a pulled remote record is reconciled with a local record that still has
 * an unpushed change queued for the same key. Records with no queued local
 * change are never conflicts — the remote value always applies.
 */
export type ConflictStrategy = "client-wins" | "server-wins" | "manual";

/** The state handed to a `manual` resolver for one conflicting key. */
export interface SyncConflict<T> {
  /** Value of the store's `keyPath` for the conflicting record. */
  key: unknown;
  /** Current local item — `undefined` when the queued local change is a delete. */
  local: T | undefined;
  /** The record as returned by the remote `pull()`. */
  remote: T;
  /** The queued local change that makes this key a conflict. */
  pending: SyncChange<T>;
}

export interface SyncAdapter<T> {
  /** Push local changes to remote */
  push: (changes: SyncChange<T>[]) => Promise<SyncResult>;
  /** Pull remote changes since last sync */
  pull: (since: number | null) => Promise<T[]>;
  /**
   * Conflict resolution strategy. Defaults to `"client-wins"`.
   *
   * - `client-wins` — a pulled record is DISCARDED for any key that still has
   *   an unpushed local change. The local edit survives and is pushed on the
   *   next round. This is the safe default: it never destroys work made
   *   offline.
   * - `server-wins` — the pulled record OVERWRITES local state even for keys
   *   with queued changes. The queued change itself is **retained**, not
   *   dropped: it still has to reach the server, and discarding it here would
   *   turn a display-precedence choice into silent data loss. A subsequent
   *   successful push therefore re-asserts the local edit remotely.
   * - `manual` — `resolveConflict` decides per key. Without a `resolveConflict`
   *   implementation this degrades to `client-wins` and warns, because the only
   *   other option is to guess with the user's unsynced data.
   */
  conflictStrategy?: ConflictStrategy;
  /**
   * Resolve one conflicting key. Required for `conflictStrategy: "manual"`.
   *
   * Return the value to store locally, or `undefined` to keep the local record
   * untouched. May be async. A resolver that throws falls back to keeping the
   * local record — the conservative direction.
   */
  resolveConflict?: (conflict: SyncConflict<T>) => T | undefined | Promise<T | undefined>;
}

export interface SyncChange<T> {
  type: "put" | "delete";
  item: T;
  timestamp: number;
}

export interface SyncResult {
  ok: boolean;
  error?: string;
}

export interface OfflineStore<T> {
  /** Reactive getter for all items */
  data: () => T[];
  /** Get a single item by key */
  get: (key: string | number) => Promise<T | undefined>;
  /** Insert or update an item */
  put: (item: T) => Promise<void>;
  /** Delete an item by key */
  remove: (key: string | number) => Promise<void>;
  /** Query items with a filter */
  query: (filter: (item: T) => boolean) => T[];
  /** Whether a sync is in progress */
  isSyncing: () => boolean;
  /** Timestamp of last successful sync */
  lastSynced: () => number | null;
  /** Trigger a manual sync */
  sync: () => Promise<void>;
  /** Attach a sync adapter */
  attach: (adapter: SyncAdapter<T>) => void;
  /** Number of pending (un-synced) changes */
  pendingCount: () => number;
  /** Close the database connection */
  close: () => void;
}

// ─── IDB Helpers ─────────────────────────────────────────────────────────────

function openDB(name: string, version: number, keyPath: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("items")) {
        db.createObjectStore("items", { keyPath });
      }
      if (!db.objectStoreNames.contains("_changes")) {
        const changeStore = db.createObjectStore("_changes", { autoIncrement: true });
        changeStore.createIndex("timestamp", "timestamp");
      }
      if (!db.objectStoreNames.contains("_meta")) {
        db.createObjectStore("_meta");
      }
    };
  });
}

function idbGetAll<T>(db: IDBDatabase, store: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet<T>(db: IDBDatabase, store: string, key: string | number): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut<T>(db: IDBDatabase, store: string, item: T, key?: IDBValidKey): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    // Out-of-line stores (no keyPath, e.g. "_meta") require an explicit key;
    // calling put(item) without one throws DataError.
    if (key !== undefined) tx.objectStore(store).put(item, key);
    else tx.objectStore(store).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Within an open `_changes` transaction, drop any prior pending change for the
 * same item key, then append the new one. This coalesces repeated edits to the
 * same record into a single pending change (last-write-wins, which matches how
 * push sends the current item), so the change log stays bounded by the working
 * set size instead of growing with every edit while offline.
 */
function coalesceAndAddChange<T>(tx: IDBTransaction, change: SyncChange<T>, keyPath: string): void {
  const store = tx.objectStore("_changes");
  const targetKey = (change.item as Record<string, unknown>)[keyPath];
  const cursorReq = store.openCursor();
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result;
    if (cursor) {
      const existing = cursor.value as SyncChange<T>;
      const k = (existing.item as Record<string, unknown>)[keyPath];
      if (targetKey != null && k === targetKey) cursor.delete();
      cursor.continue();
    } else {
      // Append only after the scan so we never delete the change we just added.
      store.put(change);
    }
  };
}

function idbPutWithChange<T>(db: IDBDatabase, item: T, change: SyncChange<T>, keyPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["items", "_changes"], "readwrite");
    tx.objectStore("items").put(item);
    coalesceAndAddChange(tx, change, keyPath);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function idbDeleteWithChange<T>(
  db: IDBDatabase,
  key: string | number,
  change: SyncChange<T>,
  keyPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["items", "_changes"], "readwrite");
    tx.objectStore("items").delete(key);
    coalesceAndAddChange(tx, change, keyPath);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function idbGetAllWithKeys<T>(db: IDBDatabase, store: string): Promise<{ key: IDBValidKey; value: T }[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const out: { key: IDBValidKey; value: T }[] = [];
    const req = tx.objectStore(store).openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        out.push({ key: cursor.primaryKey, value: cursor.value as T });
        cursor.continue();
      } else {
        resolve(out);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

function idbDeleteKeys(db: IDBDatabase, store: string, keys: IDBValidKey[]): Promise<void> {
  if (keys.length === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const objStore = tx.objectStore(store);
    for (const k of keys) objStore.delete(k);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function idbPutMany<T>(db: IDBDatabase, store: string, items: T[]): Promise<void> {
  if (items.length === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const objStore = tx.objectStore(store);
    for (const item of items) objStore.put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ─── Main Function ───────────────────────────────────────────────────────────────

/**
 * Create an offline-first reactive store backed by IndexedDB.
 *
 * @example
 * ```ts
 * const store = await offlineStore<Todo>({
 *   name: "todos",
 *   adapter: syncAdapter({
 *     push: (changes) => fetch("/api/sync", { method: "POST", body: JSON.stringify(changes) }),
 *     pull: (since) => fetch(`/api/todos?since=${since}`).then(r => r.json()),
 *     // client-wins (the default) never lets a pulled record overwrite a key
 *     // that still has an unpushed local edit. Use "server-wins" to let the
 *     // remote value win, or "manual" plus a `resolveConflict` resolver.
 *     conflictStrategy: "client-wins",
 *   }),
 * });
 *
 * await store.put({ id: "1", text: "Buy milk", done: false });
 * store.data(); // [{ id: "1", text: "Buy milk", done: false }]
 * ```
 */
export async function offlineStore<T extends object>(options: OfflineStoreOptions<T>): Promise<OfflineStore<T>> {
  const { name, version = 1, keyPath = "id", autoSync = true } = options;

  const db = await openDB(name, version, keyPath);
  const initialData = await idbGetAll<T>(db, "items");
  const initialChanges = await idbGetAll<SyncChange<T>>(db, "_changes");
  const savedLastSync = await idbGet<number>(db, "_meta", "lastSynced");

  const [data, setData] = signal<T[]>(initialData);
  const [isSyncing, setIsSyncing] = signal(false);
  const [lastSynced, setLastSynced] = signal<number | null>(savedLastSync ?? null);
  const [pendingCount, setPendingCount] = signal(initialChanges.length);

  let adapter: SyncAdapter<T> | undefined = options.adapter;

  async function refreshData() {
    const items = await idbGetAll<T>(db, "items");
    setData(items);
    const changes = await idbGetAll<SyncChange<T>>(db, "_changes");
    setPendingCount(changes.length);
  }

  async function put(item: T): Promise<void> {
    await idbPutWithChange(db, item, { type: "put", item, timestamp: Date.now() } as SyncChange<T>, keyPath);
    await refreshData();
  }

  async function remove(key: string | number): Promise<void> {
    const existing = await idbGet<T>(db, "items", key);
    if (existing) {
      await idbDeleteWithChange(
        db,
        key,
        { type: "delete", item: existing, timestamp: Date.now() } as SyncChange<T>,
        keyPath,
      );
      await refreshData();
    }
  }

  async function get(key: string | number): Promise<T | undefined> {
    return idbGet<T>(db, "items", key);
  }

  function query(filter: (item: T) => boolean): T[] {
    return data().filter(filter);
  }

  async function sync(): Promise<void> {
    // Snapshot the adapter for the WHOLE transaction. `adapter` is a mutable
    // binding that `attach()` can reassign at any await point, so reading it
    // per call let one sync push through adapter A and then pull through
    // adapter B — two different backends splicing one logical transaction,
    // with B's conflict strategy applied to A's push results.
    const syncAdapter = adapter;
    if (!syncAdapter || isSyncing() || closed) return;

    setIsSyncing(true);
    try {
      // Snapshot keys so concurrent put() during await is not lost on delete.
      const snapshot = await idbGetAllWithKeys<SyncChange<T>>(db, "_changes");
      if (closed) return;
      if (snapshot.length > 0) {
        const result = await syncAdapter.push(snapshot.map((e) => e.value));
        if (closed) return;
        if (result.ok) {
          await idbDeleteKeys(
            db,
            "_changes",
            snapshot.map((e) => e.key),
          );
          if (closed) return;
        } else if (typeof console !== "undefined") {
          // Changes are retained for retry (correct), but a permanently
          // rejecting server would otherwise grow the queue silently — surface
          // it so the caller can react instead of accumulating forever.
          console.warn(`[offlineStore] push rejected by adapter${result.error ? `: ${result.error}` : ""}`);
        }
      }

      const remoteItems = await syncAdapter.pull(lastSynced());
      if (closed) return;
      // A key with an unpushed local change is a CONFLICT: the remote value and
      // the local value both claim to be current. Which one wins is the
      // adapter's declared `conflictStrategy` — previously the strategy was
      // never read and every adapter silently got client-wins.
      const pendingChanges = await idbGetAll<SyncChange<T>>(db, "_changes");
      if (closed) return;
      const pendingByKey = new Map<unknown, SyncChange<T>>();
      for (const c of pendingChanges) {
        const k = (c.item as Record<string, unknown>)[keyPath];
        if (k != null) pendingByKey.set(k, c);
      }

      const resolved = await resolveRemoteItems(syncAdapter, remoteItems, pendingByKey);
      if (closed) return;
      // Batch into a single transaction so a mid-loop crash can't leave
      // partial state with `lastSynced` un-updated.
      await idbPutMany(db, "items", resolved);
      if (closed) return;

      const now = Date.now();
      await idbPut(db, "_meta", now, "lastSynced");
      if (closed) return;
      setLastSynced(now);
      await refreshData();
    } catch (err) {
      // Unsynced changes remain in queue for retry. Surface the error in dev
      // so schema/adapter bugs aren't silently swallowed.
      if (typeof console !== "undefined") console.warn("[offlineStore] sync failed", err);
    } finally {
      setIsSyncing(false);
    }
  }

  /**
   * Apply the adapter's conflict strategy to one pull's worth of remote items,
   * returning exactly the records that should be written to the local store.
   *
   * Non-conflicting records (no queued local change for that key) always pass
   * through — the strategy only governs contested keys.
   */
  async function resolveRemoteItems(
    activeAdapter: SyncAdapter<T>,
    remoteItems: T[],
    pendingByKey: Map<unknown, SyncChange<T>>,
  ): Promise<T[]> {
    const strategy = activeAdapter.conflictStrategy ?? "client-wins";
    const out: T[] = [];

    for (const remote of remoteItems) {
      const key = (remote as Record<string, unknown>)[keyPath];
      const pending = key == null ? undefined : pendingByKey.get(key);

      if (!pending) {
        out.push(remote);
        continue;
      }

      if (strategy === "server-wins") {
        // Remote value wins locally. The queued change stays queued — see the
        // `conflictStrategy` docs: dropping it would silently discard an edit
        // the server has not seen yet.
        out.push(remote);
        continue;
      }

      if (strategy === "manual") {
        if (!activeAdapter.resolveConflict) {
          if (typeof console !== "undefined") {
            console.warn(
              '[offlineStore] conflictStrategy is "manual" but the adapter has no resolveConflict(); ' +
                "keeping the local record for this key (client-wins).",
            );
          }
          continue;
        }
        try {
          const local = pending.type === "delete" ? undefined : await idbGet<T>(db, "items", key as string | number);
          const choice = await activeAdapter.resolveConflict({ key, local, remote, pending });
          if (choice !== undefined) out.push(choice);
        } catch (err) {
          // A throwing resolver must not decide the conflict by accident.
          // Keeping the local record is the direction that cannot lose data.
          if (typeof console !== "undefined") {
            console.warn("[offlineStore] resolveConflict threw; keeping the local record", err);
          }
        }
      }

      // client-wins (default) and every `manual` path that chose the local
      // record fall through here: the remote value is simply not applied.
    }

    return out;
  }

  function attach(newAdapter: SyncAdapter<T>) {
    adapter = newAdapter;
  }

  let onlineHandler: (() => void) | null = null;
  let closed = false;

  function close() {
    closed = true;
    if (onlineHandler && typeof window !== "undefined") {
      window.removeEventListener("online", onlineHandler);
      onlineHandler = null;
    }
    db.close();
  }

  // Auto-sync when coming online
  if (autoSync && typeof window !== "undefined") {
    onlineHandler = () => {
      sync();
    };
    window.addEventListener("online", onlineHandler);
  }

  return {
    data,
    get,
    put,
    remove,
    query,
    isSyncing,
    lastSynced,
    sync,
    attach,
    pendingCount,
    close,
  };
}

/**
 * Helper to create a sync adapter configuration.
 */
export function syncAdapter<T>(config: SyncAdapter<T>): SyncAdapter<T> {
  return config;
}
