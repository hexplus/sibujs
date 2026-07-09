// ============================================================================
// VERSIONING & MIGRATIONS
// ============================================================================

/**
 * Versioning and migration utilities for SibuJS applications.
 * Provides semantic version management, migration tooling, and compatibility checks.
 */

/** Semantic version representation */
export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

/** Migration definition */
export interface Migration {
  version: string;
  description: string;
  up: () => void | Promise<void>;
  down?: () => void | Promise<void>;
}

/**
 * Framework version constant.
 */
export const VERSION = "4.0.0-alpha.0";

// ─── SemVer Parsing ─────────────────────────────────────────────────────────

/**
 * Parse a semantic version string into components.
 */
export function parseSemVer(version: string): SemVer {
  const trimmed = version.trim().replace(/^v/i, "");
  const prereleaseIndex = trimmed.indexOf("-");
  let main: string;
  let prerelease: string | undefined;

  if (prereleaseIndex !== -1) {
    main = trimmed.slice(0, prereleaseIndex);
    prerelease = trimmed.slice(prereleaseIndex + 1);
  } else {
    main = trimmed;
  }

  const parts = main.split(".");
  const major = parseInt(parts[0], 10);
  const minor = parseInt(parts[1] || "0", 10);
  const patch = parseInt(parts[2] || "0", 10);

  if (Number.isNaN(major) || Number.isNaN(minor) || Number.isNaN(patch)) {
    throw new Error(`[Versioning] Invalid semver string: "${version}"`);
  }

  const result: SemVer = { major, minor, patch };
  if (prerelease !== undefined) {
    result.prerelease = prerelease;
  }
  return result;
}

// ─── SemVer Comparison ──────────────────────────────────────────────────────

/**
 * Compare two semantic versions.
 * Returns -1 if a < b, 0 if a === b, 1 if a > b.
 */
export function compareSemVer(a: string | SemVer, b: string | SemVer): -1 | 0 | 1 {
  const va = typeof a === "string" ? parseSemVer(a) : a;
  const vb = typeof b === "string" ? parseSemVer(b) : b;

  // Compare major, minor, patch
  if (va.major !== vb.major) return va.major > vb.major ? 1 : -1;
  if (va.minor !== vb.minor) return va.minor > vb.minor ? 1 : -1;
  if (va.patch !== vb.patch) return va.patch > vb.patch ? 1 : -1;

  // Prerelease comparison: a version without prerelease is greater
  // than one with prerelease (e.g., 1.0.0 > 1.0.0-alpha)
  if (va.prerelease === undefined && vb.prerelease === undefined) return 0;
  if (va.prerelease === undefined) return 1;
  if (vb.prerelease === undefined) return -1;

  // Both have prerelease — compare lexicographically by dot-separated identifiers
  const aParts = va.prerelease.split(".");
  const bParts = vb.prerelease.split(".");
  const len = Math.max(aParts.length, bParts.length);

  for (let i = 0; i < len; i++) {
    if (i >= aParts.length) return -1; // fewer identifiers = lower precedence
    if (i >= bParts.length) return 1;

    const aId = aParts[i];
    const bId = bParts[i];

    const aNum = parseInt(aId, 10);
    const bNum = parseInt(bId, 10);
    const aIsNum = !Number.isNaN(aNum) && String(aNum) === aId;
    const bIsNum = !Number.isNaN(bNum) && String(bNum) === bId;

    if (aIsNum && bIsNum) {
      if (aNum !== bNum) return aNum > bNum ? 1 : -1;
    } else if (aIsNum) {
      return -1; // numeric identifiers always have lower precedence
    } else if (bIsNum) {
      return 1;
    } else {
      // Both are strings — compare lexicographically
      if (aId < bId) return -1;
      if (aId > bId) return 1;
    }
  }

  return 0;
}

// ─── Range Matching ─────────────────────────────────────────────────────────

/**
 * Check if a version satisfies a semver range (supports ^, ~, >=, <=, =).
 */
export function satisfies(version: string, range: string): boolean {
  const v = parseSemVer(version);
  const trimmed = range.trim();

  // Handle OR ranges separated by ||
  if (trimmed.includes("||")) {
    return trimmed.split("||").some((part) => satisfies(version, part.trim()));
  }

  // Handle AND ranges separated by spaces (e.g., ">=1.0.0 <2.0.0")
  if (/\s+/.test(trimmed) && !trimmed.startsWith("^") && !trimmed.startsWith("~")) {
    const parts = trimmed.split(/\s+/);
    return parts.every((part) => satisfies(version, part));
  }

  // Caret range: ^major.minor.patch
  // Allows changes that do not modify the left-most non-zero digit
  if (trimmed.startsWith("^")) {
    const target = parseSemVer(trimmed.slice(1));
    if (v.major !== target.major) return false;
    if (target.major === 0) {
      if (v.minor !== target.minor) return false;
      if (target.minor === 0) {
        return v.patch === target.patch;
      }
      return v.patch >= target.patch;
    }
    return compareSemVer(v, target) >= 0;
  }

  // Tilde range: ~major.minor.patch
  // Allows patch-level changes
  if (trimmed.startsWith("~")) {
    const target = parseSemVer(trimmed.slice(1));
    return v.major === target.major && v.minor === target.minor && v.patch >= target.patch;
  }

  // Greater than or equal: >=major.minor.patch
  if (trimmed.startsWith(">=")) {
    const target = parseSemVer(trimmed.slice(2));
    return compareSemVer(v, target) >= 0;
  }

  // Less than or equal: <=major.minor.patch
  if (trimmed.startsWith("<=")) {
    const target = parseSemVer(trimmed.slice(2));
    return compareSemVer(v, target) <= 0;
  }

  // Greater than: >major.minor.patch
  if (trimmed.startsWith(">") && !trimmed.startsWith(">=")) {
    const target = parseSemVer(trimmed.slice(1));
    return compareSemVer(v, target) > 0;
  }

  // Less than: <major.minor.patch
  if (trimmed.startsWith("<") && !trimmed.startsWith("<=")) {
    const target = parseSemVer(trimmed.slice(1));
    return compareSemVer(v, target) < 0;
  }

  // Exact match: =major.minor.patch or just major.minor.patch
  const exactStr = trimmed.startsWith("=") ? trimmed.slice(1) : trimmed;
  const target = parseSemVer(exactStr);
  return compareSemVer(v, target) === 0;
}

