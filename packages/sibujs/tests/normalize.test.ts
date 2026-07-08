import { describe, expect, it } from "vitest";
import { denormalize, type NormalizedSchema, normalize, normalizedStore } from "../src/performance/normalize";

// ============================================================================
// normalizedStore
// ============================================================================

describe("normalizedStore", () => {
  interface User {
    id: string;
    name: string;
    age?: number;
  }

  it("should start with an empty store", () => {
    const store = normalizedStore<User>({ name: "user" });
    expect(store.getAll()).toEqual([]);
    expect(store.getState().ids).toEqual([]);
    expect(store.getState().entities).toEqual({});
  });

  it("should add a single entity", () => {
    const store = normalizedStore<User>({ name: "user" });
    store.add({ id: "1", name: "Alice" });

    expect(store.get("1")).toEqual({ id: "1", name: "Alice" });
    expect(store.getState().ids).toEqual(["1"]);
  });

  it("should add multiple entities with addMany", () => {
    const store = normalizedStore<User>({ name: "user" });
    store.addMany([
      { id: "1", name: "Alice" },
      { id: "2", name: "Bob" },
      { id: "3", name: "Charlie" },
    ]);

    expect(store.getAll()).toEqual([
      { id: "1", name: "Alice" },
      { id: "2", name: "Bob" },
      { id: "3", name: "Charlie" },
    ]);
    expect(store.getState().ids).toEqual(["1", "2", "3"]);
  });

  it("should return undefined for a non-existent entity", () => {
    const store = normalizedStore<User>({ name: "user" });
    expect(store.get("999")).toBeUndefined();
  });

  it("should update an entity by merging partial data", () => {
    const store = normalizedStore<User>({ name: "user" });
    store.add({ id: "1", name: "Alice", age: 30 });

    store.update("1", { name: "Alicia" });

    expect(store.get("1")).toEqual({ id: "1", name: "Alicia", age: 30 });
  });

  it("should not modify state when updating a non-existent entity", () => {
    const store = normalizedStore<User>({ name: "user" });
    store.add({ id: "1", name: "Alice" });

    const stateBefore = store.getState();
    store.update("999", { name: "Ghost" });
    const stateAfter = store.getState();

    // State reference should be the same since nothing changed
    expect(stateAfter).toBe(stateBefore);
  });

  it("should remove an entity by id", () => {
    const store = normalizedStore<User>({ name: "user" });
    store.addMany([
      { id: "1", name: "Alice" },
      { id: "2", name: "Bob" },
    ]);

    store.remove("1");

    expect(store.get("1")).toBeUndefined();
    expect(store.getAll()).toEqual([{ id: "2", name: "Bob" }]);
    expect(store.getState().ids).toEqual(["2"]);
  });

  it("should not modify state when removing a non-existent entity", () => {
    const store = normalizedStore<User>({ name: "user" });
    store.add({ id: "1", name: "Alice" });

    const stateBefore = store.getState();
    store.remove("999");
    const stateAfter = store.getState();

    expect(stateAfter).toBe(stateBefore);
  });

  it("should select entities matching a predicate", () => {
    const store = normalizedStore<User>({ name: "user" });
    store.addMany([
      { id: "1", name: "Alice", age: 30 },
      { id: "2", name: "Bob", age: 25 },
      { id: "3", name: "Charlie", age: 35 },
    ]);

    const result = store.select((u) => (u.age ?? 0) >= 30);
    expect(result).toEqual([
      { id: "1", name: "Alice", age: 30 },
      { id: "3", name: "Charlie", age: 35 },
    ]);
  });

  it("should overwrite an existing entity when adding with the same id", () => {
    const store = normalizedStore<User>({ name: "user" });
    store.add({ id: "1", name: "Alice" });
    store.add({ id: "1", name: "Alicia" });

    expect(store.get("1")).toEqual({ id: "1", name: "Alicia" });
    // Should not duplicate the id
    expect(store.getState().ids).toEqual(["1"]);
  });

  it("should support a custom idKey", () => {
    interface Item {
      _key: string;
      label: string;
    }
    const store = normalizedStore<Item>({ name: "item", idKey: "_key" });
    store.add({ _key: "a", label: "Apple" });

    expect(store.get("a")).toEqual({ _key: "a", label: "Apple" });
    expect(store.getAll()).toEqual([{ _key: "a", label: "Apple" }]);
  });

  it("should getAll in insertion order", () => {
    const store = normalizedStore<User>({ name: "user" });
    store.add({ id: "3", name: "Charlie" });
    store.add({ id: "1", name: "Alice" });
    store.add({ id: "2", name: "Bob" });

    const names = store.getAll().map((u) => u.name);
    expect(names).toEqual(["Charlie", "Alice", "Bob"]);
  });
});

