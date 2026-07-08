import { describe, expect, it } from "vitest";
import { createSnapshotMatcher, createSnapshotStore, matchSnapshot, snapshotComponent } from "../src/testing/snapshot";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A trivial component that returns a <div> with text. */
function SimpleDiv(text = "Hello") {
  return () => {
    const el = document.createElement("div");
    el.textContent = text;
    return el;
  };
}

/** A component with nested children and attributes. */
function NestedComponent() {
  return () => {
    const root = document.createElement("section");
    root.setAttribute("id", "root");
    root.setAttribute("class", "wrapper");

    const heading = document.createElement("h1");
    heading.textContent = "Title";
    root.appendChild(heading);

    const para = document.createElement("p");
    para.setAttribute("data-testid", "info");
    para.textContent = "Some info";
    root.appendChild(para);

    return root;
  };
}

// ===========================================================================
// createSnapshotStore
// ===========================================================================

describe("createSnapshotStore", () => {
  it("should start empty", () => {
    const store = createSnapshotStore();
    expect(store.list()).toEqual([]);
  });

  it("save() should store a snapshot retrievable via get()", () => {
    const store = createSnapshotStore();
    store.save("alpha", "<div>alpha</div>");
    expect(store.get("alpha")).toBe("<div>alpha</div>");
  });

  it("has() should return true for saved names and false otherwise", () => {
    const store = createSnapshotStore();
    expect(store.has("x")).toBe(false);
    store.save("x", "data");
    expect(store.has("x")).toBe(true);
  });

  it("save() should throw if the name already exists", () => {
    const store = createSnapshotStore();
    store.save("dup", "first");
    expect(() => store.save("dup", "second")).toThrow('Snapshot "dup" already exists');
  });

  it("update() should overwrite an existing snapshot without throwing", () => {
    const store = createSnapshotStore();
    store.save("u", "v1");
    store.update("u", "v2");
    expect(store.get("u")).toBe("v2");
  });

  it("update() should create a snapshot if it does not exist yet", () => {
    const store = createSnapshotStore();
    store.update("new", "value");
    expect(store.get("new")).toBe("value");
  });

  it("delete() should remove a snapshot", () => {
    const store = createSnapshotStore();
    store.save("d", "data");
    store.delete("d");
    expect(store.has("d")).toBe(false);
    expect(store.get("d")).toBeUndefined();
  });

  it("list() should return all snapshot names", () => {
    const store = createSnapshotStore();
    store.save("a", "1");
    store.save("b", "2");
    store.save("c", "3");
    expect(store.list()).toEqual(["a", "b", "c"]);
  });

  it("clear() should remove all snapshots", () => {
    const store = createSnapshotStore();
    store.save("x", "1");
    store.save("y", "2");
    store.clear();
    expect(store.list()).toEqual([]);
    expect(store.has("x")).toBe(false);
  });

  describe("compare()", () => {
    it("should return match:true when snapshot matches", () => {
      const store = createSnapshotStore();
      store.save("cmp", "<div>ok</div>");
      const result = store.compare("cmp", "<div>ok</div>");
      expect(result.match).toBe(true);
      expect(result.diff).toBeUndefined();
    });

    it("should return match:false with diff when snapshot differs", () => {
      const store = createSnapshotStore();
      store.save("cmp2", "<div>old</div>");
      const result = store.compare("cmp2", "<div>new</div>");
      expect(result.match).toBe(false);
      expect(result.diff).toBeDefined();
      expect(result.diff).toContain("-");
      expect(result.diff).toContain("+");
    });

    it("should return match:false when no saved snapshot exists", () => {
      const store = createSnapshotStore();
      const result = store.compare("missing", "<div/>");
      expect(result.match).toBe(false);
      expect(result.diff).toBe("No saved snapshot found.");
    });
  });
});

// ===========================================================================
// snapshotComponent
// ===========================================================================

describe("snapshotComponent", () => {
  it("should serialize a simple component to a deterministic string", () => {
    const snap = snapshotComponent(SimpleDiv("Hello"));
    expect(snap).toBe("<div>Hello</div>");
  });

  it("should serialize nested elements with proper indentation", () => {
    const snap = snapshotComponent(NestedComponent());
    // Attributes are sorted alphabetically: class before id
    expect(snap).toContain('<section class="wrapper" id="root">');
    expect(snap).toContain("  <h1>Title</h1>");
    expect(snap).toContain('  <p data-testid="info">Some info</p>');
    expect(snap).toContain("</section>");
  });

  it("should sort attributes alphabetically for determinism", () => {
    const component = () => {
      const el = document.createElement("div");
      el.setAttribute("z-attr", "1");
      el.setAttribute("a-attr", "2");
      el.setAttribute("m-attr", "3");
      return el;
    };
    const snap = snapshotComponent(component);
    const attrOrder = snap.match(/[a-z]-attr/g);
    expect(attrOrder).toEqual(["a-attr", "m-attr", "z-attr"]);
  });

  it("should handle an empty element", () => {
    const component = () => document.createElement("span");
    const snap = snapshotComponent(component);
    expect(snap).toBe("<span></span>");
  });

  it("should handle multiple children including text nodes", () => {
    const component = () => {
      const el = document.createElement("div");
      el.appendChild(document.createTextNode("text1"));
      const child = document.createElement("span");
      child.textContent = "child";
      el.appendChild(child);
      el.appendChild(document.createTextNode("text2"));
      return el;
    };
    const snap = snapshotComponent(component);
    expect(snap).toContain("text1");
    expect(snap).toContain("<span>child</span>");
    expect(snap).toContain("text2");
  });
});

