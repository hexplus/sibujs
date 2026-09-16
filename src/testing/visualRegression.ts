/**
 * Visual regression testing utilities for SibuJS.
 * Provides structural comparison of component output for detecting UI regressions.
 * In environments without a real browser, uses DOM structure and computed styles.
 */

import { serializeDom } from "./serializeDom";

// ─── Hashing ────────────────────────────────────────────────────────────────

/**
 * Simple deterministic string hash (djb2).
 * Produces a consistent hex string from arbitrary input.
 */
function djb2Hash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// ─── Element Walking ────────────────────────────────────────────────────────

/**
 * Recursively collect every Element within a root (inclusive).
 */
function walkElements(root: Element): Element[] {
  const elements: Element[] = [root];
  for (const child of Array.from(root.children)) {
    elements.push(...walkElements(child));
  }
  return elements;
}

// ─── Structure Serialization ────────────────────────────────────────────────

/**
 * Serialize an element tree to a deterministic, escaped string capturing tag
 * names, sorted attributes, text and nesting depth.
 */
function serializeStructure(el: Element, indent: number): string {
  return serializeDom(el, indent);
}

// ─── Computed Styles ────────────────────────────────────────────────────────

/**
 * Computed properties that determine appearance. Styles coming from
 * stylesheets, inherited values and custom properties never show up in the
 * markup, so without these a stylesheet-only regression went undetected.
 */
const APPEARANCE_PROPERTIES = [
  "display",
  "visibility",
  "opacity",
  "position",
  "color",
  "background-color",
  "background-image",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "text-align",
  "text-decoration",
  "text-transform",
  "width",
  "height",
  "margin",
  "padding",
  "border",
  "border-radius",
  "box-shadow",
  "transform",
  "z-index",
  "overflow",
  "flex-direction",
  "justify-content",
  "align-items",
  "gap",
] as const;

/**
 * Capture the appearance-relevant computed style of every element, in tree
 * order (`tag[n]: prop:value; ...`). Empty values are omitted. Environments
 * without `getComputedStyle` produce an empty list.
 */
function captureComputedStyles(elements: Element[]): string[] {
  const view = elements[0]?.ownerDocument?.defaultView;
  if (!view || typeof view.getComputedStyle !== "function") return [];
  const counters: Record<string, number> = {};
  return elements.map((el) => {
    const tag = el.tagName.toLowerCase();
    counters[tag] = (counters[tag] || 0) + 1;
    let declarations = "";
    try {
      const style = view.getComputedStyle(el);
      for (const property of APPEARANCE_PROPERTIES) {
        const value = style.getPropertyValue(property);
        if (value) declarations += `${property}:${value};`;
      }
    } catch {
      // Unsupported element or environment — record the element without styles.
    }
    return `${tag}[${counters[tag]}]: ${declarations}`;
  });
}

// ─── Fingerprint Type ───────────────────────────────────────────────────────

export interface VisualFingerprint {
  /** Serialized DOM structure */
  structure: string;
  /** All text content */
  textContent: string;
  /** Count of elements by tag */
  elementCounts: Record<string, number>;
  /** All unique class names used */
  classNames: string[];
  /** All inline styles */
  inlineStyles: string[];
  /** Data attributes */
  dataAttributes: Record<string, string>;
  /**
   * Appearance-relevant computed styles per element, in tree order. Captures
   * stylesheet, inherited and custom-property driven changes that leave the
   * markup untouched.
   */
  computedStyles: string[];
  /** Computed hash of the fingerprint */
  hash: string;
}

// ─── Capture Fingerprint ────────────────────────────────────────────────────

/**
 * Capture a visual fingerprint of a component.
 * Includes DOM structure, attributes, text content, inline styles and the
 * appearance-relevant computed styles of every element.
 */