// ============================================================================
// normalize
// ============================================================================

describe("normalize", () => {
  it("should normalize a flat entity with no relations", () => {
    const schema: NormalizedSchema = { name: "user" };
    const data = { id: "u1", name: "Alice" };

    const { result, entities } = normalize(data, schema);

    expect(result).toBe("u1");
    expect(entities.user["u1"]).toEqual({ id: "u1", name: "Alice" });
  });

  it("should normalize an array of flat entities", () => {
    const schema: NormalizedSchema = { name: "user" };
    const data = [
      { id: "u1", name: "Alice" },
      { id: "u2", name: "Bob" },
    ];

    const { result, entities } = normalize(data, schema);

    expect(result).toEqual(["u1", "u2"]);
    expect(entities.user["u1"]).toEqual({ id: "u1", name: "Alice" });
    expect(entities.user["u2"]).toEqual({ id: "u2", name: "Bob" });
  });

  it("should normalize nested object relations", () => {
    const schema: NormalizedSchema = {
      name: "post",
      relations: { author: "user" },
    };

    const data = {
      id: "p1",
      title: "Hello",
      author: { id: "u1", name: "Alice" },
    };

    const { result, entities } = normalize(data, schema);

    expect(result).toBe("p1");
    // The author field on the post should be replaced with the id reference
    expect(entities.post["p1"].author).toBe("u1");
    expect(entities.post["p1"].title).toBe("Hello");
    // The user entity should be extracted into its own table
    expect(entities.user["u1"]).toEqual({ id: "u1", name: "Alice" });
  });

  it("should normalize nested array relations", () => {
    const schema: NormalizedSchema = {
      name: "post",
      relations: { comments: "comment" },
    };

    const data = {
      id: "p1",
      title: "Hello",
      comments: [
        { id: "c1", text: "Great!" },
        { id: "c2", text: "Thanks" },
      ],
    };

    const { result, entities } = normalize(data, schema);

    expect(result).toBe("p1");
    expect(entities.post["p1"].comments).toEqual(["c1", "c2"]);
    expect(entities.comment["c1"]).toEqual({ id: "c1", text: "Great!" });
    expect(entities.comment["c2"]).toEqual({ id: "c2", text: "Thanks" });
  });

  it("should normalize multiple relation types", () => {
    const schema: NormalizedSchema = {
      name: "post",
      relations: { author: "user", comments: "comment" },
    };

    const data = {
      id: "p1",
      title: "Hello",
      author: { id: "u1", name: "Alice" },
      comments: [
        { id: "c1", text: "Great!" },
        { id: "c2", text: "Thanks" },
      ],
    };

    const { result, entities } = normalize(data, schema);

    expect(result).toBe("p1");
    expect(entities.post["p1"].author).toBe("u1");
    expect(entities.post["p1"].comments).toEqual(["c1", "c2"]);
    expect(entities.user["u1"]).toEqual({ id: "u1", name: "Alice" });
    expect(entities.comment["c1"]).toEqual({ id: "c1", text: "Great!" });
    expect(entities.comment["c2"]).toEqual({ id: "c2", text: "Thanks" });
  });

  it("should handle null relation values gracefully", () => {
    const schema: NormalizedSchema = {
      name: "post",
      relations: { author: "user" },
    };

    const data = { id: "p1", title: "No author", author: null };

    const { result, entities } = normalize(data, schema);

    expect(result).toBe("p1");
    expect(entities.post["p1"].author).toBeNull();
    expect(entities.user).toBeUndefined();
  });

  it("should not mutate the original data", () => {
    const schema: NormalizedSchema = {
      name: "post",
      relations: { author: "user" },
    };

    const author = { id: "u1", name: "Alice" };
    const data = { id: "p1", title: "Hello", author };

    normalize(data, schema);

    // Original data should still have the nested object
    expect(data.author).toBe(author);
    expect(data.author.name).toBe("Alice");
  });
});