// ===========================================================================
// matchSnapshot
// ===========================================================================

describe("matchSnapshot", () => {
  it("should save the snapshot and pass on first run (no existing snapshot)", () => {
    const store = createSnapshotStore();
    const result = matchSnapshot(store, "first-run", SimpleDiv("A"));
    expect(result.passed).toBe(true);
    expect(result.snapshot).toBe("<div>A</div>");
    expect(store.has("first-run")).toBe(true);
  });

  it("should pass when the component output matches the saved snapshot", () => {
    const store = createSnapshotStore();
    // First run: save
    matchSnapshot(store, "stable", SimpleDiv("Stable"));
    // Second run: compare (identical)
    const result = matchSnapshot(store, "stable", SimpleDiv("Stable"));
    expect(result.passed).toBe(true);
    expect(result.diff).toBeUndefined();
  });

  it("should fail with diff when the component output differs", () => {
    const store = createSnapshotStore();
    matchSnapshot(store, "changed", SimpleDiv("Original"));
    const result = matchSnapshot(store, "changed", SimpleDiv("Modified"));
    expect(result.passed).toBe(false);
    expect(result.diff).toBeDefined();
    expect(result.diff).toContain("Original");
    expect(result.diff).toContain("Modified");
  });

  it("should overwrite existing snapshot when update:true is passed", () => {
    const store = createSnapshotStore();
    matchSnapshot(store, "updatable", SimpleDiv("V1"));
    const result = matchSnapshot(store, "updatable", SimpleDiv("V2"), {
      update: true,
    });
    expect(result.passed).toBe(true);
    expect(store.get("updatable")).toBe("<div>V2</div>");
  });

  it("update:true should work even on first run (no existing snapshot)", () => {
    const store = createSnapshotStore();
    const result = matchSnapshot(store, "fresh-update", SimpleDiv("X"), {
      update: true,
    });
    expect(result.passed).toBe(true);
    expect(store.get("fresh-update")).toBe("<div>X</div>");
  });
});

// ===========================================================================
// createSnapshotMatcher
// ===========================================================================

describe("createSnapshotMatcher", () => {
  it("toMatchSnapshot should auto-name snapshots with an incrementing counter", () => {
    const store = createSnapshotStore();
    const matcher = createSnapshotMatcher(store);

    matcher.toMatchSnapshot(SimpleDiv("One"));
    matcher.toMatchSnapshot(SimpleDiv("Two"));

    expect(store.has("snapshot_1")).toBe(true);
    expect(store.has("snapshot_2")).toBe(true);
  });

  it("toMatchSnapshot should use an explicit name when provided", () => {
    const store = createSnapshotStore();
    const matcher = createSnapshotMatcher(store);

    matcher.toMatchSnapshot(SimpleDiv("Named"), "my-snap");
    expect(store.has("my-snap")).toBe(true);
  });

  it("toMatchSnapshot should pass on first invocation (snapshot saved)", () => {
    const store = createSnapshotStore();
    const matcher = createSnapshotMatcher(store);

    // Should not throw
    expect(() => matcher.toMatchSnapshot(SimpleDiv("First"))).not.toThrow();
  });

  it("toMatchSnapshot should pass when component output matches saved snapshot", () => {
    const store = createSnapshotStore();
    const matcher = createSnapshotMatcher(store);

    matcher.toMatchSnapshot(SimpleDiv("Same"), "consistent");
    // Second call with identical output
    expect(() => matcher.toMatchSnapshot(SimpleDiv("Same"), "consistent")).not.toThrow();
  });

  it("toMatchSnapshot should throw when component output differs from saved snapshot", () => {
    const store = createSnapshotStore();
    const matcher = createSnapshotMatcher(store);

    matcher.toMatchSnapshot(SimpleDiv("Before"), "drift");
    expect(() => matcher.toMatchSnapshot(SimpleDiv("After"), "drift")).toThrow('Snapshot "drift" does not match');
  });

  it("updateAll() should cause subsequent toMatchSnapshot calls to always pass", () => {
    const store = createSnapshotStore();
    const matcher = createSnapshotMatcher(store);

    matcher.toMatchSnapshot(SimpleDiv("V1"), "evolve");
    matcher.updateAll();

    // This would normally throw because output changed, but updateAll forces update mode
    expect(() => matcher.toMatchSnapshot(SimpleDiv("V2"), "evolve")).not.toThrow();
    // The store should reflect the updated snapshot
    expect(store.get("evolve")).toBe("<div>V2</div>");
  });

  it("updateAll() should affect all subsequent calls, not just the next one", () => {
    const store = createSnapshotStore();
    const matcher = createSnapshotMatcher(store);

    matcher.toMatchSnapshot(SimpleDiv("A"), "s1");
    matcher.toMatchSnapshot(SimpleDiv("B"), "s2");

    matcher.updateAll();

    // Both should update without throwing
    expect(() => matcher.toMatchSnapshot(SimpleDiv("A2"), "s1")).not.toThrow();
    expect(() => matcher.toMatchSnapshot(SimpleDiv("B2"), "s2")).not.toThrow();

    expect(store.get("s1")).toBe("<div>A2</div>");
    expect(store.get("s2")).toBe("<div>B2</div>");
  });
});
