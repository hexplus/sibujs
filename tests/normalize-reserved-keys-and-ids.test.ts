import { afterEach, describe, expect, it } from "vitest";
import { denormalize, type NormalizedEntities, normalize, normalizedStore } from "../src/performance/normalize";

// ---------------------------------------------------------------------------
// normalize()/denormalize()/normalizedStore(): schema names and ids are literal
// data, and entity ids are validated.
//
// THE DEFECTS:
// 1. The entity registry and tables were ordinary `{}` objects keyed by schema
//    names and ids, so a schema named "__proto__" wrote the entity onto
//    Object.prototype, and ids like "constructor" / "toString" collided with
//    inherited members (denormalize returned them).
// 2. Ids came from `String(entity[idKey])`, so a missing id became the key
//    "undefined" and later entities silently overwrote earlier ones; an update
//    could change the id field without changing the storage key.
// ---------------------------------------------------------------------------

const RESERVED = ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"];

afterEach(() => {
  for (const name of ["owned", "polluted", "value", "id"]) {
    delete (Object.prototype as Record<string, unknown>)[name];
  }
});

describe("normalize treats schema names and ids as literal data", () => {
  it("a schema named __proto__ does not pollute Object.prototype", () => {
    const { entities } = normalize({ id: "owned", value: 1 }, { name: "__proto__" });

    expect(({} as Record<string, unknown>).owned).toBeUndefined();
    expect(Object.hasOwn(entities, "__proto__")).toBe(true);
    expect(Object.hasOwn(entities.__proto__, "owned")).toBe(true);
  });

  it("a relation typed __proto__ does not pollute Object.prototype", () => {
    const { entities } = normalize(
      { id: "p1", author: { id: "polluted", name: "x" } },
      { name: "post", relations: { author: "__proto__" } },
    );

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.hasOwn(entities.__proto__, "polluted")).toBe(true);
  });

  it("a relation FIELD named __proto__ is stored as an own property", () => {
    const data = JSON.parse('{"id":"p1","__proto__":{"id":"u1","name":"Alice"}}');
    // JSON.parse, not a literal: `{ __proto__: "user" }` would set a prototype.
    const relations = JSON.parse('{"__proto__":"user"}') as Record<string, string>;
    const { entities } = normalize(data, { name: "post", relations });

    const post = entities.post.p1 as Record<string, unknown>;
    expect(Object.hasOwn(post, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(post)).toBe(Object.prototype);
    expect(Object.hasOwn(entities.user, "u1")).toBe(true);
  });

  for (const id of RESERVED) {
    it(`round-trips an entity with id ${JSON.stringify(id)}`, () => {
      const { result, entities } = normalize({ id, label: `entity ${id}` }, { name: "thing" });

      expect(result).toBe(id);
      expect(Object.hasOwn(entities.thing, id)).toBe(true);
      expect(denormalize<{ id: string; label: string }>(id, entities, { name: "thing" })).toEqual({
        id,
        label: `entity ${id}`,
      });
    });

    it(`round-trips a schema named ${JSON.stringify(id)}`, () => {
      const { entities } = normalize({ id: "1", label: "x" }, { name: id });
      expect(denormalize("1", entities, { name: id })).toEqual({ id: "1", label: "x" });
    });
  }

  it("missing inherited names return undefined from denormalize", () => {
    const { entities } = normalize({ id: "1" }, { name: "thing" });

    expect(denormalize("constructor", entities, { name: "thing" })).toBeUndefined();
    expect(denormalize("toString", entities, { name: "thing" })).toBeUndefined();
    expect(denormalize("1", entities, { name: "constructor" })).toBeUndefined();
    expect(denormalize("1", entities, { name: "toString" })).toBeUndefined();
    expect(denormalize("1", {} as NormalizedEntities, { name: "hasOwnProperty" })).toBeUndefined();
  });

  it("leaves Object.prototype unchanged across every reserved-looking name", () => {
    const before = Object.getOwnPropertyNames(Object.prototype).sort();
    for (const name of RESERVED) {
      const { entities } = normalize({ id: name, [name]: { id: "x" } }, { name, relations: { [name]: name } });
      denormalize(name, entities, { name, relations: { [name]: name } });
    }
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before);
  });
});

