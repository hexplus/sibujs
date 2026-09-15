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
  /** Build metadata (after `+`). Ignored when comparing versions. */
  build?: string;
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
export const VERSION = "1.0.0";

// ─── SemVer Parsing ─────────────────────────────────────────────────────────

// A numeric identifier: 0, or a non-zero digit followed by digits (no leading zeros).
const NUM = "(?:0|[1-9]\\d*)";
// A prerelease identifier: numeric (no leading zeros), or alphanumeric with at least one non-digit.
const PRE_ID = `(?:${NUM}|\\d*[a-zA-Z-][0-9a-zA-Z-]*)`;
// A build identifier: any non-empty run of [0-9A-Za-z-].
const BUILD_ID = "[0-9a-zA-Z-]+";

/**
 * Fully anchored grammar. `major` is required; `minor` and `patch` may be
 * omitted (the abbreviated `1` / `1.2` forms default them to 0), but a
 * prerelease or build suffix requires the full `major.minor.patch`, as in SemVer.
 */
const SEMVER_PATTERN = new RegExp(
  `^(${NUM})(?:\\.(${NUM})(?:\\.(${NUM})(?:-(${PRE_ID}(?:\\.${PRE_ID})*))?(?:\\+(${BUILD_ID}(?:\\.${BUILD_ID})*))?)?)?$`,
);

/**
 * Parse a semantic version string into components.
 *
 * Accepts full SemVer 2.0.0 (`1.2.3`, `1.2.3-beta.1`, `1.2.3+build.5`), an
 * optional leading `v`, surrounding whitespace, and the abbreviated `1` and
 * `1.2` forms. Anything else — trailing characters, extra components, empty or
 * illegal identifiers, numeric leading zeros — throws. (`parseInt` used to accept
 * numeric prefixes such as `1.2.3garbage` and ignore extra components.)
 */
export function parseSemVer(version: string): SemVer {
  const trimmed = String(version).trim().replace(/^v/i, "");
  const match = SEMVER_PATTERN.exec(trimmed);
  if (!match) {
    throw new Error(`[Versioning] Invalid semver string: "${version}"`);
  }

  const result: SemVer = {
    major: Number(match[1]),
    minor: match[2] === undefined ? 0 : Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3]),
  };
  if (match[4] !== undefined) result.prerelease = match[4];
  if (match[5] !== undefined) result.build = match[5];
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
 * A migration step succeeded but recording its version in storage failed.
 *
 * Reported separately from a failing `up()` / `down()` because the migration's
 * own work DID happen: storage is now behind reality and needs attention, but
 * the step itself must not be retried as if it had failed.
 */
export class MigrationStorageError extends Error {
  /** The migration whose checkpoint could not be written. */
  readonly version: string;

  constructor(version: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`[Versioning] Migration ${version} completed, but recording it in storage failed: ${reason}`);
    this.name = "MigrationStorageError";
    this.version = version;
    (this as { cause?: unknown }).cause = cause;
  }
}

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

  function getAppliedVersion(): string | null {
    const storage = getStorage();
    if (!storage) return null;
    return storage.getItem(storageKey);
  }

  function getPending(): Migration[] {
    const appliedVersion = getAppliedVersion();

    if (!appliedVersion) {
      // No migrations applied yet — all migrations up to currentVersion are pending
      return sortedMigrations.filter((m) => compareSemVer(m.version, config.currentVersion) <= 0);
    }

    // Return migrations after the applied version and up to currentVersion
    return sortedMigrations.filter(
      (m) => compareSemVer(m.version, appliedVersion) > 0 && compareSemVer(m.version, config.currentVersion) <= 0,
    );
  }

  /** Record `version` as the applied version; `null` removes the key. */
  function writeApplied(version: string | null, migrationVersion: string): void {
    const storage = getStorage();
    if (!storage) return;
    try {
      if (version === null) storage.removeItem(storageKey);
      else storage.setItem(storageKey, version);
    } catch (e) {
      throw new MigrationStorageError(migrationVersion, e);
    }
  }

  // Serializes migrate() and rollback(). Each operation reads the stored version
  // only after the previous one has fully finished, so concurrent calls can
  // never compute — and run — the same pending migrations twice. A failed
  // operation still releases the queue.
  let operationQueue: Promise<unknown> = Promise.resolve();
  function serialize<R>(operation: () => Promise<R>): Promise<R> {
    const run = operationQueue.then(operation, operation);
    operationQueue = run.catch(() => undefined);
    return run;
  }

  return {
    /** Get the last applied migration version from storage */
    getAppliedVersion,

    /** Get pending migrations that haven't been applied */
    getPending,

    /**
     * Run all pending migrations in order. Concurrent calls (and calls racing
     * `rollback()`) run one after another, each recomputing what is pending.
     */
    migrate(): Promise<{
      applied: string[];
      errors: Array<{ version: string; error: Error }>;
    }> {
      return serialize(async () => {
        const pending = getPending();
        const applied: string[] = [];
        const errors: Array<{ version: string; error: Error }> = [];

        for (const migration of pending) {
          try {
            await migration.up();
          } catch (e) {
            errors.push({
              version: migration.version,
              error: e instanceof Error ? e : new Error(String(e)),
            });
            // Stop on first error — don't apply further migrations
            break;
          }
          applied.push(migration.version);

          // Persist the last successfully applied version. A write failure is a
          // storage error, not a failed up(): the migration did run.
          try {
            writeApplied(migration.version, migration.version);
          } catch (e) {
            errors.push({ version: migration.version, error: e as MigrationStorageError });
            break;
          }
        }

        return { applied, errors };
      });
    },

    /**
     * Rollback to a specific version.
     *
     * The applied version is checkpointed after EVERY successful `down()`, so a
     * rollback that fails part-way leaves storage describing what is actually
     * still applied, and a retry does not repeat completed `down()` steps.
     * Throws the failing `down()`'s error, a missing-`down()` error, or a
     * {@link MigrationStorageError} if a checkpoint cannot be written.
     */
    rollback(targetVersion: string): Promise<{ rolledBack: string[] }> {
      return serialize(async () => {
        const appliedVersion = getAppliedVersion();
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

          // Checkpoint: the newest migration below this one is now the applied
          // version; with none left, nothing is applied.
          const index = sortedMigrations.indexOf(migration);
          const previous = index > 0 ? sortedMigrations[index - 1].version : null;
          writeApplied(previous, migration.version);
        }

        // Update stored version to the target
        writeApplied(targetVersion === "0.0.0" ? null : targetVersion, targetVersion);

        return { rolledBack };
      });
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
