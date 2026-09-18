// @vitest-environment node
//
// The default plugin registry is shared across duplicate copies of the module,
// so a cancellation raised by one copy must be recognisable through another's
// exported error class. Same technique as duplicate-instance.test.ts: bundle the
// module once, evaluate it twice against one globalThis.

import { createRequire } from "node:module";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";

interface Copy {
  plugin: (p: { name: string; install: (ctx: unknown) => unknown }, options?: unknown) => void | Promise<void>;
  resetPlugins: () => void;
  PluginInstallCancelledError: new (name: string) => Error;
  isPluginInstallCancelledError: (value: unknown) => boolean;
}

let bundleCode = "";
const requireFn = createRequire(import.meta.url);

function loadCopy(): Copy {
  const module = { exports: {} as Record<string, unknown> };
  new Function("module", "exports", "require", bundleCode)(module, module.exports, requireFn);
  return module.exports as unknown as Copy;
}

beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `export {
        plugin,
        resetPlugins,
        PluginInstallCancelledError,
        isPluginInstallCancelledError,
      } from "./src/plugins/plugin";`,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    logLevel: "silent",
  });
  bundleCode = result.outputFiles[0].text;
});

describe("cancelled installs across duplicate copies", () => {
  it("both copies recognise a cancellation raised through either of them", async () => {
    const copyA = loadCopy();
    const copyB = loadCopy();
    expect(copyA.plugin).not.toBe(copyB.plugin);

    // Copy A creates (or has already created) the shared registry.
    copyA.plugin({ name: "seed", install: () => {} });

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const completion = copyB.plugin({ name: "async-dup", install: () => gate });
    copyB.resetPlugins();
    release();

    const error = await (completion as Promise<void>).catch((e: unknown) => e);
    expect((error as Error).name).toBe("PluginInstallCancelledError");
    expect(error).toBeInstanceOf(copyB.PluginInstallCancelledError);
    expect(error).toBeInstanceOf(copyA.PluginInstallCancelledError);
    expect(copyA.isPluginInstallCancelledError(error)).toBe(true);
    expect(copyB.isPluginInstallCancelledError(error)).toBe(true);
  });

  it("unrelated values are not mistaken for a cancellation", () => {
    const copy = loadCopy();
    for (const value of [null, undefined, new Error("other"), { name: "PluginInstallCancelledError" }, "text"]) {
      expect(copy.isPluginInstallCancelledError(value)).toBe(false);
      expect(value).not.toBeInstanceOf(copy.PluginInstallCancelledError);
    }
  });
});
