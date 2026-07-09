import { describe, expect, it, vi } from "vitest";
import { createViteConfig, sibuVitePlugin } from "../src/build/vite";

describe("sibuVitePlugin", () => {
  it("returns a plugin with the expected shape", () => {
    const plugin = sibuVitePlugin();
    expect(plugin.name).toBe("sibu-vite-plugin");
    expect(plugin.enforce).toBe("pre");
    expect(typeof plugin.config).toBe("function");
    expect(typeof plugin.transform).toBe("function");
    expect(typeof plugin.handleHotUpdate).toBe("function");
  });

  describe("config", () => {
    it("returns a config object with optimizeDeps, ssr, define, and build", () => {
      const config = sibuVitePlugin({ devMode: true, hmr: true }).config?.() as Record<string, any>;
      expect(config.optimizeDeps.include).toContain("sibujs");
      expect(config.ssr.noExternal).toContain("sibujs");
      expect(config.define.__SIBU_DEV__).toBe(JSON.stringify(true));
      expect(config.define.__SIBU_HMR__).toBe(JSON.stringify(true));
      expect(config.build.sourcemap).toBe(true);
    });

    it("reflects production dev flags", () => {
      const config = sibuVitePlugin({ devMode: false, hmr: false }).config?.() as Record<string, any>;
      expect(config.define.__SIBU_DEV__).toBe(JSON.stringify(false));
      expect(config.define.__SIBU_HMR__).toBe(JSON.stringify(false));
      expect(config.build.sourcemap).toBe(false);
    });
  });

  describe("transform", () => {
    it("returns null for files that do not match include patterns", () => {
      const plugin = sibuVitePlugin();
      expect(plugin.transform?.("const x = tagFactory('div')", "styles.css")).toBeNull();
    });

    it("returns null for excluded files", () => {
      const plugin = sibuVitePlugin();
      expect(plugin.transform?.("const x = tagFactory('div')", "src/foo.test.ts")).toBeNull();
    });

    it("returns null when nothing is modified", () => {
      const plugin = sibuVitePlugin({
        pureAnnotations: false,
        devMode: false,
        staticOptimize: false,
        compileTemplates: false,
      });
      expect(plugin.transform?.("const x = 1;", "src/foo.ts")).toBeNull();
    });

    it("injects pure annotations on factory calls", () => {
      const plugin = sibuVitePlugin({ devMode: false, staticOptimize: false, compileTemplates: false });
      const result = plugin.transform?.("const x = tagFactory('div')", "src/foo.ts");
      expect(result).not.toBeNull();
      expect(result?.code).toContain("/*#__PURE__*/ tagFactory(");
    });

    it("injects dev helpers in dev mode for files importing sibujs", () => {
      const plugin = sibuVitePlugin({
        devMode: true,
        pureAnnotations: false,
        staticOptimize: false,
        compileTemplates: false,
      });
      const result = plugin.transform?.('import { div } from "sibujs";\nconst x = 1;', "src/foo.ts");
      expect(result).not.toBeNull();
      expect(result?.code).toContain("__SIBU_DEV__ = true");
      expect(result?.code).toContain("SibuJS Dev Mode");
    });

    it("does not inject dev helpers when the file does not import sibujs", () => {
      const plugin = sibuVitePlugin({
        devMode: true,
        pureAnnotations: false,
        staticOptimize: false,
        compileTemplates: false,
      });
      const result = plugin.transform?.("const x = 1;", "src/foo.ts");
      expect(result).toBeNull();
    });

    it("compiles html templates in production and adds tag imports", () => {
      const plugin = sibuVitePlugin({ devMode: false, pureAnnotations: false, staticOptimize: false });
      const result = plugin.transform?.("const el = html`<div>hi</div>`;", "src/foo.ts");
      expect(result).not.toBeNull();
      expect(result?.code).not.toContain("html`");
      expect(result?.code).toContain("div(");
      expect(result?.code).toContain('import { div } from "sibujs";');
    });

    it("adds svg tagFactory imports when compiling svg templates", () => {
      const plugin = sibuVitePlugin({ devMode: false, pureAnnotations: false, staticOptimize: false });
      const result = plugin.transform?.('const el = html`<svg><circle r="2" /></svg>`;', "src/foo.ts");
      expect(result).not.toBeNull();
      expect(result?.code).toContain("__sbTagFactory");
      expect(result?.code).toContain("__sbSVG_NS");
    });

    it("does not compile templates in dev mode by default", () => {
      const plugin = sibuVitePlugin({ devMode: true, pureAnnotations: false, staticOptimize: false });
      const result = plugin.transform?.("const el = html`<div>hi</div>`;", "src/foo.ts");
      // No transformation paths fired -> null (html still present, not compiled)
      expect(result).toBeNull();
    });

    it("can force compileTemplates on even in dev mode", () => {
      const plugin = sibuVitePlugin({
        devMode: true,
        pureAnnotations: false,
        staticOptimize: false,
        compileTemplates: true,
      });
      const result = plugin.transform?.("const el = html`<div>hi</div>`;", "src/foo.ts");
      expect(result).not.toBeNull();
      expect(result?.code).not.toContain("html`");
    });

    it("applies static optimization in production, replacing static tag calls with staticTemplate", () => {
      const plugin = sibuVitePlugin({ devMode: false, pureAnnotations: false, compileTemplates: false });
      // analyzeStaticTemplates detects static tag calls like div({ class: "card" }).
      const code = 'const x = div({ class: "card", id: "main" });';
      const result = plugin.transform?.(code, "src/foo.ts");
      expect(result).not.toBeNull();
      expect(result?.code).toContain("staticTemplate(");
      expect(result?.code).toContain('import { staticTemplate } from "sibujs";');
    });

    it("applies static optimization to multiple static patterns (reverse-ordered replacement)", () => {
      const plugin = sibuVitePlugin({ devMode: false, pureAnnotations: false, compileTemplates: false });
      const code = 'const a = div({ class: "a" }); const b = span({ id: "b" });';
      const result = plugin.transform?.(code, "src/foo.ts");
      expect(result).not.toBeNull();
      expect((result?.code.match(/staticTemplate\(/g) || []).length).toBe(2);
    });

    it("returns a result object with code and map fields", () => {
      const plugin = sibuVitePlugin({ devMode: false, staticOptimize: false, compileTemplates: false });
      const result = plugin.transform?.("tagFactory('div')", "src/foo.ts");
      expect(result).toHaveProperty("code");
      expect(result).toHaveProperty("map");
      expect(result?.map).toBeUndefined();
    });

    it("handles windows-style backslash paths in include matching", () => {
      const plugin = sibuVitePlugin({ devMode: false, staticOptimize: false, compileTemplates: false });
      const result = plugin.transform?.("tagFactory('div')", "src\\foo.ts");
      expect(result).not.toBeNull();
    });
  });

  describe("handleHotUpdate", () => {
    it("logs an HMR update for matching component files in dev mode", () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const plugin = sibuVitePlugin({ hmr: true, devMode: true });
      plugin.handleHotUpdate?.({ file: "src/App.ts", modules: [] });
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("HMR update"));
      logSpy.mockRestore();
    });

    it("does nothing when hmr is disabled", () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const plugin = sibuVitePlugin({ hmr: false, devMode: true });
      plugin.handleHotUpdate?.({ file: "src/App.ts", modules: [] });
      expect(logSpy).not.toHaveBeenCalled();
      logSpy.mockRestore();
    });

    it("does not log for excluded files", () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const plugin = sibuVitePlugin({ hmr: true, devMode: true });
      plugin.handleHotUpdate?.({ file: "node_modules/sibu/index.ts", modules: [] });
      expect(logSpy).not.toHaveBeenCalled();
      logSpy.mockRestore();
    });

    it("does not log in production mode even for matching files", () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const plugin = sibuVitePlugin({ hmr: true, devMode: false });
      plugin.handleHotUpdate?.({ file: "src/App.ts", modules: [] });
      expect(logSpy).not.toHaveBeenCalled();
      logSpy.mockRestore();
    });
  });

  it("respects custom include/exclude patterns", () => {
    const plugin = sibuVitePlugin({
      include: ["**/*.svelte"],
      exclude: [],
      devMode: false,
      staticOptimize: false,
      compileTemplates: false,
    });
    // .ts no longer matches custom include
    expect(plugin.transform?.("tagFactory('div')", "src/foo.ts")).toBeNull();
    // .svelte matches
    expect(plugin.transform?.("tagFactory('div')", "src/foo.svelte")).not.toBeNull();
  });
});

