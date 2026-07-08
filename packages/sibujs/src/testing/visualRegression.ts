/**
 * Visual regression testing utilities for SibuJS.
 * Provides structural comparison of component output for detecting UI regressions.
 * In environments without a real browser, uses DOM structure and computed styles.
 */

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
 * Serialize an element tree to a deterministic string capturing tag names,
 * sorted attributes, and nesting depth.  Similar to createDOMSnapshot in e2e.ts
 * but intentionally self-contained so the visual-regression module has no
 * cross-dependency on the e2e module.
 */
function serializeStructure(el: Element, indent: number): string {
  const pad = "  ".repeat(indent);
  const tag = el.tagName.toLowerCase();

  const attrs = Array.from(el.attributes)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((a) => `${a.name}="${a.value}"`)
    .join(" ");

  const open = attrs ? `${pad}<${tag} ${attrs}>` : `${pad}<${tag}>`;

  const children = Array.from(el.childNodes);

  if (children.length === 0) {
    return `${open}</${tag}>`;
  }

  if (children.length === 1 && children[0].nodeType === 3) {
    const text = children[0].textContent?.trim() || "";
    return `${open}${text}</${tag}>`;
  }

  const childStr = children
    .map((child) => {
      if (child.nodeType === 3) {
        const text = child.textContent?.trim();
        return text ? `${"  ".repeat(indent + 1)}${text}` : "";
      }
      if (child.nodeType === 1) {
        return serializeStructure(child as Element, indent + 1);
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");

  return `${open}\n${childStr}\n${pad}</${tag}>`;
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
  /** Computed hash of the fingerprint */
  hash: string;
}

// ─── Capture Fingerprint ────────────────────────────────────────────────────

/**
 * Capture a visual fingerprint of a component.
 * Includes DOM structure, attributes, text content, and inline styles.
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

  // 7. Compute a composite hash from all the above
  const composite = [
    structure,
    textContent,
    JSON.stringify(elementCounts),
    classNames.join(","),
    inlineStyles.join(";"),
    JSON.stringify(dataAttributes),
  ].join("|");

  const hash = djb2Hash(composite);

  return {
    structure,
    textContent,
    elementCounts,
    classNames,
    inlineStyles,
    dataAttributes,
    hash,
  };
}

// ─── Compare Fingerprints ───────────────────────────────────────────────────

export interface FingerprintChange {
  type: "structure" | "text" | "class" | "style" | "data" | "elements";
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
