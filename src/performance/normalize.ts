import { signal } from "../core/signals/signal";

// ─── Literal-key helpers ────────────────────────────────────────────────────
//
// Schema names and entity ids are DATA, often untrusted. On an ordinary `{}`,
// `obj["__proto__"] = x` replaces the prototype (pollution) and `obj.constructor`
// / `obj.toString` read inherited members. So every registry and table is a
// null-prototype object, every read is guarded by an own-property check, and
// every write to an arbitrary key defines an own property.

/** A fresh object with no prototype, optionally copying `source`'s own entries. */
function dict<V>(source?: Record<string, V>): Record<string, V> {
  const out = Object.create(null) as Record<string, V>;
  if (source) {
    for (const key of Object.keys(source)) defineOwn(out, key, source[key]);
  }
  return out;
}

/** Own-property read; inherited members never count as entries. */
function ownGet<V>(obj: Record<string, V> | undefined, key: string): V | undefined {
  return obj !== undefined && Object.hasOwn(obj, key) ? obj[key] : undefined;
}

/** Write `key` as an own data property, even when it is "__proto__". */
function defineOwn(obj: object, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
}

/**
 * Read and validate an entity's id. Only strings and finite numbers identify an
 * entity; anything else — a missing field, `null`, an object — used to become
 * the key `"undefined"` / `"null"` / `"[object Object]"`, silently merging
 * unrelated entities.
 */
function readEntityId(entity: unknown, idKey: string, typeName: string): string {
  const raw =
    entity !== null && typeof entity === "object" && Object.hasOwn(entity, idKey)
      ? (entity as Record<string, unknown>)[idKey]
      : undefined;
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  throw new TypeError(
    `[normalize] "${typeName}" entity has no valid "${idKey}" (expected a string or finite number, got ${
      raw === null ? "null" : typeof raw
    })`,
  );
}

// ============================================================================
// STATE NORMALIZATION FOR ENTITY RELATIONSHIP MANAGEMENT
// ============================================================================

/**
 * Schema definition for entity normalization.
 * Describes the shape of an entity type and its relationships.
 */
export interface NormalizedSchema {
  /** Name of the entity type (e.g. "user", "post") */
  name: string;
  /** Key used as the unique identifier. Defaults to "id" */
  idKey?: string;
  /** Map of relation field names to their entity type names */
  relations?: Record<string, string>;
}

/** Internal normalized state shape, following the ids + entities pattern */
export interface NormalizedState<T> {
  ids: string[];
  entities: Record<string, T>;
}

/** Actions returned by normalizedStore */
export interface NormalizedStoreActions<T> {
  /** Add a single entity to the store */
  add(entity: T): void;
  /** Add multiple entities to the store */
  addMany(entities: T[]): void;
  /** Get an entity by its id, or undefined if not found */
  get(id: string): T | undefined;
  /** Get all entities as an array */
  getAll(): T[];
  /** Update an entity by merging a partial object */
  update(id: string, partial: Partial<T>): void;
  /** Remove an entity by id */
  remove(id: string): void;
  /** Query entities matching a predicate */
  select(predicate: (entity: T) => boolean): T[];
  /** Get the raw normalized state (reactive getter) */
  getState(): NormalizedState<T>;
}

/**
 * normalizedStore creates a reactive normalized store for a single
 * entity type. Internal storage uses the `{ ids, entities }` pattern
 * (like Redux Toolkit's entity adapter) backed by signal for reactivity.
 *
 * @param schema Schema describing the entity type
 * @returns Store actions for CRUD and query operations
 *
 * @example
 * ```ts
 * const users = normalizedStore<User>({ name: "user" });
 *
 * users.add({ id: "1", name: "Alice" });
 * users.addMany([
 *   { id: "2", name: "Bob" },
 *   { id: "3", name: "Charlie" },
 * ]);
 *
 * const alice = users.get("1");       // { id: "1", name: "Alice" }
 * const all = users.getAll();         // [Alice, Bob, Charlie]
 * users.update("1", { name: "Alicia" });
 * users.remove("3");
 * const bobs = users.select(u => u.name.startsWith("B"));
 * ```
 */
