import { signal } from "../core/signals/signal";

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
export function normalizedStore<T extends Record<string, unknown>>(
  schema: NormalizedSchema,
): NormalizedStoreActions<T> {
  const idKey = schema.idKey || "id";

  const [getState, setState] = signal<NormalizedState<T>>({
    ids: [],
    entities: {},
  });

  function add(entity: T): void {
    const id = String(entity[idKey]);
    setState((prev) => {
      const ids = prev.ids.includes(id) ? prev.ids : [...prev.ids, id];
      return {
        ids,
        entities: { ...prev.entities, [id]: entity },
      };
    });
  }

  function addMany(entities: T[]): void {
    setState((prev) => {
      const nextIds = [...prev.ids];
      const nextEntities = { ...prev.entities };

      for (const entity of entities) {
        const id = String(entity[idKey]);
        if (!nextIds.includes(id)) {
          nextIds.push(id);
        }
        nextEntities[id] = entity;
      }

      return { ids: nextIds, entities: nextEntities };
    });
  }

  function get(id: string): T | undefined {
    const state = getState();
    return state.entities[id];
  }

  function getAll(): T[] {
    const state = getState();
    return state.ids.map((id) => state.entities[id]);
  }

  function update(id: string, partial: Partial<T>): void {
    setState((prev) => {
      const existing = prev.entities[id];
      if (!existing) return prev;

      return {
        ids: prev.ids,
        entities: {
          ...prev.entities,
          [id]: { ...existing, ...partial },
        },
      };
    });
  }

  function remove(id: string): void {
    setState((prev) => {
      if (!prev.entities[id]) return prev;

      const { [id]: _, ...remainingEntities } = prev.entities;
      return {
        ids: prev.ids.filter((existingId) => existingId !== id),
        entities: remainingEntities,
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
export function normalize<T extends Record<string, unknown>>(data: T | T[], schema: NormalizedSchema): NormalizeResult {
  const entities: NormalizedEntities = {};

  function ensureTable(name: string): Record<string, unknown> {
    if (!entities[name]) {
      entities[name] = {};
    }
    return entities[name];
  }

  function normalizeEntity(entity: Record<string, unknown>, entitySchema: NormalizedSchema): string {
    const entityIdKey = entitySchema.idKey || "id";
    const id = String(entity[entityIdKey]);
    const table = ensureTable(entitySchema.name);

    // Shallow copy to avoid mutating original data
    const flat: Record<string, unknown> = { ...entity };

    if (entitySchema.relations) {
      for (const [field, relationType] of Object.entries(entitySchema.relations)) {
        const value = entity[field];
        if (value == null) continue;

        // Relation schema: simple schema with just the type name. Children
        // default to "id" — inheriting the parent's (possibly custom) idKey
        // would read a missing field and produce `String(undefined)` ids.
        const relSchema: NormalizedSchema = { name: relationType };

        if (Array.isArray(value)) {
          flat[field] = value.map((item) => normalizeEntity(item as Record<string, unknown>, relSchema));
        } else if (typeof value === "object") {
          flat[field] = normalizeEntity(value as Record<string, unknown>, relSchema);
        }
      }
    }

    table[id] = flat;
    return id;
  }

  if (Array.isArray(data)) {
    const result = data.map((item) => normalizeEntity(item, schema));
    return { result, entities };
  }

  const result = normalizeEntity(data, schema);
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
export function denormalize<T extends Record<string, unknown>>(
  id: string,
  entities: NormalizedEntities,
  schema: NormalizedSchema,
): T | undefined {
  const table = entities[schema.name];
  if (!table) return undefined;

  const entity = table[id];
  if (!entity) return undefined;

  const result: Record<string, unknown> = { ...(entity as Record<string, unknown>) };

  if (schema.relations) {
    for (const [field, relationType] of Object.entries(schema.relations)) {
      const value = (entity as Record<string, unknown>)[field];
      if (value == null) continue;

      // Children default to "id"; see the matching note in normalize().
      const relSchema: NormalizedSchema = { name: relationType };

      if (Array.isArray(value)) {
        result[field] = value.map((relId: string) => denormalize(relId, entities, relSchema));
      } else if (typeof value === "string") {
        result[field] = denormalize(value, entities, relSchema);
      }
    }
  }

  return result as T;
}
