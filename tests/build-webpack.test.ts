import { describe, expect, it, vi } from "vitest";
import { createPureAnnotationsLoader, createWebpackConfig, sibuWebpackPlugin } from "../src/build/webpack";

/**
 * A hand-rolled fake webpack compiler. Each hook records its tapped callbacks
 * so tests can invoke them manually without depending on webpack itself.
 */
function makeFakeCompiler() {
  const taps: Record<string, Array<(...args: unknown[]) => void>> = {};
  function hook() {
    return {
      tap: (_name: string, cb: (...args: unknown[]) => void) => {
        return cb;
      },
    };
  }
  // We need to capture callbacks; build hooks that store them.
  function capturingHook(key: string) {
    taps[key] = taps[key] || [];
    return {
      tap: (_name: string, cb: (...args: unknown[]) => void) => {
        taps[key].push(cb);
      },
    };
  }
  const compiler: any = {
    hooks: {
      compilation: capturingHook("compilation"),
      afterEnvironment: capturingHook("afterEnvironment"),
      afterResolvers: capturingHook("afterResolvers"),
      done: capturingHook("done"),
      environment: capturingHook("environment"),
    },
    options: {},
  };
  return { compiler, taps, hook };
}

describe("sibuWebpackPlugin", () => {
  it("returns a plugin with a name and apply function", () => {
    const plugin = sibuWebpackPlugin();
    expect(plugin.name).toBe("SibuWebpackPlugin");
    expect(typeof plugin.apply).toBe("function");
  });

  it("apply runs without throwing on a fake compiler", () => {
    const { compiler } = makeFakeCompiler();
    expect(() => sibuWebpackPlugin().apply(compiler)).not.toThrow();
  });

  it("afterEnvironment tap pushes a pure-annotations loader rule", () => {
    const { compiler, taps } = makeFakeCompiler();
    sibuWebpackPlugin({ pureAnnotations: true }).apply(compiler);
    // Invoke the afterEnvironment callback
    taps.afterEnvironment.forEach((cb) => {
      cb();
    });
    const rules = compiler.options.module.rules as any[];
    expect(rules.length).toBe(1);
    expect(rules[0].enforce).toBe("pre");
    expect(rules[0].test.toString()).toContain("jt");
  });

  it("afterEnvironment preserves existing module rules", () => {
    const { compiler, taps } = makeFakeCompiler();
    const existing = { test: /\.css$/ };
    compiler.options.module = { rules: [existing] };
    sibuWebpackPlugin().apply(compiler);
    taps.afterEnvironment.forEach((cb) => {
      cb();
    });
    expect(compiler.options.module.rules).toContain(existing);
    expect(compiler.options.module.rules.length).toBe(2);
  });

  it("creates a rules array when module exists without rules", () => {
    const { compiler, taps } = makeFakeCompiler();
    compiler.options.module = {};
    sibuWebpackPlugin().apply(compiler);
    taps.afterEnvironment.forEach((cb) => {
      cb();
    });
    expect(Array.isArray(compiler.options.module.rules)).toBe(true);
    expect(compiler.options.module.rules.length).toBe(1);
  });

  it("does not register an afterEnvironment loader rule when pureAnnotations is false", () => {
    const { compiler, taps } = makeFakeCompiler();
    sibuWebpackPlugin({ pureAnnotations: false }).apply(compiler);
    expect(taps.afterEnvironment).toEqual([]);
  });

  it("afterResolvers sets mainFields with module first", () => {
    const { compiler, taps } = makeFakeCompiler();
    sibuWebpackPlugin().apply(compiler);
    taps.afterResolvers.forEach((cb) => {
      cb();
    });
    expect(compiler.options.resolve.mainFields).toEqual(["module", "main"]);
  });

  it("afterResolvers unshifts module when missing from existing mainFields", () => {
    const { compiler, taps } = makeFakeCompiler();
    compiler.options.resolve = { mainFields: ["main", "browser"] };
    sibuWebpackPlugin().apply(compiler);
    taps.afterResolvers.forEach((cb) => {
      cb();
    });
    expect(compiler.options.resolve.mainFields[0]).toBe("module");
    expect(compiler.options.resolve.mainFields).toContain("browser");
  });

  it("afterResolvers leaves mainFields untouched when module already present", () => {
    const { compiler, taps } = makeFakeCompiler();
    compiler.options.resolve = { mainFields: ["module", "main"] };
    sibuWebpackPlugin().apply(compiler);
    taps.afterResolvers.forEach((cb) => {
      cb();
    });
    expect(compiler.options.resolve.mainFields).toEqual(["module", "main"]);
  });

  it("environment tap stores sibu defines on the compiler", () => {
    const { compiler, taps } = makeFakeCompiler();
    sibuWebpackPlugin({ devMode: true }).apply(compiler);
    taps.environment.forEach((cb) => {
      cb();
    });
    expect(compiler.__sibuDefines).toBeDefined();
    expect(compiler.__sibuDefines.__SIBU_DEV__).toBe(JSON.stringify(true));
    expect(Array.isArray(compiler.options.plugins)).toBe(true);
  });

  it("environment tap preserves existing plugins array", () => {
    const { compiler, taps } = makeFakeCompiler();
    const existing = {};
    compiler.options.plugins = [existing];
    sibuWebpackPlugin().apply(compiler);
    taps.environment.forEach((cb) => {
      cb();
    });
    expect(compiler.options.plugins).toContain(existing);
  });

  it("compilation tap taps optimizeModules when present", () => {
    const { compiler, taps } = makeFakeCompiler();
    const optimizeTap = vi.fn();
    sibuWebpackPlugin().apply(compiler);
    const fakeCompilation = { hooks: { optimizeModules: { tap: optimizeTap } } };
    taps.compilation.forEach((cb) => {
      cb(fakeCompilation);
    });
    expect(optimizeTap).toHaveBeenCalledWith("SibuWebpackPlugin", expect.any(Function));
    // Also exercise the callback body for coverage
    const cb = optimizeTap.mock.calls[0][1];
    expect(() => cb()).not.toThrow();
  });

  it("compilation tap tolerates a compilation without optimizeModules", () => {
    const { compiler, taps } = makeFakeCompiler();
    sibuWebpackPlugin().apply(compiler);
    expect(() =>
      taps.compilation.forEach((cb) => {
        cb({ hooks: {} });
      }),
    ).not.toThrow();
  });

  it("done tap logs build info in dev mode", () => {
    const { compiler, taps } = makeFakeCompiler();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    sibuWebpackPlugin({ devMode: true }).apply(compiler);
    expect(taps.done.length).toBe(1);
    const stats = { toJson: () => ({ time: 123, warnings: ["w1"] }) };
    taps.done.forEach((cb) => {
      cb(stats);
    });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("123ms"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("1 warning"));
    logSpy.mockRestore();
  });

  it("done tap handles stats without toJson gracefully", () => {
    const { compiler, taps } = makeFakeCompiler();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    sibuWebpackPlugin({ devMode: true }).apply(compiler);
    expect(() =>
      taps.done.forEach((cb) => {
        cb(undefined);
      }),
    ).not.toThrow();
    logSpy.mockRestore();
  });

  it("does not register a done tap in production mode", () => {
    const { compiler, taps } = makeFakeCompiler();
    sibuWebpackPlugin({ devMode: false }).apply(compiler);
    expect(taps.done).toEqual([]);
  });

  it("tolerates a compiler with no hooks at all", () => {
    const compiler: any = { options: {} };
    expect(() => sibuWebpackPlugin().apply(compiler)).not.toThrow();
  });
});