export function normalizedStore<T extends object>(schema: NormalizedSchema): NormalizedStoreActions<T> {
  const idKey = schema.idKey || "id";

  // `entities` is a null-prototype table (see the literal-key helpers above).
  const [getState, setState] = signal<NormalizedState<T>>({
    ids: [],
    entities: dict<T>(),
  });

  // Validated before any state is touched, so a bad entity changes nothing.
  const idOf = (entity: T): string => readEntityId(entity, idKey, schema.name);

  function add(entity: T): void {
    const id = idOf(entity);
    setState((prev) => {
      const ids = Object.hasOwn(prev.entities, id) ? prev.ids : [...prev.ids, id];
      const entities = dict(prev.entities);
      defineOwn(entities, id, entity);
      return { ids, entities };
    });
  }

  function addMany(entities: T[]): void {
    // Validate every id first: one invalid entity rejects the whole batch.
    const ids = entities.map(idOf);
    setState((prev) => {
      const nextIds = [...prev.ids];
      const nextEntities = dict(prev.entities);

      entities.forEach((entity, i) => {
        const id = ids[i];
        if (!Object.hasOwn(nextEntities, id)) {
          nextIds.push(id);
        }
        defineOwn(nextEntities, id, entity);
      });

      return { ids: nextIds, entities: nextEntities };
    });
  }

  function get(id: string): T | undefined {
    return ownGet(getState().entities, id);
  }

  function getAll(): T[] {
    const state = getState();
    return state.ids.map((id) => state.entities[id]);
  }

  /**
   * Merge `partial` into the entity stored under `id`. Changing the entity's
   * own id field is rejected: the storage key would no longer match the id,
   * breaking lookup, removal and relation resolution.
   */
  function update(id: string, partial: Partial<T>): void {
    const prev = getState();
    if (!Object.hasOwn(prev.entities, id)) return;
    if (partial !== null && typeof partial === "object" && Object.hasOwn(partial, idKey)) {
      const nextId = readEntityId(partial, idKey, schema.name);
      if (nextId !== id) {
        throw new Error(
          `[normalizedStore] update("${id}") cannot change "${idKey}" to "${nextId}"; remove and re-add the entity instead.`,
        );
      }
    }

    setState((current) => {
      const existing = ownGet(current.entities, id);
      if (!existing) return current;
      const entities = dict(current.entities);
      defineOwn(entities, id, { ...existing, ...partial });
      return { ids: current.ids, entities };
    });
  }

  function remove(id: string): void {
    setState((prev) => {
      if (!Object.hasOwn(prev.entities, id)) return prev;

      const entities = dict(prev.entities);
      delete entities[id];
      return {
        ids: prev.ids.filter((existingId) => existingId !== id),
        entities,
      };
    });
  }

  function select(predicate: (entity: T) => boolean): T[] {
    const state = getState();
    return state.ids.map((id) => state.entities[id]).filter(predicate);
  }

  return { add, addMany, get, getAll, update, remove, select, getState };
}

// ============================================================================
// NORMALIZE / DENORMALIZE UTILITIES
// ============================================================================

/** A map of entity type names to their flat entity tables */
export type NormalizedEntities = Record<string, Record<string, unknown>>;

/** Result of normalizing nested data */
export interface NormalizeResult {
  /** The top-level id (or array of ids) of the normalized data */
  result: string | string[];
  /** All extracted entities keyed by type name, then by id */
  entities: NormalizedEntities;
}

/**
 * normalize takes a nested data object (or array) and flattens it into
 * a normalized entities map according to the provided schema.
 *
 * Relations defined in the schema are recursively extracted and replaced
 * with their id references.
 *
 * @param data The nested data to normalize (single object or array)
 * @param schema The schema describing entity shape and relations
 * @returns A NormalizeResult with the top-level id(s) and all entities
 *
 * @example
 * ```ts
 * const postSchema: NormalizedSchema = {
 *   name: "post",
 *   relations: { author: "user", comments: "comment" },
 * };
 *
 * const data = {
 *   id: "p1",
 *   title: "Hello",
 *   author: { id: "u1", name: "Alice" },
 *   comments: [
 *     { id: "c1", text: "Great!" },
 *     { id: "c2", text: "Thanks" },
 *   ],
 * };
 *
 * const { result, entities } = normalize(data, postSchema);
 * // result === "p1"
 * // entities.post["p1"] === { id: "p1", title: "Hello", author: "u1", comments: ["c1", "c2"] }
 * // entities.user["u1"] === { id: "u1", name: "Alice" }
 * // entities.comment["c1"] === { id: "c1", text: "Great!" }
 * ```
 */
