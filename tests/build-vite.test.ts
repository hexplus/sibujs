import { describe, expect, it, vi } from "vitest";
import { createViteConfig, sibuVitePlugin } from "../src/build/vite";
import { runModule } from "./helpers/buildTransformHarness";

const TF = 'import { tagFactory } from "sibujs";\n';

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
      expect(config.optimizeDeps.include).toEqual(["sibujs"]);
      expect(config.ssr.noExternal).toEqual(["sibujs"]);
      expect(config.define.__SIBU_DEV__).toBe(JSON.stringify(true));
      expect(config.define.__SIBU_HMR__).toBe(JSON.stringify(true));
      expect(config.build.sourcemap).toBe(true);
    });

    it("derives dev mode from Vite's command/mode, not NODE_ENV", () => {
      const build = sibuVitePlugin().config?.({}, { command: "build", mode: "production" }) as Record<string, any>;
      expect(build.define.__SIBU_DEV__).toBe("false");
      const buildDev = sibuVitePlugin().config?.({}, { command: "build", mode: "development" }) as Record<string, any>;
      expect(buildDev.define.__SIBU_DEV__).toBe("true");
      const serve = sibuVitePlugin().config?.({}, { command: "serve", mode: "production" }) as Record<string, any>;
      expect(serve.define.__SIBU_DEV__).toBe("true");
      // An explicit option still wins.
      const forced = sibuVitePlugin({ devMode: true }).config?.({}, { command: "build", mode: "production" }) as Record<
        string,
        any
      >;
      expect(forced.define.__SIBU_DEV__).toBe("true");
    });

    it("configResolved switches the transform to production behavior for `vite build`", () => {
      const plugin = sibuVitePlugin({ pureAnnotations: false });
      plugin.configResolved?.({ command: "build", mode: "production" });
      const out = plugin.transform?.('import { html } from "sibujs";\nconst el = html`<p>x</p>`;', "src/a.ts");
      expect(out?.code).not.toContain("html`");
      plugin.configResolved?.({ command: "serve", mode: "development" });
      const dev = plugin.transform?.('import { html } from "sibujs";\nconst el = html`<p>x</p>`;', "src/a.ts");
      expect(dev?.code).toContain("html`<p>x</p>`");
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
      const result = plugin.transform?.(`${TF}const x = tagFactory('div')`, "src/foo.ts");
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
      const result = plugin.transform?.('import { div } from "sibujs";\nconst x = 1;', "src/foo.js");
      expect(result).not.toBeNull();
      expect(result?.code).toContain("__SIBU_DEV__ = true");
      expect(result?.code).toContain("SibuJS Dev Mode");
      // Plain JavaScript: the prologue must parse in a .js module.
      expect(() => new Function((result?.code as string).replace(/import[^;]*;/g, ""))).not.toThrow();
    });

    it("does not inject dev helpers when the file does not import sibu", () => {
      const plugin = sibuVitePlugin({
        devMode: true,
        pureAnnotations: false,
        staticOptimize: false,
        compileTemplates: false,
      });
      const result = plugin.transform?.("const x = 1;", "src/foo.ts");
      expect(result).toBeNull();
    });

    it("compiles html templates in production into a module that runs", () => {
      const plugin = sibuVitePlugin({ devMode: false, pureAnnotations: false, staticOptimize: false });
      const result = plugin.transform?.(
        'import { html } from "sibujs";\nexport default (t) => html`<div title=${t}>hi</div>`;',
        "src/foo.ts",
      );
      expect(result).not.toBeNull();
      expect(result?.code).not.toContain("html`");
      expect(result?.code).not.toMatch(/from "sibu"/);
      const el = runModule<(t: string) => Element>(result?.code as string)("x");
      expect(el.outerHTML).toBe('<div title="x">hi</div>');
    });

    it("compiles svg templates into SVG-namespace elements", () => {
      const plugin = sibuVitePlugin({ devMode: false, pureAnnotations: false, staticOptimize: false });
      const result = plugin.transform?.(
        'import { html } from "sibujs";\nexport default () => html`<svg><circle r="2" /></svg>`;',
        "src/foo.ts",
      );
      const el = runModule<() => Element>(result?.code as string)();
      expect(el.firstElementChild?.namespaceURI).toBe("http://www.w3.org/2000/svg");
    });

    it("does not compile templates in dev mode by default", () => {
      const plugin = sibuVitePlugin({ devMode: true, pureAnnotations: false, staticOptimize: false });
      const result = plugin.transform?.(
        'import { html } from "sibujs";\nconst el = html`<div>hi</div>`;',
        "src/foo.ts",
      );
      // Only the dev prologue is added; the template stays for the runtime.
      expect(result?.code).toContain("html`<div>hi</div>`");
    });

    it("can force compileTemplates on even in dev mode", () => {
      const plugin = sibuVitePlugin({
        devMode: true,
        pureAnnotations: false,
        staticOptimize: false,
        compileTemplates: true,
      });
      const result = plugin.transform?.(
        'import { html } from "sibujs";\nconst el = html`<div>hi</div>`;',
        "src/foo.ts",
      );
      expect(result).not.toBeNull();
      expect(result?.code).not.toContain("html`");
    });

    it("does not apply static optimization unless asked to", () => {
      const plugin = sibuVitePlugin({ devMode: false, pureAnnotations: false, compileTemplates: false });
      const code = 'import { div } from "sibujs";\nconst x = div({ class: "card", id: "main" });';
      expect(plugin.transform?.(code, "src/foo.ts")).toBeNull();
    });

    it("applies static optimization when enabled, importing staticTemplate from sibujs/performance", () => {
      const plugin = sibuVitePlugin({
        devMode: false,
        pureAnnotations: false,
        compileTemplates: false,
        staticOptimize: true,
      });
      const code = 'import { div } from "sibujs";\nconst x = div({ class: "card", id: "main" });';
      const result = plugin.transform?.(code, "src/foo.ts");
      expect(result?.code).toContain("__sibujs$static(");
      expect(result?.code).toContain('import { staticTemplate as __sibujs$staticTemplate } from "sibujs/performance";');
    });

    it("applies static optimization to multiple static patterns (reverse-ordered replacement)", () => {
      const plugin = sibuVitePlugin({
        devMode: false,
        pureAnnotations: false,
        compileTemplates: false,
        staticOptimize: true,
      });
      const code = 'import { div, span } from "sibujs";\nconst a = div({ class: "a" }); const b = span({ id: "b" });';
      const result = plugin.transform?.(code, "src/foo.ts");
      expect((result?.code.match(/__sibujs\$static\("/g) || []).length).toBe(2);
    });

    it("returns a result object with code and map fields", () => {
      const plugin = sibuVitePlugin({ devMode: false, staticOptimize: false, compileTemplates: false });
      const result = plugin.transform?.(`${TF}tagFactory('div')`, "src/foo.ts");
      expect(result).toHaveProperty("code");
      // A real map: returning none while changing the code made Rollup warn
      // that the source map was likely incorrect.
      expect(result?.map).toMatchObject({ version: 3, sources: ["src/foo.ts"], names: [] });
      expect(typeof result?.map.mappings).toBe("string");
    });

    it("handles windows-style backslash paths in include matching", () => {
      const plugin = sibuVitePlugin({ devMode: false, staticOptimize: false, compileTemplates: false });
      const result = plugin.transform?.(`${TF}tagFactory('div')`, "src\\foo.ts");
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
    expect(plugin.transform?.(`${TF}tagFactory('div')`, "src/foo.ts")).toBeNull();
    // .svelte matches
    expect(plugin.transform?.(`${TF}tagFactory('div')`, "src/foo.svelte")).not.toBeNull();
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
    expect(ssr.noExternal).toEqual(["sibujs"]);
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
