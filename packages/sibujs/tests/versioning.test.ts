import { beforeEach, describe, expect, it } from "vitest";
import {
  checkCompatibility,
  compareSemVer,
  createMigrationRunner,
  parseSemVer,
  satisfies,
} from "../src/plugins/versioning";

// ─── parseSemVer ────────────────────────────────────────────────────────────

describe("parseSemVer", () => {
  it("should parse a basic version string", () => {
    const v = parseSemVer("1.2.3");
    expect(v).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it("should parse a version with prerelease", () => {
    const v = parseSemVer("1.0.0-beta.1");
    expect(v).toEqual({ major: 1, minor: 0, patch: 0, prerelease: "beta.1" });
  });

  it("should parse a version with v prefix", () => {
    const v = parseSemVer("v2.1.0");
    expect(v).toEqual({ major: 2, minor: 1, patch: 0 });
  });

  it("should handle missing minor and patch", () => {
    const v = parseSemVer("3");
    expect(v).toEqual({ major: 3, minor: 0, patch: 0 });
  });

  it("should handle missing patch", () => {
    const v = parseSemVer("2.5");
    expect(v).toEqual({ major: 2, minor: 5, patch: 0 });
  });

  it("should trim whitespace", () => {
    const v = parseSemVer("  1.0.0  ");
    expect(v).toEqual({ major: 1, minor: 0, patch: 0 });
  });

  it("should throw on invalid version string", () => {
    expect(() => parseSemVer("not.a.version")).toThrow('[Versioning] Invalid semver string: "not.a.version"');
  });

  it("should parse prerelease with alpha label", () => {
    const v = parseSemVer("0.1.0-alpha");
    expect(v).toEqual({ major: 0, minor: 1, patch: 0, prerelease: "alpha" });
  });
});

// ─── compareSemVer ──────────────────────────────────────────────────────────

describe("compareSemVer", () => {
  it("should return 0 for equal versions", () => {
    expect(compareSemVer("1.0.0", "1.0.0")).toBe(0);
  });

  it("should return 1 when a > b (major)", () => {
    expect(compareSemVer("2.0.0", "1.0.0")).toBe(1);
  });

  it("should return -1 when a < b (major)", () => {
    expect(compareSemVer("1.0.0", "2.0.0")).toBe(-1);
  });

  it("should compare minor versions", () => {
    expect(compareSemVer("1.2.0", "1.1.0")).toBe(1);
    expect(compareSemVer("1.1.0", "1.2.0")).toBe(-1);
  });

  it("should compare patch versions", () => {
    expect(compareSemVer("1.0.2", "1.0.1")).toBe(1);
    expect(compareSemVer("1.0.1", "1.0.2")).toBe(-1);
  });

  it("should rank release higher than prerelease", () => {
    // 1.0.0 > 1.0.0-alpha
    expect(compareSemVer("1.0.0", "1.0.0-alpha")).toBe(1);
    expect(compareSemVer("1.0.0-alpha", "1.0.0")).toBe(-1);
  });

  it("should compare prerelease identifiers lexicographically", () => {
    expect(compareSemVer("1.0.0-alpha", "1.0.0-beta")).toBe(-1);
    expect(compareSemVer("1.0.0-beta", "1.0.0-alpha")).toBe(1);
  });

  it("should compare numeric prerelease identifiers numerically", () => {
    expect(compareSemVer("1.0.0-beta.1", "1.0.0-beta.2")).toBe(-1);
    expect(compareSemVer("1.0.0-beta.10", "1.0.0-beta.2")).toBe(1);
  });

  it("should handle fewer prerelease identifiers as lower precedence", () => {
    // 1.0.0-alpha < 1.0.0-alpha.1
    expect(compareSemVer("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
  });

  it("should accept SemVer objects directly", () => {
    const a = { major: 2, minor: 0, patch: 0 };
    const b = { major: 1, minor: 5, patch: 0 };
    expect(compareSemVer(a, b)).toBe(1);
  });
});

// ─── satisfies ──────────────────────────────────────────────────────────────

describe("satisfies", () => {
  describe("caret ranges (^)", () => {
    it("should match same major, higher minor", () => {
      expect(satisfies("1.5.0", "^1.0.0")).toBe(true);
    });

    it("should match same major, higher patch", () => {
      expect(satisfies("1.0.5", "^1.0.0")).toBe(true);
    });

    it("should not match different major", () => {
      expect(satisfies("2.0.0", "^1.0.0")).toBe(false);
    });

    it("should not match lower version", () => {
      expect(satisfies("0.9.0", "^1.0.0")).toBe(false);
    });

    it("should handle ^0.x ranges (locks minor)", () => {
      expect(satisfies("0.2.5", "^0.2.0")).toBe(true);
      expect(satisfies("0.3.0", "^0.2.0")).toBe(false);
    });

    it("should handle ^0.0.x ranges (exact patch)", () => {
      expect(satisfies("0.0.3", "^0.0.3")).toBe(true);
      expect(satisfies("0.0.4", "^0.0.3")).toBe(false);
    });
  });

  describe("tilde ranges (~)", () => {
    it("should match same minor, higher patch", () => {
      expect(satisfies("1.2.5", "~1.2.3")).toBe(true);
    });

    it("should not match different minor", () => {
      expect(satisfies("1.3.0", "~1.2.3")).toBe(false);
    });

    it("should not match lower patch", () => {
      expect(satisfies("1.2.2", "~1.2.3")).toBe(false);
    });

    it("should match exact version", () => {
      expect(satisfies("1.2.3", "~1.2.3")).toBe(true);
    });
  });

  describe("comparison operators", () => {
    it("should handle >= operator", () => {
      expect(satisfies("2.0.0", ">=1.0.0")).toBe(true);
      expect(satisfies("1.0.0", ">=1.0.0")).toBe(true);
      expect(satisfies("0.9.0", ">=1.0.0")).toBe(false);
    });

    it("should handle <= operator", () => {
      expect(satisfies("1.0.0", "<=2.0.0")).toBe(true);
      expect(satisfies("2.0.0", "<=2.0.0")).toBe(true);
      expect(satisfies("3.0.0", "<=2.0.0")).toBe(false);
    });

    it("should handle > operator", () => {
      expect(satisfies("2.0.0", ">1.0.0")).toBe(true);
      expect(satisfies("1.0.0", ">1.0.0")).toBe(false);
    });

    it("should handle < operator", () => {
      expect(satisfies("0.9.0", "<1.0.0")).toBe(true);
      expect(satisfies("1.0.0", "<1.0.0")).toBe(false);
    });
  });

  describe("exact match", () => {
    it("should match exact version with = prefix", () => {
      expect(satisfies("1.2.3", "=1.2.3")).toBe(true);
      expect(satisfies("1.2.4", "=1.2.3")).toBe(false);
    });

    it("should match exact version without prefix", () => {
      expect(satisfies("1.2.3", "1.2.3")).toBe(true);
      expect(satisfies("1.2.4", "1.2.3")).toBe(false);
    });
  });

  describe("OR ranges (||)", () => {
    it("should match if any range matches", () => {
      expect(satisfies("1.5.0", "^1.0.0 || ^2.0.0")).toBe(true);
      expect(satisfies("2.5.0", "^1.0.0 || ^2.0.0")).toBe(true);
      expect(satisfies("3.0.0", "^1.0.0 || ^2.0.0")).toBe(false);
    });
  });

  describe("AND ranges (space-separated)", () => {
    it("should match if all ranges match", () => {
      expect(satisfies("1.5.0", ">=1.0.0 <2.0.0")).toBe(true);
      expect(satisfies("2.0.0", ">=1.0.0 <2.0.0")).toBe(false);
      expect(satisfies("0.9.0", ">=1.0.0 <2.0.0")).toBe(false);
    });
  });
});

// ─── createMigrationRunner ──────────────────────────────────────────────────

describe("createMigrationRunner", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("should run all pending migrations when none have been applied", async () => {
    const upCalls: string[] = [];

    const runner = createMigrationRunner({
      currentVersion: "1.2.0",
      migrations: [
        {
          version: "1.0.0",
          description: "Initial",
          up: () => {
            upCalls.push("1.0.0");
          },
        },
        {
          version: "1.1.0",
          description: "Add feature",
          up: () => {
            upCalls.push("1.1.0");
          },
        },
        {
          version: "1.2.0",
          description: "Another feature",
          up: () => {
            upCalls.push("1.2.0");
          },
        },
      ],
    });

    const result = await runner.migrate();

    expect(result.applied).toEqual(["1.0.0", "1.1.0", "1.2.0"]);
    expect(result.errors).toEqual([]);
    expect(upCalls).toEqual(["1.0.0", "1.1.0", "1.2.0"]);
  });

  it("should only run migrations after the applied version", async () => {
    localStorage.setItem("__sibu_migration_version__", "1.0.0");

    const upCalls: string[] = [];

    const runner = createMigrationRunner({
      currentVersion: "1.2.0",
      migrations: [
        {
          version: "1.0.0",
          description: "Initial",
          up: () => {
            upCalls.push("1.0.0");
          },
        },
        {
          version: "1.1.0",
          description: "Add feature",
          up: () => {
            upCalls.push("1.1.0");
          },
        },
        {
          version: "1.2.0",
          description: "Another feature",
          up: () => {
            upCalls.push("1.2.0");
          },
        },
      ],
    });

    const result = await runner.migrate();

    expect(result.applied).toEqual(["1.1.0", "1.2.0"]);
    expect(upCalls).toEqual(["1.1.0", "1.2.0"]);
  });

  it("should stop on first migration error", async () => {
    const upCalls: string[] = [];

    const runner = createMigrationRunner({
      currentVersion: "1.2.0",
      migrations: [
        {
          version: "1.0.0",
          description: "Initial",
          up: () => {
            upCalls.push("1.0.0");
          },
        },
        {
          version: "1.1.0",
          description: "Broken",
          up: () => {
            throw new Error("migration failed");
          },
        },
        {
          version: "1.2.0",
          description: "After broken",
          up: () => {
            upCalls.push("1.2.0");
          },
        },
      ],
    });

    const result = await runner.migrate();

    expect(result.applied).toEqual(["1.0.0"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].version).toBe("1.1.0");
    expect(result.errors[0].error.message).toBe("migration failed");
    // 1.2.0 should NOT have run
    expect(upCalls).toEqual(["1.0.0"]);
  });

  it("should return the applied version from storage", async () => {
    const runner = createMigrationRunner({
      currentVersion: "1.1.0",
      migrations: [
        {
          version: "1.0.0",
          description: "Initial",
          up: () => {},
        },
        {
          version: "1.1.0",
          description: "Update",
          up: () => {},
        },
      ],
    });

    expect(runner.getAppliedVersion()).toBeNull();

    await runner.migrate();

    expect(runner.getAppliedVersion()).toBe("1.1.0");
  });

  it("should use custom storageKey", async () => {
    const runner = createMigrationRunner({
      currentVersion: "1.0.0",
      storageKey: "__custom_key__",
      migrations: [{ version: "1.0.0", description: "Init", up: () => {} }],
    });

    await runner.migrate();

    expect(localStorage.getItem("__custom_key__")).toBe("1.0.0");
  });

  it("should not run migrations beyond currentVersion", async () => {
    const upCalls: string[] = [];

    const runner = createMigrationRunner({
      currentVersion: "1.1.0",
      migrations: [
        {
          version: "1.0.0",
          description: "Initial",
          up: () => {
            upCalls.push("1.0.0");
          },
        },
        {
          version: "1.1.0",
          description: "Feature",
          up: () => {
            upCalls.push("1.1.0");
          },
        },
        {
          version: "2.0.0",
          description: "Future",
          up: () => {
            upCalls.push("2.0.0");
          },
        },
      ],
    });

    const result = await runner.migrate();

    expect(result.applied).toEqual(["1.0.0", "1.1.0"]);
    expect(upCalls).not.toContain("2.0.0");
  });

  describe("rollback", () => {
    it("should rollback migrations in reverse order", async () => {
      const downCalls: string[] = [];

      const runner = createMigrationRunner({
        currentVersion: "1.2.0",
        migrations: [
          {
            version: "1.0.0",
            description: "Initial",
            up: () => {},
            down: () => {
              downCalls.push("1.0.0");
            },
          },
          {
            version: "1.1.0",
            description: "Feature A",
            up: () => {},
            down: () => {
              downCalls.push("1.1.0");
            },
          },
          {
            version: "1.2.0",
            description: "Feature B",
            up: () => {},
            down: () => {
              downCalls.push("1.2.0");
            },
          },
        ],
      });

      await runner.migrate();
      expect(runner.getAppliedVersion()).toBe("1.2.0");

      const result = await runner.rollback("1.0.0");

      expect(result.rolledBack).toEqual(["1.2.0", "1.1.0"]);
      expect(downCalls).toEqual(["1.2.0", "1.1.0"]);
      expect(runner.getAppliedVersion()).toBe("1.0.0");
    });

    it("should throw if a migration has no down function", async () => {
      const runner = createMigrationRunner({
        currentVersion: "1.1.0",
        migrations: [
          {
            version: "1.0.0",
            description: "Initial",
            up: () => {},
          },
          {
            version: "1.1.0",
            description: "No rollback",
            up: () => {},
          },
        ],
      });

      await runner.migrate();

      await expect(runner.rollback("1.0.0")).rejects.toThrow("does not have a down() function");
    });

    it("should remove storage key when rolling back to 0.0.0", async () => {
      const runner = createMigrationRunner({
        currentVersion: "1.0.0",
        migrations: [
          {
            version: "1.0.0",
            description: "Initial",
            up: () => {},
            down: () => {},
          },
        ],
      });

      await runner.migrate();
      expect(runner.getAppliedVersion()).toBe("1.0.0");

      await runner.rollback("0.0.0");
      expect(runner.getAppliedVersion()).toBeNull();
    });

    it("should return empty array if no migrations have been applied", async () => {
      const runner = createMigrationRunner({
        currentVersion: "1.0.0",
        migrations: [{ version: "1.0.0", description: "Init", up: () => {}, down: () => {} }],
      });

      const result = await runner.rollback("0.0.0");
      expect(result.rolledBack).toEqual([]);
    });
  });
});

// ─── checkCompatibility ─────────────────────────────────────────────────────

describe("checkCompatibility", () => {
  it("should return compatible when version satisfies range", () => {
    const result = checkCompatibility("1.5.0", "^1.0.0");
    expect(result.compatible).toBe(true);
    expect(result.message).toContain("is compatible");
  });

  it("should return incompatible when version does not satisfy range", () => {
    const result = checkCompatibility("2.0.0", "^1.0.0");
    expect(result.compatible).toBe(false);
    expect(result.message).toContain("NOT compatible");
  });

  it("should suggest major upgrade when framework is behind", () => {
    const result = checkCompatibility("1.0.0", "^2.0.0");
    expect(result.compatible).toBe(false);
    expect(result.message).toContain("major upgrade is required");
  });

  it("should suggest updating dependency when framework is ahead", () => {
    const result = checkCompatibility("3.0.0", "^2.0.0");
    expect(result.compatible).toBe(false);
    expect(result.message).toContain("Consider updating the dependency");
  });

  it("should work with exact version ranges", () => {
    expect(checkCompatibility("1.0.0", "1.0.0").compatible).toBe(true);
    expect(checkCompatibility("1.0.1", "1.0.0").compatible).toBe(false);
  });

  it("should work with >= ranges", () => {
    expect(checkCompatibility("2.0.0", ">=1.0.0").compatible).toBe(true);
    expect(checkCompatibility("0.9.0", ">=1.0.0").compatible).toBe(false);
  });
});