export function captureFingerprint(element: Element): VisualFingerprint {
  const allElements = walkElements(element);

  // 1. Serialized DOM structure
  const structure = serializeStructure(element, 0);

  // 2. Aggregated text content
  const textContent = (element.textContent || "").replace(/\s+/g, " ").trim();

  // 3. Element counts by tag name
  const elementCounts: Record<string, number> = {};
  for (const el of allElements) {
    const tag = el.tagName.toLowerCase();
    elementCounts[tag] = (elementCounts[tag] || 0) + 1;
  }

  // 4. Unique class names (sorted for determinism)
  const classSet = new Set<string>();
  for (const el of allElements) {
    for (const cls of Array.from(el.classList)) {
      classSet.add(cls);
    }
  }
  const classNames = Array.from(classSet).sort();

  // 5. Inline styles
  const inlineStyles: string[] = [];
  for (const el of allElements) {
    const style = el.getAttribute("style");
    if (style) {
      inlineStyles.push(style.trim());
    }
  }
  inlineStyles.sort();

  // 6. Data attributes (data-*) collected from all elements, keyed by
  //    "tagName[n].attributeName" to keep them traceable when the same
  //    data attribute appears on different elements.
  const dataAttributes: Record<string, string> = {};
  const tagCounters: Record<string, number> = {};
  for (const el of allElements) {
    const tag = el.tagName.toLowerCase();
    tagCounters[tag] = (tagCounters[tag] || 0) + 1;
    const idx = tagCounters[tag];
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith("data-")) {
        dataAttributes[`${tag}[${idx}].${attr.name}`] = attr.value;
      }
    }
  }

  // 7. Computed appearance (stylesheets, inheritance, custom properties)
  const computedStyles = captureComputedStyles(allElements);

  // 8. Compute a composite hash from all the above. JSON keeps the parts
  //    unambiguous: no separator inside one part can shift content into another.
  const composite = JSON.stringify([
    structure,
    textContent,
    elementCounts,
    classNames,
    inlineStyles,
    dataAttributes,
    computedStyles,
  ]);

  const hash = djb2Hash(composite);

  return {
    structure,
    textContent,
    elementCounts,
    classNames,
    inlineStyles,
    dataAttributes,
    computedStyles,
    hash,
  };
}

// ─── Compare Fingerprints ───────────────────────────────────────────────────

export interface FingerprintChange {
  type: "structure" | "text" | "class" | "style" | "data" | "elements" | "computed";
  description: string;
}

/**
 * Compare two visual fingerprints and report differences.
 */
