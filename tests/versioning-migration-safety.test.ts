import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMigrationRunner, type Migration, MigrationStorageError, parseSemVer } from "../src/plugins/versioning";

// ---------------------------------------------------------------------------
// Migration runner concurrency and rollback checkpoints, and strict SemVer
// parsing.
//
// THE DEFECTS:
// 1. migrate() computed its pending list before awaiting any migration, so two
//    concurrent calls both ran every pending up().
// 2. rollback() recorded the new version only after every down() succeeded, so a
//    failure part-way left storage claiming the rolled-back migrations were still
//    applied and a retry ran their down() again.
// 3. parseSemVer() used parseInt(), accepting "1.2.3garbage", "1.2.3.4" and an
//    empty prerelease.
// ---------------------------------------------------------------------------

const KEY = "__test_migrations__";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}

describe("migrate() and rollback() are serialized", () => {
  it("concurrent migrate() calls execute each up() once", async () => {
    const g = gate();
    let calls = 0;
    const runner = createMigrationRunner({
      currentVersion: "1.0.0",
      storageKey: KEY,
      migrations: [
        {
          version: "1.0.0",
          description: "create records",
          up: async () => {
            calls++;
            await g.promise;
          },
        },
      ],
    });

    const first = runner.migrate();
    const second = runner.migrate();
    await Promise.resolve();
    g.release();
    const [a, b] = await Promise.all([first, second]);

    expect(calls).toBe(1);
    expect(a.applied).toEqual(["1.0.0"]);
    expect(b.applied).toEqual([]);
    expect(runner.getAppliedVersion()).toBe("1.0.0");
  });

  it("migrate() racing rollback() runs one after the other", async () => {
    const log: string[] = [];
    const g = gate();
    const runner = createMigrationRunner({
      currentVersion: "2.0.0",
      storageKey: KEY,
      migrations: [
        { version: "1.0.0", description: "one", up: () => void log.push("up 1"), down: () => void log.push("down 1") },
        {
          version: "2.0.0",
          description: "two",
          up: async () => {
            log.push("up 2 start");
            await g.promise;
            log.push("up 2 end");
          },
          down: () => void log.push("down 2"),
        },
      ],
    });

    const migrating = runner.migrate();
    const rollingBack = runner.rollback("0.0.0");
    await Promise.resolve();
    g.release();
    await Promise.all([migrating, rollingBack]);

    expect(log).toEqual(["up 1", "up 2 start", "up 2 end", "down 2", "down 1"]);
    expect(runner.getAppliedVersion()).toBeNull();
  });

  it("a failed operation releases the lock and the next call recomputes from storage", async () => {
    let failOnce = true;
    const up = vi.fn(async () => {
      if (failOnce) {
        failOnce = false;
        throw new Error("transient");
      }
    });
    const runner = createMigrationRunner({
      currentVersion: "1.0.0",
      storageKey: KEY,
      migrations: [{ version: "1.0.0", description: "flaky", up }],
    });

    const failed = await runner.migrate();
    expect(failed.errors).toHaveLength(1);

    const retried = await runner.migrate();
    expect(retried.applied).toEqual(["1.0.0"]);
    expect(up).toHaveBeenCalledTimes(2);

    // Storage changed out-of-band: the next call sees it.
    localStorage.removeItem(KEY);
    const again = await runner.migrate();
    expect(again.applied).toEqual(["1.0.0"]);
  });

  it("a rollback that throws releases the lock", async () => {
    const runner = createMigrationRunner({
      currentVersion: "1.0.0",
      storageKey: KEY,
      migrations: [{ version: "1.0.0", description: "no down", up: () => {} }],
    });
    await runner.migrate();

    await expect(runner.rollback("0.0.0")).rejects.toThrow("does not have a down()");
    const result = await runner.migrate();
    expect(result.applied).toEqual([]);
  });
});