describe("createViteConfig", () => {
  it("returns a default client config", () => {
    const config = createViteConfig();
    expect(Array.isArray(config.plugins)).toBe(true);
    const build = config.build as Record<string, any>;
    expect(build.outDir).toBe("dist");
    expect(build.lib.entry).toBe("src/main.ts");
    expect(build.lib.formats).toEqual(["es", "cjs"]);
    const resolve = config.resolve as Record<string, any>;
    expect(resolve.extensions).toContain(".ts");
    expect((config.define as Record<string, any>).__SIBU_SSR__).toBe(JSON.stringify(false));
  });

  it("honors custom entry and outDir", () => {
    const config = createViteConfig({ entry: "app.ts", outDir: "out" });
    const build = config.build as Record<string, any>;
    expect(build.outDir).toBe("out");
    expect(build.lib.entry).toBe("app.ts");
  });

  it("produces an SSR config when ssr is true", () => {
    const config = createViteConfig({ ssr: true, entry: "server.ts" });
    const ssr = config.ssr as Record<string, any>;
    expect(ssr.noExternal).toContain("sibujs");
    expect(ssr.target).toBe("node");
    const build = config.build as Record<string, any>;
    expect(build.ssr).toBe(true);
    expect(build.target).toBe("node18");
    // lib mode is not used for SSR
    expect(build.lib).toBeUndefined();
    expect((config.define as Record<string, any>).__SIBU_SSR__).toBe(JSON.stringify(true));
  });

  it("deep-merges overrides into the base config", () => {
    const config = createViteConfig({
      overrides: {
        build: { minify: false },
        server: { port: 4000 },
      },
    });
    const build = config.build as Record<string, any>;
    // overridden value
    expect(build.minify).toBe(false);
    // preserved base value
    expect(build.outDir).toBe("dist");
    // brand-new key from overrides
    expect((config.server as Record<string, any>).port).toBe(4000);
  });

  it("override arrays replace base arrays rather than merging", () => {
    const config = createViteConfig({
      overrides: { resolve: { extensions: [".ts"] } },
    });
    expect((config.resolve as Record<string, any>).extensions).toEqual([".ts"]);
  });
});