// ============================================================================
// denormalize
// ============================================================================

describe("denormalize", () => {
  it("should denormalize a flat entity with no relations", () => {
    const schema: NormalizedSchema = { name: "user" };
    const entities = {
      user: { u1: { id: "u1", name: "Alice" } },
    };

    const result = denormalize("u1", entities, schema);
    expect(result).toEqual({ id: "u1", name: "Alice" });
  });

  it("should return undefined for a missing entity", () => {
    const schema: NormalizedSchema = { name: "user" };
    const entities = { user: {} };

    expect(denormalize("missing", entities, schema)).toBeUndefined();
  });

  it("should return undefined when the entity table does not exist", () => {
    const schema: NormalizedSchema = { name: "user" };
    const entities = {};

    expect(denormalize("u1", entities, schema)).toBeUndefined();
  });

  it("should denormalize nested object relations", () => {
    const schema: NormalizedSchema = {
      name: "post",
      relations: { author: "user" },
    };

    const entities = {
      post: { p1: { id: "p1", title: "Hello", author: "u1" } },
      user: { u1: { id: "u1", name: "Alice" } },
    };

    const result = denormalize("p1", entities, schema);

    expect(result).toEqual({
      id: "p1",
      title: "Hello",
      author: { id: "u1", name: "Alice" },
    });
  });

  it("should denormalize nested array relations", () => {
    const schema: NormalizedSchema = {
      name: "post",
      relations: { comments: "comment" },
    };

    const entities = {
      post: { p1: { id: "p1", title: "Hello", comments: ["c1", "c2"] } },
      comment: {
        c1: { id: "c1", text: "Great!" },
        c2: { id: "c2", text: "Thanks" },
      },
    };

    const result = denormalize("p1", entities, schema);

    expect(result).toEqual({
      id: "p1",
      title: "Hello",
      comments: [
        { id: "c1", text: "Great!" },
        { id: "c2", text: "Thanks" },
      ],
    });
  });

  it("should denormalize multiple relation types", () => {
    const schema: NormalizedSchema = {
      name: "post",
      relations: { author: "user", comments: "comment" },
    };

    const entities = {
      post: {
        p1: { id: "p1", title: "Hello", author: "u1", comments: ["c1"] },
      },
      user: { u1: { id: "u1", name: "Alice" } },
      comment: { c1: { id: "c1", text: "Nice" } },
    };

    const result = denormalize("p1", entities, schema);

    expect(result).toEqual({
      id: "p1",
      title: "Hello",
      author: { id: "u1", name: "Alice" },
      comments: [{ id: "c1", text: "Nice" }],
    });
  });

  it("should handle null relation values gracefully", () => {
    const schema: NormalizedSchema = {
      name: "post",
      relations: { author: "user" },
    };

    const entities = {
      post: { p1: { id: "p1", title: "Solo", author: null } },
    };

    const result = denormalize("p1", entities, schema);

    expect(result).toEqual({ id: "p1", title: "Solo", author: null });
  });

  it("should round-trip: normalize then denormalize restores original shape", () => {
    const schema: NormalizedSchema = {
      name: "post",
      relations: { author: "user", comments: "comment" },
    };

    const original = {
      id: "p1",
      title: "Hello World",
      author: { id: "u1", name: "Alice" },
      comments: [
        { id: "c1", text: "Great post!" },
        { id: "c2", text: "Thanks for sharing" },
      ],
    };

    const { result: rootId, entities } = normalize(original, schema);
    const restored = denormalize(rootId as string, entities, schema);

    expect(restored).toEqual(original);
  });
});