describe("rollback() checkpoints after every down()", () => {
  function runnerWith(migrations: Migration[]) {
    return createMigrationRunner({ currentVersion: "3.0.0", storageKey: KEY, migrations });
  }

  it("a failure after one successful down() stores the intermediate version", async () => {
    const down3 = vi.fn();
    const runner = runnerWith([
      { version: "1.0.0", description: "one", up: () => {}, down: () => {} },
      {
        version: "2.0.0",
        description: "two",
        up: () => {},
        down: () => {
          throw new Error("down 2 failed");
        },
      },
      { version: "3.0.0", description: "three", up: () => {}, down: down3 },
    ]);
    localStorage.setItem(KEY, "3.0.0");

    await expect(runner.rollback("0.0.0")).rejects.toThrow("down 2 failed");

    expect(down3).toHaveBeenCalledTimes(1);
    expect(runner.getAppliedVersion()).toBe("2.0.0");
  });

  it("retrying does not rerun a completed down()", async () => {
    let fail = true;
    const down3 = vi.fn();
    const down2 = vi.fn(() => {
      if (fail) throw new Error("down 2 failed");
    });
    const runner = runnerWith([
      { version: "1.0.0", description: "one", up: () => {}, down: () => {} },
      { version: "2.0.0", description: "two", up: () => {}, down: down2 },
      { version: "3.0.0", description: "three", up: () => {}, down: down3 },
    ]);
    localStorage.setItem(KEY, "3.0.0");

    await expect(runner.rollback("1.0.0")).rejects.toThrow();
    fail = false;
    const result = await runner.rollback("1.0.0");

    expect(down3).toHaveBeenCalledTimes(1);
    expect(down2).toHaveBeenCalledTimes(2);
    expect(result.rolledBack).toEqual(["2.0.0"]);
    expect(runner.getAppliedVersion()).toBe("1.0.0");
  });

  it("a missing down() stops with the checkpoint of the last completed rollback", async () => {
    const runner = runnerWith([
      { version: "1.0.0", description: "one", up: () => {}, down: () => {} },
      { version: "2.0.0", description: "irreversible", up: () => {} },
      { version: "3.0.0", description: "three", up: () => {}, down: () => {} },
    ]);
    localStorage.setItem(KEY, "3.0.0");

    await expect(runner.rollback("0.0.0")).rejects.toThrow("does not have a down()");
    expect(runner.getAppliedVersion()).toBe("2.0.0");
  });

  it("rolling back the only applied migration removes the key", async () => {
    const runner = runnerWith([
      { version: "1.0.0", description: "one", up: () => {}, down: () => {} },
      {
        version: "2.0.0",
        description: "two",
        up: () => {},
        down: () => {
          throw new Error("never reached");
        },
      },
    ]);
    localStorage.setItem(KEY, "1.0.0");

    await runner.rollback("0.0.0");
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("a storage write failure is reported separately from migration failures", async () => {
    const down = vi.fn();
    const runner = runnerWith([
      { version: "1.0.0", description: "one", up: () => {}, down: () => {} },
      { version: "2.0.0", description: "two", up: () => {}, down },
    ]);
    localStorage.setItem(KEY, "2.0.0");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });

    const error = await runner.rollback("0.0.0").catch((e: unknown) => e);

    expect(down).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(MigrationStorageError);
    expect((error as MigrationStorageError).version).toBe("2.0.0");
    expect((error as Error).message).toContain("quota exceeded");
  });

  it("migrate() reports a storage write failure as a storage error, not a failed up()", async () => {
    const up = vi.fn();
    const runner = createMigrationRunner({
      currentVersion: "1.0.0",
      storageKey: KEY,
      migrations: [{ version: "1.0.0", description: "one", up }],
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });

    const result = await runner.migrate();

    expect(up).toHaveBeenCalledTimes(1);
    expect(result.applied).toEqual(["1.0.0"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toBeInstanceOf(MigrationStorageError);
  });
});

describe("parseSemVer is strict", () => {
  for (const bad of [
    "1.2.3garbage",
    "1.2.3.4",
    "1.2.3-",
    "1.2.3-alpha..1",
    "1.2.3-al$pha",
    "1.2.3-01",
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "1.2.3+",
    "1.2.3+build..1",
    "",
    "v",
    "1.",
    "1..2",
  ]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      expect(() => parseSemVer(bad)).toThrow("[Versioning] Invalid semver string");
    });
  }

  it("parses build metadata and prerelease together", () => {
    expect(parseSemVer("1.2.3-beta.2+exp.sha.5114f85")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: "beta.2",
      build: "exp.sha.5114f85",
    });
    expect(parseSemVer("1.0.0+20130313144700")).toEqual({ major: 1, minor: 0, patch: 0, build: "20130313144700" });
  });

  it("accepts valid prerelease identifiers including hyphens and zero", () => {
    expect(parseSemVer("1.0.0-0").prerelease).toBe("0");
    expect(parseSemVer("1.0.0-x-y.7z.92").prerelease).toBe("x-y.7z.92");
  });

  it("retains the abbreviated and prefixed forms", () => {
    expect(parseSemVer("3")).toEqual({ major: 3, minor: 0, patch: 0 });
    expect(parseSemVer("2.5")).toEqual({ major: 2, minor: 5, patch: 0 });
    expect(parseSemVer("v2.1.0")).toEqual({ major: 2, minor: 1, patch: 0 });
    expect(parseSemVer("  1.0.0  ")).toEqual({ major: 1, minor: 0, patch: 0 });
    expect(parseSemVer("0.0.0")).toEqual({ major: 0, minor: 0, patch: 0 });
  });
});