describe("normalize validates ids", () => {
  it("rejects an entity without an id", () => {
    expect(() => normalize({ name: "Alice" } as { id?: string; name: string }, { name: "user" })).toThrow(TypeError);
  });

  it("rejects a null id and a missing custom idKey", () => {
    expect(() => normalize({ id: null, name: "x" }, { name: "user" })).toThrow(TypeError);
    expect(() => normalize({ id: "1", name: "x" }, { name: "user", idKey: "uuid" })).toThrow(/uuid/);
  });

  it("accepts string and finite number ids", () => {
    const { result } = normalize(
      [
        { id: "a", v: 1 },
        { id: 7, v: 2 },
      ],
      { name: "row" },
    );
    expect(result).toEqual(["a", "7"]);
  });
});

describe("normalizedStore ids", () => {
  type User = { id?: string | null; uuid?: string; name: string };

  it("rejects adding entities without an id instead of overwriting under 'undefined'", () => {
    const users = normalizedStore<User>({ name: "user" });

    expect(() => users.add({ name: "Alice" })).toThrow(TypeError);
    expect(() => users.add({ id: null, name: "Bob" })).toThrow(TypeError);

    expect(users.getState().ids).toEqual([]);
    expect(users.getAll()).toEqual([]);
  });

  it("rejects an entity missing a custom idKey", () => {
    const users = normalizedStore<User>({ name: "user", idKey: "uuid" });
    expect(() => users.add({ id: "1", name: "Alice" })).toThrow(/uuid/);
    users.add({ uuid: "u-1", name: "Alice" });
    expect(users.get("u-1")?.name).toBe("Alice");
  });

  it("addMany() with any invalid entity changes nothing", () => {
    const users = normalizedStore<User>({ name: "user" });
    users.add({ id: "0", name: "Existing" });

    expect(() => users.addMany([{ id: "1", name: "Alice" }, { name: "No id" }, { id: "2", name: "Bob" }])).toThrow(
      TypeError,
    );

    expect(users.getState().ids).toEqual(["0"]);
    expect(users.get("1")).toBeUndefined();
  });

  it("rejects an update that changes the id and leaves the store unchanged", () => {
    const users = normalizedStore<User>({ name: "user" });
    users.add({ id: "1", name: "Alice" });
    users.add({ id: "2", name: "Bob" });
    const before = users.getState();

    expect(() => users.update("1", { id: "2" })).toThrow(/id/);
    expect(() => users.update("1", { id: "3" })).toThrow(/id/);

    expect(users.getState()).toBe(before);
    expect(users.get("1")?.id).toBe("1");
    expect(users.get("2")?.name).toBe("Bob");
  });

  it("an update that repeats the same id is allowed", () => {
    const users = normalizedStore<User>({ name: "user" });
    users.add({ id: "1", name: "Alice" });
    users.update("1", { id: "1", name: "Alicia" });
    expect(users.get("1")?.name).toBe("Alicia");
  });

  for (const id of RESERVED) {
    it(`stores, reads, updates and removes an entity with id ${JSON.stringify(id)}`, () => {
      const users = normalizedStore<User>({ name: "user" });
      expect(users.get(id)).toBeUndefined();

      users.add({ id, name: "Reserved" });
      expect(users.get(id)?.name).toBe("Reserved");
      users.update(id, { name: "Updated" });
      expect(users.get(id)?.name).toBe("Updated");
      expect(users.getAll()).toHaveLength(1);

      users.remove(id);
      expect(users.get(id)).toBeUndefined();
      expect(users.getState().ids).toEqual([]);
    });
  }

  it("update and remove on an inherited name are no-ops", () => {
    const users = normalizedStore<User>({ name: "user" });
    const before = users.getState();
    users.update("toString", { name: "x" });
    users.remove("constructor");
    expect(users.getState()).toBe(before);
  });
});
