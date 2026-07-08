/**
 * Snapshot testing utilities for SibuJS components.
 * Capture and compare component output over time.
 */

// ─── DOM Serialization ──────────────────────────────────────────────────────

/**
 * Serialize an element to a deterministic, indented string.
 * Attributes are sorted alphabetically to ensure consistent output.
 */
function serializeElement(el: Element, indent: number): string {
  const pad = "  ".repeat(indent);
  const tag = el.tagName.toLowerCase();

  // Sort attributes alphabetically for deterministic output
  const attrs = Array.from(el.attributes)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((a) => `${a.name}="${a.value}"`)
    .join(" ");

  const open = attrs ? `${pad}<${tag} ${attrs}>` : `${pad}<${tag}>`;

  const children = Array.from(el.childNodes);

  // Self-closing / empty element
  if (children.length === 0) {
    return `${open}</${tag}>`;
  }

  // Single text node child — keep inline
  if (children.length === 1 && children[0].nodeType === 3) {
    const text = children[0].textContent?.trim() || "";
    return `${open}${text}</${tag}>`;
  }

  // Multiple children — each on its own line
  const childStr = children
    .map((child) => {
      if (child.nodeType === 3) {
        const text = child.textContent?.trim();
        return text ? `${"  ".repeat(indent + 1)}${text}` : "";
      }
      if (child.nodeType === 1) {
        return serializeElement(child as Element, indent + 1);
      }
      // Comment nodes
      if (child.nodeType === 8) {
        return `${"  ".repeat(indent + 1)}<!-- ${child.textContent?.trim() || ""} -->`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");

  return `${open}\n${childStr}\n${pad}</${tag}>`;
}

// ─── Simple Diff ────────────────────────────────────────────────────────────

/**
 * Produce a human-readable diff between two multi-line strings.
 * Lines prefixed with `-` are in `a` only, `+` are in `b` only.
 */
function simpleDiff(a: string, b: string): string {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const result: string[] = [];
  const maxLen = Math.max(aLines.length, bLines.length);

  for (let i = 0; i < maxLen; i++) {
    const aLine = i < aLines.length ? aLines[i] : undefined;
    const bLine = i < bLines.length ? bLines[i] : undefined;

    if (aLine === bLine) {
      result.push(`  ${aLine}`);
    } else {
      if (aLine !== undefined) result.push(`- ${aLine}`);
      if (bLine !== undefined) result.push(`+ ${bLine}`);
    }
  }

  return result.join("\n");
}

// ─── Snapshot Store ─────────────────────────────────────────────────────────

/**
 * Snapshot store for managing saved snapshots.
 * In a real environment, these would be persisted to disk by the test framework.
 * This provides the in-memory API that adapters can hook into.
 */
export function createSnapshotStore(): {
  /** Save a snapshot with a given name */
  save: (name: string, snapshot: string) => void;
  /** Get a saved snapshot */
  get: (name: string) => string | undefined;
  /** Check if a snapshot exists */
  has: (name: string) => boolean;
  /** Compare a snapshot against a saved one. Returns null if match, diff string if mismatch */
  compare: (name: string, current: string) => { match: boolean; diff?: string };
  /** Update a saved snapshot */
  update: (name: string, snapshot: string) => void;
  /** Delete a snapshot */
  delete: (name: string) => void;
  /** List all snapshot names */
  list: () => string[];
  /** Clear all snapshots */
  clear: () => void;
} {
  const snapshots = new Map<string, string>();

  return {
    save(name: string, snapshot: string): void {
      if (snapshots.has(name)) {
        throw new Error(`Snapshot "${name}" already exists. Use update() to overwrite.`);
      }
      snapshots.set(name, snapshot);
    },

    get(name: string): string | undefined {
      return snapshots.get(name);
    },

    has(name: string): boolean {
      return snapshots.has(name);
    },

    compare(name: string, current: string): { match: boolean; diff?: string } {
      const saved = snapshots.get(name);
      if (saved === undefined) {
        return { match: false, diff: "No saved snapshot found." };
      }
      if (saved === current) {
        return { match: true };
      }
      return { match: false, diff: simpleDiff(saved, current) };
    },

    update(name: string, snapshot: string): void {
      snapshots.set(name, snapshot);
    },

    delete(name: string): void {
      snapshots.delete(name);
    },

    list(): string[] {
      return Array.from(snapshots.keys());
    },

    clear(): void {
      snapshots.clear();
    },
  };
}

// ─── Component Snapshot ─────────────────────────────────────────────────────

/**
 * Create a serialized snapshot of a SibuJS component.
 * Renders the component and serializes the DOM tree to a deterministic string.
 */
export function snapshotComponent(component: () => HTMLElement): string {
  const container = document.createElement("div");
  const element = component();
  container.appendChild(element);

  // Serialize the rendered element (the component root), not the wrapper container
  return serializeElement(element, 0);
}

// ─── Match Snapshot ─────────────────────────────────────────────────────────

/**
 * Assert that a component matches its saved snapshot.
 * On first run (no saved snapshot), saves the snapshot.
 * On subsequent runs, compares against the saved snapshot.
 *
 * @param store    - The snapshot store to read/write from
 * @param name     - A unique name identifying this snapshot
 * @param component - A factory function that creates the component element
 * @param options  - Optional: set `update: true` to forcibly overwrite the saved snapshot
 * @returns An object with `passed`, the rendered `snapshot`, and an optional `diff`
 */
export function matchSnapshot(
  store: ReturnType<typeof createSnapshotStore>,
  name: string,
  component: () => HTMLElement,
  options?: { update?: boolean },
): { passed: boolean; snapshot: string; diff?: string } {
  const snapshot = snapshotComponent(component);

  // Force-update mode: overwrite existing snapshot and pass
  if (options?.update) {
    store.update(name, snapshot);
    return { passed: true, snapshot };
  }

  // First run — no saved snapshot yet. Save and pass.
  if (!store.has(name)) {
    store.save(name, snapshot);
    return { passed: true, snapshot };
  }

  // Compare against saved snapshot
  const result = store.compare(name, snapshot);
  return {
    passed: result.match,
    snapshot,
    diff: result.diff,
  };
}

// ─── Snapshot Matcher ───────────────────────────────────────────────────────

/**
 * Create a snapshot matcher that auto-generates names based on describe/test context.
 * Provides a convenient API similar to Jest's `toMatchSnapshot()`.
 *
 * @param store - The snapshot store to use for saving/comparing
 */
export function createSnapshotMatcher(store: ReturnType<typeof createSnapshotStore>): {
  /** Assert current component output matches saved snapshot */
  toMatchSnapshot: (component: () => HTMLElement, name?: string) => void;
  /** Update all snapshots in this matcher */
  updateAll: () => void;
} {
  let counter = 0;
  let updateMode = false;

  return {
    toMatchSnapshot(component: () => HTMLElement, name?: string): void {
      const snapshotName = name ?? `snapshot_${++counter}`;
      const result = matchSnapshot(store, snapshotName, component, {
        update: updateMode,
      });

      if (!result.passed) {
        throw new Error(`Snapshot "${snapshotName}" does not match.\n\n${result.diff ?? ""}`);
      }
    },

    updateAll(): void {
      updateMode = true;
    },
  };
}
