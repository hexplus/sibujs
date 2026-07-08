import { describe, expect, it } from "vitest";
import { captureFingerprint, compareFingerprints, createVisualSuite } from "../src/testing/visualRegression";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a simple element with optional text, classes, styles, and data attrs. */
function createElement(
  tag: string,
  opts: {
    text?: string;
    classes?: string[];
    style?: string;
    dataAttrs?: Record<string, string>;
    children?: Element[];
  } = {},
): Element {
  const el = document.createElement(tag);
  if (opts.text) el.textContent = opts.text;
  if (opts.classes) el.className = opts.classes.join(" ");
  if (opts.style) el.setAttribute("style", opts.style);
  if (opts.dataAttrs) {
    for (const [k, v] of Object.entries(opts.dataAttrs)) {
      el.setAttribute(`data-${k}`, v);
    }
  }
  if (opts.children) {
    for (const child of opts.children) {
      el.appendChild(child);
    }
  }
  return el;
}

/** Build a standard card component for reuse across tests. */
function buildCard(title = "Card Title", body = "Card body") {
  const header = createElement("h2", { text: title, classes: ["card-title"] });
  const content = createElement("p", {
    text: body,
    classes: ["card-body"],
    dataAttrs: { section: "content" },
  });
  return createElement("div", {
    classes: ["card"],
    children: [header, content],
  });
}

// ===========================================================================
// captureFingerprint
// ===========================================================================

describe("captureFingerprint", () => {
  it("should capture structure as a serialized DOM string", () => {
    const el = createElement("div", { text: "Hello" });
    const fp = captureFingerprint(el);
    expect(fp.structure).toBe("<div>Hello</div>");
  });

  it("should capture text content from all descendants", () => {
    const card = buildCard("Title", "Body text");
    const fp = captureFingerprint(card);
    expect(fp.textContent).toContain("Title");
    expect(fp.textContent).toContain("Body text");
  });

  it("should capture element counts by tag name", () => {
    const card = buildCard();
    const fp = captureFingerprint(card);
    expect(fp.elementCounts["div"]).toBe(1);
    expect(fp.elementCounts["h2"]).toBe(1);
    expect(fp.elementCounts["p"]).toBe(1);
  });

  it("should capture classNames sorted alphabetically", () => {
    const el = createElement("div", {
      classes: ["zebra", "alpha", "middle"],
      children: [createElement("span", { classes: ["beta"] })],
    });
    const fp = captureFingerprint(el);
    expect(fp.classNames).toEqual(["alpha", "beta", "middle", "zebra"]);
  });

  it("should capture inline styles sorted alphabetically", () => {
    const child1 = createElement("span", { style: "color: red" });
    const child2 = createElement("span", { style: "border: 1px solid" });
    const el = createElement("div", { children: [child1, child2] });
    const fp = captureFingerprint(el);
    expect(fp.inlineStyles).toEqual(["border: 1px solid", "color: red"]);
  });

  it("should capture data attributes keyed by tag[index].attr", () => {
    const el = createElement("div", {
      dataAttrs: { id: "main" },
      children: [createElement("span", { dataAttrs: { role: "icon" } })],
    });
    const fp = captureFingerprint(el);
    // div is the first div (index 1), span is the first span (index 1)
    expect(fp.dataAttributes["div[1].data-id"]).toBe("main");
    expect(fp.dataAttributes["span[1].data-role"]).toBe("icon");
  });

  it("should produce a deterministic hash for the same element", () => {
    const makeEl = () =>
      createElement("div", {
        text: "deterministic",
        classes: ["a", "b"],
        style: "color: blue",
      });
    const hash1 = captureFingerprint(makeEl()).hash;
    const hash2 = captureFingerprint(makeEl()).hash;
    expect(hash1).toBe(hash2);
    expect(typeof hash1).toBe("string");
    expect(hash1.length).toBe(8); // djb2 produces 8-char hex
  });

  it("should produce different hashes for different elements", () => {
    const el1 = createElement("div", { text: "aaa" });
    const el2 = createElement("div", { text: "bbb" });
    const h1 = captureFingerprint(el1).hash;
    const h2 = captureFingerprint(el2).hash;
    expect(h1).not.toBe(h2);
  });

  it("should handle an element with no classes, styles, or data attrs", () => {
    const el = createElement("span", { text: "plain" });
    const fp = captureFingerprint(el);
    expect(fp.classNames).toEqual([]);
    expect(fp.inlineStyles).toEqual([]);
    expect(fp.dataAttributes).toEqual({});
  });
});

// ===========================================================================
// compareFingerprints
// ===========================================================================

