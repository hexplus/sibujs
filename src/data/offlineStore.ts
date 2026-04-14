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

export interface SyncAdapter<T> {
  /** Push local changes to remote */
  push: (changes: SyncChange<T>[]) => Promise<SyncResult>;
  /** Pull remote changes since last sync */
  pull: (since: number | null) => Promise<T[]>;
  /** Conflict resolution strategy */
  conflictStrategy: "client-wins" | "server-wins" | "manual";
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

function idbPut<T>(db: IDBDatabase, store: string, item: T): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function idbPutWithChange<T>(db: IDBDatabase, item: T, change: SyncChange<T>): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["items", "_changes"], "readwrite");
    tx.objectStore("items").put(item);
    tx.objectStore("_changes").put(change);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function idbDeleteWithChange<T>(db: IDBDatabase, key: string | number, change: SyncChange<T>): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["items", "_changes"], "readwrite");
    tx.objectStore("items").delete(key);
    tx.objectStore("_changes").put(change);
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
 *     conflictStrategy: "client-wins",
 *   }),
 * });
 *
 * await store.put({ id: "1", text: "Buy milk", done: false });
 * store.data(); // [{ id: "1", text: "Buy milk", done: false }]
 * ```
 */
export async function offlineStore<T extends Record<string, unknown>>(
  options: OfflineStoreOptions<T>,
): Promise<OfflineStore<T>> {
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
    await idbPutWithChange(db, item, { type: "put", item, timestamp: Date.now() } as SyncChange<T>);
    await refreshData();
  }

  async function remove(key: string | number): Promise<void> {
    const existing = await idbGet<T>(db, "items", key);
    if (existing) {
      await idbDeleteWithChange(db, key, { type: "delete", item: existing, timestamp: Date.now() } as SyncChange<T>);
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
    if (!adapter || isSyncing() || closed) return;

    setIsSyncing(true);
    try {
      // Snapshot keys so concurrent put() during await is not lost on delete.
      const snapshot = await idbGetAllWithKeys<SyncChange<T>>(db, "_changes");
      if (closed) return;
      if (snapshot.length > 0) {
        const result = await adapter.push(snapshot.map((e) => e.value));
        if (closed) return;
        if (result.ok) {
          await idbDeleteKeys(
            db,
            "_changes",
            snapshot.map((e) => e.key),
          );
          if (closed) return;
        }
      }

      const remoteItems = await adapter.pull(lastSynced());
      if (closed) return;
      // Don't clobber items that have unsynced local edits queued during this
      // pull window. The next sync round will push those edits and re-pull.
      const pendingChanges = await idbGetAll<SyncChange<T>>(db, "_changes");
      if (closed) return;
      const pendingKeys = new Set<unknown>();
      for (const c of pendingChanges) {
        const k = (c.item as Record<string, unknown>)[keyPath];
        if (k != null) pendingKeys.add(k);
      }
      const safeRemote = remoteItems.filter((item) => {
        const k = (item as Record<string, unknown>)[keyPath];
        return k == null || !pendingKeys.has(k);
      });
      // Batch into a single transaction so a mid-loop crash can't leave
      // partial state with `lastSynced` un-updated.
      await idbPutMany(db, "items", safeRemote);
      if (closed) return;

      const now = Date.now();
      await idbPut(db, "_meta", now);
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