// ─── Migration Runner ───────────────────────────────────────────────────────

/**
 * Create a migration runner for managing schema/state version upgrades.
 */
export function createMigrationRunner(config: {
  /** Current version of the app/data */
  currentVersion: string;
  /** Storage key for persisting applied migration version */
  storageKey?: string;
  /** Available migrations, sorted by version */
  migrations: Migration[];
}) {
  const storageKey = config.storageKey || "__sibu_migration_version__";

  // Sort migrations by version ascending
  const sortedMigrations = [...config.migrations].sort((a, b) => compareSemVer(a.version, b.version));

  function getStorage(): Storage | null {
    try {
      return typeof localStorage !== "undefined" ? localStorage : null;
      // Accessing `localStorage` throws SecurityError in sandboxed iframes /
      // privacy modes — defensive guard, not reachable under the test runner.
      /* v8 ignore next 3 */
    } catch {
      return null;
    }
  }

  return {
    /** Get the last applied migration version from storage */
    getAppliedVersion(): string | null {
      const storage = getStorage();
      if (!storage) return null;
      return storage.getItem(storageKey);
    },

    /** Get pending migrations that haven't been applied */
    getPending(): Migration[] {
      const appliedVersion = this.getAppliedVersion();

      if (!appliedVersion) {
        // No migrations applied yet — all migrations up to currentVersion are pending
        return sortedMigrations.filter((m) => compareSemVer(m.version, config.currentVersion) <= 0);
      }

      // Return migrations after the applied version and up to currentVersion
      return sortedMigrations.filter(
        (m) => compareSemVer(m.version, appliedVersion) > 0 && compareSemVer(m.version, config.currentVersion) <= 0,
      );
    },

    /** Run all pending migrations in order */
    async migrate(): Promise<{
      applied: string[];
      errors: Array<{ version: string; error: Error }>;
    }> {
      const pending = this.getPending();
      const applied: string[] = [];
      const errors: Array<{ version: string; error: Error }> = [];

      for (const migration of pending) {
        try {
          await migration.up();
          applied.push(migration.version);

          // Persist the last successfully applied version
          const storage = getStorage();
          if (storage) {
            storage.setItem(storageKey, migration.version);
          }
        } catch (e) {
          errors.push({
            version: migration.version,
            error: e instanceof Error ? e : new Error(String(e)),
          });
          // Stop on first error — don't apply further migrations
          break;
        }
      }

      return { applied, errors };
    },

    /** Rollback to a specific version */
    async rollback(targetVersion: string): Promise<{ rolledBack: string[] }> {
      const appliedVersion = this.getAppliedVersion();
      const rolledBack: string[] = [];

      if (!appliedVersion) {
        return { rolledBack };
      }

      // Get migrations that need to be rolled back (in reverse order)
      const toRollback = sortedMigrations
        .filter((m) => compareSemVer(m.version, targetVersion) > 0 && compareSemVer(m.version, appliedVersion) <= 0)
        .reverse();

      for (const migration of toRollback) {
        if (!migration.down) {
          throw new Error(
            `[Versioning] Migration ${migration.version} ("${migration.description}") does not have a down() function and cannot be rolled back.`,
          );
        }

        await migration.down();
        rolledBack.push(migration.version);
      }

      // Update stored version to the target
      const storage = getStorage();
      if (storage) {
        if (targetVersion === "0.0.0") {
          storage.removeItem(storageKey);
        } else {
          storage.setItem(storageKey, targetVersion);
        }
      }

      return { rolledBack };
    },
  };
}

// ─── Compatibility Check ────────────────────────────────────────────────────

/**
 * Check compatibility between framework version and app version.
 */
export function checkCompatibility(
  frameworkVersion: string,
  requiredRange: string,
): { compatible: boolean; message: string } {
  const compatible = satisfies(frameworkVersion, requiredRange);

  if (compatible) {
    return {
      compatible: true,
      message: `Framework version ${frameworkVersion} is compatible with required range "${requiredRange}".`,
    };
  }

  const fv = parseSemVer(frameworkVersion);
  const rangeTarget = extractRangeTarget(requiredRange);

  let message = `Framework version ${frameworkVersion} is NOT compatible with required range "${requiredRange}".`;

  if (rangeTarget) {
    const tv = parseSemVer(rangeTarget);
    if (fv.major < tv.major) {
      message += ` A major upgrade is required (${fv.major}.x -> ${tv.major}.x).`;
    } else if (fv.major > tv.major) {
      message += " The framework version is ahead of the required range. Consider updating the dependency requirement.";
    }
  }

  return { compatible, message };
}

/**
 * Extract the base version from a range string for diagnostic purposes.
 */
function extractRangeTarget(range: string): string | null {
  const match = range.match(/[\d]+\.[\d]+\.[\d]+(?:-[\w.]+)?/);
  return match ? match[0] : null;
}