describe("createPureAnnotationsLoader", () => {
  it("adds pure annotations to factory calls", () => {
    const loader = createPureAnnotationsLoader();
    const out = loader("const a = tagFactory('div'); const b = defineComponent(x);");
    expect(out).toContain("/*#__PURE__*/ tagFactory(");
    expect(out).toContain("/*#__PURE__*/ defineComponent(");
  });

  it("does not double-annotate already annotated calls", () => {
    const loader = createPureAnnotationsLoader();
    const input = "/*#__PURE__*/ tagFactory('div')";
    const out = loader(input);
    expect(out.match(/__PURE__/g)?.length).toBe(1);
  });

  it("leaves unrelated code unchanged", () => {
    const loader = createPureAnnotationsLoader();
    const input = "const x = someOther('div');";
    expect(loader(input)).toBe(input);
  });

  it("annotates every known factory", () => {
    const loader = createPureAnnotationsLoader();
    const src = "context(); withProps(); withDefaults(); pure(); noSideEffect();";
    const out = loader(src);
    expect(out.match(/__PURE__/g)?.length).toBe(5);
  });
});

describe("createWebpackConfig", () => {
  it("returns a production config by default", () => {
    const config = createWebpackConfig();
    expect(config.mode).toBe("production");
    expect(config.entry).toBe("./src/index.ts");
    const output = config.output as Record<string, unknown>;
    expect(output.path).toBe("dist");
    expect(output.filename).toContain("contenthash");
    const opt = config.optimization as Record<string, unknown>;
    expect(opt.minimize).toBe(true);
    expect(opt.splitChunks).not.toBe(false);
  });

  it("honors custom entry and outputPath", () => {
    const config = createWebpackConfig({ entry: "./app.ts", outputPath: "build" });
    expect(config.entry).toBe("./app.ts");
    expect((config.output as Record<string, unknown>).path).toBe("build");
  });

  it("produces a development config with dev-friendly settings", () => {
    const config = createWebpackConfig({ mode: "development" });
    expect(config.mode).toBe("development");
    const output = config.output as Record<string, unknown>;
    expect(output.filename).toBe("[name].js");
    const opt = config.optimization as Record<string, unknown>;
    expect(opt.minimize).toBe(false);
    expect(opt.splitChunks).toBe(false);
    expect(config.devServer).toBeDefined();
    expect(config.devtool).toBe("eval-cheap-module-source-map");
    const perf = config.performance as Record<string, unknown>;
    expect(perf.hints).toBe(false);
  });

  it("includes the sibu webpack plugin in the plugins array", () => {
    const config = createWebpackConfig();
    const plugins = config.plugins as Array<{ name?: string }>;
    expect(plugins.some((p) => p.name === "SibuWebpackPlugin")).toBe(true);
  });

  it("enables ESM output experiments", () => {
    const config = createWebpackConfig();
    expect((config.experiments as Record<string, unknown>).outputModule).toBe(true);
  });
});