describe("compareFingerprints", () => {
  it("should return match:true for identical elements", () => {
    const make = () => buildCard("Same", "Same");
    const baseline = captureFingerprint(make());
    const current = captureFingerprint(make());
    const result = compareFingerprints(baseline, current);
    expect(result.match).toBe(true);
    expect(result.changes).toEqual([]);
  });

  it("should detect structure changes", () => {
    const baseline = captureFingerprint(
      createElement("div", {
        children: [createElement("span", { text: "A" })],
      }),
    );
    const current = captureFingerprint(
      createElement("div", {
        children: [createElement("em", { text: "A" })],
      }),
    );
    const result = compareFingerprints(baseline, current);
    expect(result.match).toBe(false);
    const types = result.changes.map((c) => c.type);
    expect(types).toContain("structure");
  });

  it("should detect text content changes", () => {
    const baseline = captureFingerprint(createElement("div", { text: "Old text" }));
    const current = captureFingerprint(createElement("div", { text: "New text" }));
    const result = compareFingerprints(baseline, current);
    expect(result.match).toBe(false);
    const textChange = result.changes.find((c) => c.type === "text");
    expect(textChange).toBeDefined();
    expect(textChange?.description).toContain("Old text");
    expect(textChange?.description).toContain("New text");
  });

  it("should detect added classes", () => {
    const baseline = captureFingerprint(createElement("div", { classes: ["base"] }));
    const current = captureFingerprint(createElement("div", { classes: ["base", "extra"] }));
    const result = compareFingerprints(baseline, current);
    expect(result.match).toBe(false);
    const classChange = result.changes.find((c) => c.type === "class");
    expect(classChange).toBeDefined();
    expect(classChange?.description).toContain("Added classes");
    expect(classChange?.description).toContain("extra");
  });

  it("should detect removed classes", () => {
    const baseline = captureFingerprint(createElement("div", { classes: ["keep", "remove"] }));
    const current = captureFingerprint(createElement("div", { classes: ["keep"] }));
    const result = compareFingerprints(baseline, current);
    expect(result.match).toBe(false);
    const classChange = result.changes.find((c) => c.type === "class" && c.description.includes("Removed"));
    expect(classChange).toBeDefined();
    expect(classChange?.description).toContain("remove");
  });

  it("should detect inline style changes", () => {
    const baseline = captureFingerprint(createElement("div", { style: "color: red" }));
    const current = captureFingerprint(createElement("div", { style: "color: blue" }));
    const result = compareFingerprints(baseline, current);
    expect(result.match).toBe(false);
    const styleChange = result.changes.find((c) => c.type === "style");
    expect(styleChange).toBeDefined();
    expect(styleChange?.description).toContain("Inline styles changed");
  });

  it("should detect added and removed inline styles", () => {
    const baseline = captureFingerprint(createElement("div", { style: "margin: 0" }));
    const current = captureFingerprint(createElement("div", { style: "padding: 0" }));
    const result = compareFingerprints(baseline, current);
    const styleChange = result.changes.find((c) => c.type === "style");
    expect(styleChange).toBeDefined();
    expect(styleChange?.description).toContain("added");
    expect(styleChange?.description).toContain("removed");
  });

  it("should detect data attribute changes", () => {
    const baseline = captureFingerprint(createElement("div", { dataAttrs: { version: "1" } }));
    const current = captureFingerprint(createElement("div", { dataAttrs: { version: "2" } }));
    const result = compareFingerprints(baseline, current);
    expect(result.match).toBe(false);
    const dataChange = result.changes.find((c) => c.type === "data");
    expect(dataChange).toBeDefined();
    expect(dataChange?.description).toContain("data-version");
  });

  it("should detect added data attributes", () => {
    const baseline = captureFingerprint(createElement("div"));
    const current = captureFingerprint(createElement("div", { dataAttrs: { new: "attr" } }));
    const result = compareFingerprints(baseline, current);
    expect(result.match).toBe(false);
    const dataChange = result.changes.find((c) => c.type === "data");
    expect(dataChange).toBeDefined();
    expect(dataChange?.description).toContain("added");
  });

  it("should detect removed data attributes", () => {
    const baseline = captureFingerprint(createElement("div", { dataAttrs: { gone: "yes" } }));
    const current = captureFingerprint(createElement("div"));
    const result = compareFingerprints(baseline, current);
    const dataChange = result.changes.find((c) => c.type === "data");
    expect(dataChange).toBeDefined();
    expect(dataChange?.description).toContain("removed");
  });

  it("should detect element count changes", () => {
    const baseline = captureFingerprint(
      createElement("ul", {
        children: [createElement("li", { text: "1" }), createElement("li", { text: "2" })],
      }),
    );
    const current = captureFingerprint(
      createElement("ul", {
        children: [
          createElement("li", { text: "1" }),
          createElement("li", { text: "2" }),
          createElement("li", { text: "3" }),
        ],
      }),
    );
    const result = compareFingerprints(baseline, current);
    expect(result.match).toBe(false);
    const elemChange = result.changes.find((c) => c.type === "elements");
    expect(elemChange).toBeDefined();
    expect(elemChange?.description).toContain("<li>");
    expect(elemChange?.description).toContain("2");
    expect(elemChange?.description).toContain("3");
  });

  it("should report multiple change types simultaneously", () => {
    const baseline = captureFingerprint(
      createElement("div", {
        text: "old",
        classes: ["a"],
        style: "color: red",
      }),
    );
    const current = captureFingerprint(
      createElement("div", {
        text: "new",
        classes: ["b"],
        style: "color: blue",
      }),
    );
    const result = compareFingerprints(baseline, current);
    expect(result.match).toBe(false);
    const types = result.changes.map((c) => c.type);
    expect(types).toContain("text");
    expect(types).toContain("class");
    expect(types).toContain("style");
  });
});