export function normalize<T extends object>(data: T | T[], schema: NormalizedSchema): NormalizeResult {
  // Null-prototype registry and tables: schema names and ids are literal keys.
  const entities: NormalizedEntities = dict<Record<string, unknown>>();

  function ensureTable(name: string): Record<string, unknown> {
    let table = ownGet(entities, name);
    if (!table) {
      table = dict<unknown>();
      defineOwn(entities, name, table);
    }
    return table;
  }

  function normalizeEntity(entity: Record<string, unknown>, entitySchema: NormalizedSchema): string {
    const entityIdKey = entitySchema.idKey || "id";
    const id = readEntityId(entity, entityIdKey, entitySchema.name);
    const table = ensureTable(entitySchema.name);

    // Shallow copy to avoid mutating original data. Object spread defines own
    // properties, so an own "__proto__" key in the input stays an own key.
    const flat: Record<string, unknown> = { ...entity };

    if (entitySchema.relations) {
      for (const [field, relationType] of Object.entries(entitySchema.relations)) {
        const value = Object.hasOwn(entity, field) ? entity[field] : undefined;
        if (value == null) continue;

        // Relation schema: simple schema with just the type name. Children
        // default to "id" — inheriting the parent's (possibly custom) idKey
        // would read a missing field and produce `String(undefined)` ids.
        const relSchema: NormalizedSchema = { name: relationType };

        if (Array.isArray(value)) {
          defineOwn(
            flat,
            field,
            value.map((item) => normalizeEntity(item as Record<string, unknown>, relSchema)),
          );
        } else if (typeof value === "object") {
          defineOwn(flat, field, normalizeEntity(value as Record<string, unknown>, relSchema));
        }
      }
    }

    defineOwn(table, id, flat);
    return id;
  }

  // `normalizeEntity` walks entities as records; the cast is the same one it
  // already applies to nested relation values.
  if (Array.isArray(data)) {
    const result = data.map((item) => normalizeEntity(item as Record<string, unknown>, schema));
    return { result, entities };
  }

  const result = normalizeEntity(data as Record<string, unknown>, schema);
  return { result, entities };
}

/**
 * denormalize reconstructs a nested object from a flat normalized entities
 * map, resolving relation references back to their full objects.
 *
 * @param id The id of the root entity to reconstruct
 * @param entities The flat entities map (from normalize or manual construction)
 * @param schema The schema describing entity shape and relations
 * @returns The fully reconstructed nested object, or undefined if not found
 *
 * @example
 * ```ts
 * const post = denormalize("p1", entities, postSchema);
 * // post.author is the full user object, not just "u1"
 * // post.comments is an array of full comment objects
 * ```
 */
export function denormalize<T extends object>(
  id: string,
  entities: NormalizedEntities,
  schema: NormalizedSchema,
): T | undefined {
  // Own-property lookups only: an inherited name such as "constructor" is not a
  // table or an entity.
  const table = ownGet(entities, schema.name);
  if (!table) return undefined;

  const entity = ownGet(table, id);
  if (!entity) return undefined;

  const result: Record<string, unknown> = { ...(entity as Record<string, unknown>) };

  if (schema.relations) {
    for (const [field, relationType] of Object.entries(schema.relations)) {
      const value = ownGet(entity as Record<string, unknown>, field);
      if (value == null) continue;

      // Children default to "id"; see the matching note in normalize().
      const relSchema: NormalizedSchema = { name: relationType };

      if (Array.isArray(value)) {
        defineOwn(
          result,
          field,
          value.map((relId: string) => denormalize(relId, entities, relSchema)),
        );
      } else if (typeof value === "string") {
        defineOwn(result, field, denormalize(value, entities, relSchema));
      }
    }
  }

  return result as T;
}
