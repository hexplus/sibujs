import { signal } from "../core/signals/signal";

// ============================================================================
// OPTIMISTIC UPDATES
// ============================================================================

/**
 * optimistic provides optimistic UI updates that can be reverted on failure.
 * The value updates immediately, then reverts if the async operation fails.
 *
 * Returns a named object with `value`, `pending`, and `update`.
 *
 * Concurrent safety: each operation is tagged with a version counter.
 * A failing operation only reverts if no newer operation has started since,
 * preventing stale snapshots from overwriting fresher optimistic state.
 *
 * @example
 * ```ts
 * const likes = optimistic(42);
 *
 * button(
 *   { on: { click: () => likes.update(likes.value() + 1, () => api.like()) } },
 *   () => `${likes.value()} ${likes.pending() ? "(saving…)" : ""}`,
 * );
 * ```
 */
export function optimistic<T>(initialValue: T): {
  value: () => T;
  pending: () => boolean;
  update: (optimisticValue: T, asyncAction: () => Promise<T>) => Promise<void>;
} {
  const [value, setValue] = signal<T>(initialValue);
  const [pending, setPending] = signal(false);
  let inflightCount = 0;
  let version = 0;

  async function update(optimisticValue: T, asyncAction: () => Promise<T>): Promise<void> {
    const myVersion = ++version;
    const previousValue = value();
    setValue(optimisticValue);
    inflightCount++;
    setPending(true);

    try {
      const result = await asyncAction();
      if (version === myVersion) {
        setValue(result);
      }
    } catch {
      if (version === myVersion) {
        setValue(previousValue);
      }
    } finally {
      inflightCount--;
      if (inflightCount === 0) setPending(false);
    }
  }

  return { value, pending, update };
}

/**
 * optimisticList provides optimistic updates for array state.
 *
 * Uses functional updates (setItems(current => ...)) for the success path
 * to avoid losing changes made by concurrent operations. The failure path
 * uses a version guard so stale reverts don't overwrite newer state.
 *
 * @example
 * ```ts
 * const todos = optimisticList<Todo>([]);
 *
 * todos.add(
 *   { id: tempId(), text: "New" },
 *   async () => api.createTodo("New"),
 * );
 *
 * div([
 *   () => todos.pending() ? span("Saving…") : null,
 *   each(() => todos.items(), (t) => div(t().text), { key: (t) => t.id }),
 * ]);
 * ```
 */
export function optimisticList<T>(initialValue: T[]): {
  items: () => T[];
  pending: () => boolean;
  add: (item: T, asyncAction: () => Promise<T>) => Promise<void>;
  remove: (predicate: (item: T) => boolean, asyncAction: () => Promise<void>) => Promise<void>;
  update: (predicate: (item: T) => boolean, patch: Partial<T>, asyncAction: () => Promise<T>) => Promise<void>;
} {
  const [items, setItems] = signal<T[]>([...initialValue]);
  const [pending, setPending] = signal(false);
  let inflightCount = 0;
  let version = 0;
  // Tag each optimistic item with an internal id so patch/remove locate
  // the correct entry even when array contents are replaced by reference.
  let tempIdCounter = 0;
  const itemIds = new WeakMap<object, number>();
  const idToItem = new Map<number, T>();

  function tagItem(item: T): number {
    const id = ++tempIdCounter;
    if (item !== null && typeof item === "object") {
      itemIds.set(item as unknown as object, id);
    }
    idToItem.set(id, item);
    return id;
  }

  function findIndexById(list: T[], id: number): number {
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      if (it !== null && typeof it === "object" && itemIds.get(it as unknown as object) === id) {
        return i;
      }
      if (Object.is(it, idToItem.get(id))) return i;
    }
    return -1;
  }

  function begin(): number {
    const v = ++version;
    inflightCount++;
    setPending(true);
    return v;
  }

  function end(myVersion: number, revertFn?: () => void) {
    if (revertFn && version === myVersion) {
      revertFn();
    }
    inflightCount--;
    if (inflightCount === 0) setPending(false);
  }

  async function add(item: T, asyncAction: () => Promise<T>): Promise<void> {
    const prev = items();
    const id = tagItem(item);
    setItems([...prev, item]);
    const myVersion = begin();

    try {
      const result = await asyncAction();
      setItems((current) => {
        const idx = findIndexById(current, id);
        if (idx >= 0) {
          const next = [...current];
          next[idx] = result;
          return next;
        }
        return [...current, result];
      });
      idToItem.delete(id);
      end(myVersion);
    } catch {
      idToItem.delete(id);
      end(myVersion, () => setItems(prev));
    }
  }

  async function remove(predicate: (item: T) => boolean, asyncAction: () => Promise<void>): Promise<void> {
    const prev = items();
    setItems(prev.filter((item) => !predicate(item)));
    const myVersion = begin();

    try {
      await asyncAction();
      end(myVersion);
    } catch {
      end(myVersion, () => setItems(prev));
    }
  }

  async function updateItem(
    predicate: (item: T) => boolean,
    patch: Partial<T>,
    asyncAction: () => Promise<T>,
  ): Promise<void> {
    const prev = items();
    const patchedIds: number[] = [];
    setItems(
      prev.map((item) => {
        if (predicate(item)) {
          const patched = { ...item, ...patch } as T;
          const id = tagItem(patched);
          patchedIds.push(id);
          return patched;
        }
        return item;
      }),
    );
    const myVersion = begin();

    try {
      const result = await asyncAction();
      setItems((current) =>
        current.map((item) => {
          if (item !== null && typeof item === "object") {
            const existingId = itemIds.get(item as unknown as object);
            if (existingId !== undefined && patchedIds.includes(existingId)) return result;
          }
          return item;
        }),
      );
      for (const id of patchedIds) idToItem.delete(id);
      end(myVersion);
    } catch {
      for (const id of patchedIds) idToItem.delete(id);
      end(myVersion, () => setItems(prev));
    }
  }

  return {
    items,
    pending,
    add,
    remove,
    update: updateItem,
  };
}