export function compareFingerprints(
  baseline: VisualFingerprint,
  current: VisualFingerprint,
): {
  match: boolean;
  changes: FingerprintChange[];
} {
  const changes: FingerprintChange[] = [];

  // 1. Structure
  if (baseline.structure !== current.structure) {
    changes.push({
      type: "structure",
      description: "DOM structure has changed.",
    });
  }

  // 2. Text content
  if (baseline.textContent !== current.textContent) {
    changes.push({
      type: "text",
      description: `Text content changed: "${truncate(baseline.textContent, 80)}" -> "${truncate(current.textContent, 80)}"`,
    });
  }

  // 3. Element counts
  const allTags = new Set([...Object.keys(baseline.elementCounts), ...Object.keys(current.elementCounts)]);
  for (const tag of allTags) {
    const bCount = baseline.elementCounts[tag] || 0;
    const cCount = current.elementCounts[tag] || 0;
    if (bCount !== cCount) {
      changes.push({
        type: "elements",
        description: `<${tag}> count changed: ${bCount} -> ${cCount}`,
      });
    }
  }

  // 4. Class names
  const addedClasses = current.classNames.filter((c) => !baseline.classNames.includes(c));
  const removedClasses = baseline.classNames.filter((c) => !current.classNames.includes(c));
  if (addedClasses.length > 0) {
    changes.push({
      type: "class",
      description: `Added classes: ${addedClasses.join(", ")}`,
    });
  }
  if (removedClasses.length > 0) {
    changes.push({
      type: "class",
      description: `Removed classes: ${removedClasses.join(", ")}`,
    });
  }

  // 5. Inline styles
  const baselineStyleSet = new Set(baseline.inlineStyles);
  const currentStyleSet = new Set(current.inlineStyles);
  const addedStyles = current.inlineStyles.filter((s) => !baselineStyleSet.has(s));
  const removedStyles = baseline.inlineStyles.filter((s) => !currentStyleSet.has(s));
  if (addedStyles.length > 0 || removedStyles.length > 0) {
    const parts: string[] = [];
    if (addedStyles.length > 0) parts.push(`added: ${addedStyles.join("; ")}`);
    if (removedStyles.length > 0) parts.push(`removed: ${removedStyles.join("; ")}`);
    changes.push({
      type: "style",
      description: `Inline styles changed (${parts.join(", ")})`,
    });
  }

  // 6. Data attributes
  const allDataKeys = new Set([...Object.keys(baseline.dataAttributes), ...Object.keys(current.dataAttributes)]);
  const dataChanges: string[] = [];
  for (const key of allDataKeys) {
    const bVal = baseline.dataAttributes[key];
    const cVal = current.dataAttributes[key];
    if (bVal === undefined) {
      dataChanges.push(`added ${key}="${cVal}"`);
    } else if (cVal === undefined) {
      dataChanges.push(`removed ${key}="${bVal}"`);
    } else if (bVal !== cVal) {
      dataChanges.push(`changed ${key}: "${bVal}" -> "${cVal}"`);
    }
  }
  if (dataChanges.length > 0) {
    changes.push({
      type: "data",
      description: `Data attributes changed: ${dataChanges.join("; ")}`,
    });
  }

  // 7. Computed styles (fingerprints captured before this field existed have none)
  const baselineComputed = baseline.computedStyles ?? [];
  const currentComputed = current.computedStyles ?? [];
  const computedChanges: string[] = [];
  for (let i = 0; i < Math.max(baselineComputed.length, currentComputed.length); i++) {
    if (baselineComputed[i] !== currentComputed[i]) {
      computedChanges.push(currentComputed[i] ?? baselineComputed[i]);
    }
  }
  if (computedChanges.length > 0) {
    changes.push({
      type: "computed",
      description: `Computed styles changed on ${computedChanges.length} element(s): ${truncate(computedChanges.join(" | "), 200)}`,
    });
  }

  return {
    match: changes.length === 0,
    changes,
  };
}

// ─── Visual Regression Suite ────────────────────────────────────────────────

/**
 * Create a visual regression test suite.
 * Manages baseline fingerprints and comparison.
 */
export function createVisualSuite(): {
  /** Capture and save a baseline for a component */
  baseline: (name: string, element: Element) => void;
  /** Compare current element against saved baseline */
  check: (name: string, element: Element) => { match: boolean; changes: FingerprintChange[] };
  /** Update a baseline */
  updateBaseline: (name: string, element: Element) => void;
  /** List all baselines */
  list: () => string[];
  /** Clear all baselines */
  clear: () => void;
} {
  const baselines = new Map<string, VisualFingerprint>();

  return {
    baseline(name: string, element: Element): void {
      if (baselines.has(name)) {
        throw new Error(`Baseline "${name}" already exists. Use updateBaseline() to overwrite.`);
      }
      baselines.set(name, captureFingerprint(element));
    },

    check(name: string, element: Element): { match: boolean; changes: FingerprintChange[] } {
      const saved = baselines.get(name);
      if (!saved) {
        throw new Error(`No baseline found for "${name}". Call baseline() first to capture one.`);
      }
      const current = captureFingerprint(element);
      return compareFingerprints(saved, current);
    },

    updateBaseline(name: string, element: Element): void {
      baselines.set(name, captureFingerprint(element));
    },

    list(): string[] {
      return Array.from(baselines.keys());
    },

    clear(): void {
      baselines.clear();
    },
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen - 3)}...`;
}