// ===========================================================================
// createVisualSuite
// ===========================================================================

describe("createVisualSuite", () => {
  it("baseline() should save and list() should return it", () => {
    const suite = createVisualSuite();
    const el = createElement("div", { text: "Base" });
    suite.baseline("card", el);
    expect(suite.list()).toEqual(["card"]);
  });

  it("baseline() should throw if the name already exists", () => {
    const suite = createVisualSuite();
    const el = createElement("div", { text: "Dup" });
    suite.baseline("dup", el);
    expect(() => suite.baseline("dup", el)).toThrow('Baseline "dup" already exists');
  });

  it("check() should return match:true when element is unchanged", () => {
    const suite = createVisualSuite();
    const make = () => buildCard("Title", "Body");
    suite.baseline("stable", make());
    const result = suite.check("stable", make());
    expect(result.match).toBe(true);
    expect(result.changes).toEqual([]);
  });

  it("check() should return match:false with changes when element differs", () => {
    const suite = createVisualSuite();
    suite.baseline("drift", buildCard("Title", "Body"));
    const result = suite.check("drift", buildCard("Changed Title", "Body"));
    expect(result.match).toBe(false);
    expect(result.changes.length).toBeGreaterThan(0);
  });

  it("check() should throw if no baseline exists for the name", () => {
    const suite = createVisualSuite();
    const el = createElement("div");
    expect(() => suite.check("nonexistent", el)).toThrow('No baseline found for "nonexistent"');
  });

  it("updateBaseline() should overwrite an existing baseline", () => {
    const suite = createVisualSuite();
    suite.baseline("evolve", buildCard("V1", "Body"));
    // Update the baseline to V2
    suite.updateBaseline("evolve", buildCard("V2", "Body"));
    // Now checking against V2 should match
    const result = suite.check("evolve", buildCard("V2", "Body"));
    expect(result.match).toBe(true);
  });

  it("updateBaseline() should create a new baseline if none exists", () => {
    const suite = createVisualSuite();
    suite.updateBaseline("fresh", buildCard("New", "Baseline"));
    expect(suite.list()).toContain("fresh");
    const result = suite.check("fresh", buildCard("New", "Baseline"));
    expect(result.match).toBe(true);
  });

  it("list() should return all baseline names", () => {
    const suite = createVisualSuite();
    suite.baseline("alpha", createElement("div"));
    suite.baseline("beta", createElement("span"));
    suite.baseline("gamma", createElement("p"));
    expect(suite.list()).toEqual(["alpha", "beta", "gamma"]);
  });

  it("clear() should remove all baselines", () => {
    const suite = createVisualSuite();
    suite.baseline("a", createElement("div"));
    suite.baseline("b", createElement("span"));
    suite.clear();
    expect(suite.list()).toEqual([]);
  });

  it("check() should throw after clear() removes all baselines", () => {
    const suite = createVisualSuite();
    suite.baseline("temp", createElement("div"));
    suite.clear();
    expect(() => suite.check("temp", createElement("div"))).toThrow('No baseline found for "temp"');
  });

  it("full workflow: baseline -> check match -> modify -> check mismatch -> update -> check match", () => {
    const suite = createVisualSuite();

    // Step 1: establish baseline
    suite.baseline("workflow", buildCard("Original", "Content"));

    // Step 2: identical check passes
    const pass = suite.check("workflow", buildCard("Original", "Content"));
    expect(pass.match).toBe(true);

    // Step 3: modified check fails
    const fail = suite.check("workflow", buildCard("Changed", "Content"));
    expect(fail.match).toBe(false);

    // Step 4: update baseline to new version
    suite.updateBaseline("workflow", buildCard("Changed", "Content"));

    // Step 5: check against updated baseline passes
    const passAgain = suite.check("workflow", buildCard("Changed", "Content"));
    expect(passAgain.match).toBe(true);
  });
});
