/**
 * Regression tests for the build transforms (Vite/webpack plugins, the `html`
 * template compiler, static optimization, route splitting).
 *
 * Symptom that prompted them: the production build optimizations produced a
 * broken bundle, so users had to switch them off. Each test is named after
 * the observable symptom and fails on the pre-fix transforms.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compileHtmlTemplates } from "../../src/build/compileTemplates";
import { sibuRouteSplitting } from "../../src/build/routeSplitting";
import { cookEscapes, injectPureAnnotations, scanStats } from "../../src/build/sourceScan";
import { analyzeStaticTemplates } from "../../src/build/staticAnalysis";
import { sibuVitePlugin } from "../../src/build/vite";
import { createPureAnnotationsLoader, createWebpackConfig, sibuWebpackPlugin } from "../../src/build/webpack";
import { signal } from "../../src/core/signals/signal";
import {
  decodeMappings,
  describeRoot,
  originalPositionFor,
  positionOf,
  runModule,
} from "../helpers/buildTransformHarness";

type Scope = Record<string, any>;
type Render = (s: Scope) => Element;

/** Transform `src` with the Vite plugin in production mode. */
function viteProd(src: string, options: Parameters<typeof sibuVitePlugin>[0] = {}): string {
  const plugin = sibuVitePlugin({ devMode: false, ...options });
  return plugin.transform?.(src, "src/app.js")?.code ?? src;
}

/** Assert the compiled module renders exactly what the untouched module renders. */
function expectParity(src: string, scope: () => Scope = () => ({})): void {
  const compiled = compileHtmlTemplates(src);
  expect(compiled.compiledCount, "template should compile").toBeGreaterThan(0);
  const runtime = runModule<Render>(src)(scope());
  const built = runModule<Render>(compiled.code as string)(scope());
  expect(describeRoot(built)).toBe(describeRoot(runtime));
}

const tpl = (body: string, prelude = "") =>
  `import { html } from "sibujs";\n${prelude}\nexport default (s) => html\`${body}\`;\n`;

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

// ── Bug 1: wrong package name ───────────────────────────────────────────────

describe("package specifier", () => {
  it("regression: injected imports target 'sibujs', not 'sibu'", () => {
    const out = viteProd(tpl("<p title=${s.t}>${s.c}</p>"));
    expect(out).not.toMatch(/from\s+["']sibu["'/]/);
    // The harness only knows real sibujs entries, so a bad specifier throws.
    expect(runModule<Render>(out)({ t: "x", c: "y" }).outerHTML).toBe('<p title="x">y</p>');
  });

  it("regression: vite config pre-bundles and SSR-inlines 'sibujs', not 'sibu'", () => {
    const config = sibuVitePlugin({ devMode: false }).config?.() as Record<string, any>;
    expect(config.optimizeDeps.include).toEqual(["sibujs"]);
    expect(config.ssr.noExternal).toEqual(["sibujs"]);
  });

  it("regression: route-splitting virtual module imports lazy from 'sibujs'", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "sibu-routes-reg-"));
    mkdirSync(join(root, "routes"));
    writeFileSync(join(root, "routes", "index.ts"), "export default {}");
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(root);
    try {
      const result = (await sibuRouteSplitting({ routesDir: "routes" }).load("\0virtual:sibu-routes")) as string;
      expect(result).toContain('import { lazy } from "sibujs";');
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it("regression: dev helpers are injected for files importing 'sibujs'", () => {
    const plugin = sibuVitePlugin({ devMode: true, pureAnnotations: false });
    const out = plugin.transform?.('import { div } from "sibujs";\nconst x = 1;', "src/a.js");
    expect(out?.code).toContain("__SIBU_DEV__ = true");
  });

  it("regression: webpack splitChunks selects node_modules/sibujs", () => {
    const groups = (createWebpackConfig().optimization as any).splitChunks.cacheGroups;
    expect(groups.sibu.test.test("/app/node_modules/sibujs/dist/index.js")).toBe(true);
  });
});

// ── Bug 2: staticTemplate import never injected / wrong entry ────────────────

describe("staticTemplate import", () => {
  it("regression: staticTemplate import is injected into files that already have imports", () => {
    const src = 'import { div } from "sibujs";\nexport default () => div({ class: "a" }, "b");\n';
    const out = viteProd(src, { staticOptimize: true, compileTemplates: false, pureAnnotations: false });
    expect(out).toMatch(/import \{ staticTemplate as [\w$]+ \} from "sibujs\/performance";/);
    expect(runModule<() => Element>(out)().outerHTML).toBe('<div class="a">b</div>');
  });

  it("regression: staticTemplate is imported from sibujs/performance, the entry that exports it", () => {
    const out = viteProd('import { span } from "sibujs";\nexport default () => span("x");\n', {
      staticOptimize: true,
    });
    expect(out).toContain('from "sibujs/performance"');
    expect(out).not.toMatch(/import \{[^}]*staticTemplate[^}]*\} from "sibujs";/);
  });
});

// ── Bug 3: duplicate / colliding imports ─────────────────────────────────────

describe("import collisions", () => {
  it("regression: file already importing div from sibujs does not get a duplicate import", () => {
    const src =
      'import { html, div } from "sibujs";\n' +
      'export default () => div({ class: "outer" }, [html`<div class="inner">x</div>`]);\n';
    const out = viteProd(src);
    // Two bindings named `div` would be a SyntaxError in a real module; the
    // harness turns imports into consts, so it fails the same way.
    const el = runModule<() => Element>(out)();
    expect(el.outerHTML).toBe('<div class="outer"><div class="inner">x</div></div>');
  });

  it("regression: a local variable named like a tag does not replace the element factory", () => {
    const src = tpl("<label>${label}</label>", 'const label = "Name";');
    const el = runModule<Render>(viteProd(src))({});
    expect(el.outerHTML).toBe("<label>Name</label>");
  });
});

// ── Bug 4: staticOptimize mangling ───────────────────────────────────────────

describe("static optimization", () => {
  const IMPORT = 'import { div, span, button, select, form, input } from "sibujs";\n';

  it("regression: staticOptimize is off by default in production", () => {
    const src = `${IMPORT}const a = div({ class: "x" });`;
    expect(viteProd(src, { pureAnnotations: false })).toBe(src);
  });

  it("regression: staticOptimize does not rewrite db.select({...}) method calls", () => {
    const src = `${IMPORT}const rows = db.select({ where: "x" }); const f = x.form({ id: "f" });`;
    const out = viteProd(src, { staticOptimize: true });
    expect(out).toContain('db.select({ where: "x" })');
    expect(out).toContain('x.form({ id: "f" })');
    expect(analyzeStaticTemplates(src).hasStaticPatterns).toBe(false);
  });

  it("regression: staticOptimize leaves compileTemplates output intact", () => {
    const src = tpl('<section><span class="x">${s.t}</span><b class="y">z</b></section>');
    const out = viteProd(src, { staticOptimize: true });
    expect(out).not.toMatch(/<\w+ "class"=/);
    const scope = () => ({ t: "T" });
    expect(describeRoot(runModule<Render>(out)(scope()))).toBe(describeRoot(runModule<Render>(src)(scope())));
  });

  it("regression: staticOptimize ignores tag calls inside strings, comments and templates", () => {
    const src = `${IMPORT}const s = 'div({ class: "a" })';\n// span({ id: "b" })\nconst t = \`div({ class: "c" })\`;`;
    expect(analyzeStaticTemplates(src).hasStaticPatterns).toBe(false);
  });

  it("regression: shorthand and spread props are not dropped by staticOptimize", () => {
    expect(analyzeStaticTemplates(`${IMPORT}div({ value })`).hasStaticPatterns).toBe(false);
    expect(analyzeStaticTemplates(`${IMPORT}div({ ...props })`).hasStaticPatterns).toBe(false);
  });

  it("regression: string concatenation is not treated as a static literal", () => {
    expect(analyzeStaticTemplates(`${IMPORT}div({ title: "a" + x + "b" })`).hasStaticPatterns).toBe(false);
  });

  it('regression: disabled:false is omitted, not rendered as disabled="false"', () => {
    const [pattern] = analyzeStaticTemplates(`${IMPORT}button({ disabled: false }, "b")`).patterns;
    expect(pattern.templateHtml).toBe("<button>b</button>");
  });

  it('regression: null props are omitted, not rendered as "null"', () => {
    const [pattern] = analyzeStaticTemplates(`${IMPORT}span({ title: null, lang: undefined }, "s")`).patterns;
    expect(pattern.templateHtml).toBe("<span>s</span>");
  });

  it("regression: a static style prop is not silently dropped", () => {
    expect(analyzeStaticTemplates(`${IMPORT}div({ style: "color: red", nodes: "x" })`).hasStaticPatterns).toBe(false);
  });

  it("regression: quoted keys produce valid attribute names", () => {
    const [pattern] = analyzeStaticTemplates(`${IMPORT}div({ "data-id": "7" })`).patterns;
    expect(pattern.templateHtml).toBe('<div data-id="7"></div>');
  });

  it("regression: an optimized element is identical to the tag factory's", () => {
    const src = `${IMPORT}export default () => div({ class: "c", title: "t & u", hidden: false, nodes: "Hi <there>" });\n`;
    const out = viteProd(src, { staticOptimize: true, pureAnnotations: false });
    expect(out).toContain("staticTemplate");
    expect(describeRoot(runModule<() => Element>(out)())).toBe(describeRoot(runModule<() => Element>(src)()));
  });
});

// ── Bug 5: compiled templates diverging from the runtime parser ─────────────

describe("template compiler parity", () => {
  it("regression: compiled <my-widget> custom element matches the runtime parser", () => {
    expectParity(tpl('<my-widget data-x="1">w</my-widget>'));
  });

  it("regression: compiled <var> matches the runtime parser", () => {
    expectParity(tpl("<p><var>x</var></p>"));
  });

  it("regression: compiled uppercase and non-listed SVG tags (foreignObject) match the runtime parser", () => {
    expectParity(tpl("<svg><foreignObject><DIV>x</DIV></foreignObject></svg>"));
  });

  it("regression: tags the tag factories block (iframe/object/embed) render like the runtime", () => {
    expectParity(tpl('<div><iframe title="t"></iframe><object></object><embed></div>'));
  });

  it("regression: compiled HTML comments are skipped like the runtime parser", () => {
    expectParity(tpl("<div><!-- note --><b>x</b></div>"));
  });

  it("regression: a bare < in text stays literal", () => {
    expectParity(tpl("<p>a < b</p>"));
  });

  it("regression: unquoted href=/about keeps its slash", () => {
    expectParity(tpl("<a href=/about/team>About</a>"));
  });

  it("regression: an unquoted attribute value may embed ${}", () => {
    expectParity(tpl("<a href=/u/${s.id}/edit>Edit</a>"), () => ({ id: 7 }));
  });

  it("regression: escape sequences are compiled to their cooked value", () => {
    expectParity(tpl('<p title="a\\tb">x\\ny \\u00e9 \\`q\\`</p>'));
  });

  it("regression: a backslash before U+2028/U+2029 is a line continuation, not a literal char", () => {
    // `\` + LINE SEPARATOR / PARAGRAPH SEPARATOR cooks to nothing, like `\` + LF.
    expect(cookEscapes("a\\\u2028b\\\u2029c")).toBe("abc");
    expectParity(tpl("<p>a\\\u2028b\\\u2029c</p>"));
  });

  it("regression: reactive id=${() => x()} stays reactive when compiled", async () => {
    const src = tpl("<div id=${() => s.id()}>x</div>");
    const make = () => {
      const [id, setId] = signal("a");
      return { id, setId };
    };
    const s = make();
    const el = runModule<Render>(compileHtmlTemplates(src).code as string)(s);
    expect(el.id).toBe("a");
    s.setId("b");
    await Promise.resolve();
    expect(el.id).toBe("b");
  });

  it("regression: a mixed attribute with null/undefined renders empty like the runtime", () => {
    expectParity(tpl('<div class="a ${s.n} b ${s.u}">x</div>'), () => ({ n: null, u: undefined }));
  });

  it("regression: static attributes are written raw like the runtime, not through the tag factory's sanitizer", () => {
    expectParity(tpl('<a href="javascript:void(0)" style="color: red">x</a>'));
  });

  it("regression: attributes named ref/on/nodes/onElement are plain attributes like the runtime", () => {
    expectParity(tpl('<div ref="r" on="o" nodes="n" onElement="e">x</div>'));
  });

  it("regression: a single non-element root returns the runtime's wrapper div", () => {
    expectParity(tpl("Hello"));
  });

  it("regression: a top-level ${expr} is left to the runtime", () => {
    const result = compileHtmlTemplates(tpl("${s.x}"));
    expect(result.compiledCount).toBe(0);
  });

  it("regression: regex and comments inside ${} do not break expression scanning", () => {
    expectParity(tpl('<p title=${/}/.test("}") ? "y" : "n"}>${s.t /* } */}</p>'), () => ({ t: "T" }));
  });

  it("regression: only html imported from sibujs is compiled", () => {
    expect(compileHtmlTemplates("const el = html`<div></div>`;").code).toBeNull();
    expect(compileHtmlTemplates('import { html } from "lit";\nconst el = html`<div></div>`;').code).toBeNull();
    const member = 'import { html } from "sibujs";\nconst el = foo.html`<div></div>`;';
    expect(compileHtmlTemplates(member).code).toBeNull();
  });

  it("regression: a local html binding shadowing the import is not compiled", () => {
    const src = 'import { html } from "sibujs";\nfunction f(html) { return html`<b></b>`; }';
    expect(compileHtmlTemplates(src).code).toBeNull();
  });

  it("regression: a template the runtime rejects still throws at render time", () => {
    const src = tpl("<script>${s.x}</script>");
    const out = compileHtmlTemplates(src).code ?? src;
    expect(() => runModule<Render>(out)({ x: 1 })).toThrow(/raw-text/);
  });
});

// ── Bug 6: pure annotations in the wrong places ──────────────────────────────

describe("pure annotations", () => {
  const annotate = createPureAnnotationsLoader();
  const IMPORT = 'import { context, tagFactory } from "sibujs";\n';

  it("regression: pure annotations skip method calls", () => {
    expect(annotate(`${IMPORT}store.context(1); api.tagFactory("x");`)).not.toContain("__PURE__");
  });

  it("regression: pure annotations skip function declarations", () => {
    const src = "function pure(x) { return x; }\nconst p = pure(1);";
    expect(annotate(src)).toBe(src);
  });

  it("regression: pure annotations do not touch strings, comments or template text", () => {
    const src = `${IMPORT}const a = "context(1)"; // tagFactory("x")\nconst b = \`context(2)\`;`;
    expect(annotate(src)).toBe(src);
  });

  it("regression: a user function named like a sibujs factory is not marked pure", () => {
    const src = 'function context(name) { registry.push(name); }\ncontext("init");';
    expect(annotate(src)).toBe(src);
    const shadowed = `${IMPORT}function setup(context) { context("side effect"); }`;
    expect(annotate(shadowed)).not.toContain("__PURE__");
  });

  it("regression: the vite plugin annotates only real sibujs factory calls", () => {
    const out = viteProd(`${IMPORT}const c = context(1); obj.context(2);`, { compileTemplates: false });
    expect(out).toContain("const c = /*#__PURE__*/ context(1)");
    expect(out).toContain("obj.context(2)");
  });

  it("regression: webpack plugin does not push a loader rule that cannot resolve", () => {
    const rules: unknown[] = [];
    const afterEnv: Array<() => void> = [];
    const compiler: any = {
      hooks: { afterEnvironment: { tap: (_n: string, cb: () => void) => afterEnv.push(cb) } },
      options: { module: { rules } },
    };
    sibuWebpackPlugin().apply(compiler);
    for (const cb of afterEnv) cb();
    expect(JSON.stringify(rules)).not.toContain("__sibu_inline_loader__");
  });
});

// ── Bug 7: dev mode decided from NODE_ENV at plugin creation ────────────────

describe("dev mode resolution", () => {
  it("regression: `vite build` is production even when NODE_ENV is not 'production'", () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      const plugin = sibuVitePlugin();
      const config = plugin.config?.({}, { command: "build", mode: "production" }) as Record<string, any>;
      expect(config.define.__SIBU_DEV__).toBe("false");
      const out = plugin.transform?.(tpl("<p>x</p>"), "src/a.js");
      expect(out?.code).not.toContain("html`");
    } finally {
      process.env.NODE_ENV = saved;
    }
  });

  it("regression: the dev-mode prologue is valid JavaScript in .js files", () => {
    const plugin = sibuVitePlugin({ devMode: true, pureAnnotations: false });
    const out = plugin.transform?.('import { div } from "sibujs";\nconst x = 1;', "src/a.js")?.code ?? "";
    expect(out).toContain("__SIBU_DEV__ = true");
    // The prologue used to be a TypeScript cast — a SyntaxError in a .js file.
    expect(out).not.toContain(" as unknown");
    expect(() => new Function(out.replace(/import[^;]*;/g, ""))).not.toThrow();
  });
});

// ── Bug 8: local declarations of an imported name were not seen as shadowing ─

describe("shadowing by local declarations", () => {
  const annotate = createPureAnnotationsLoader();

  it("regression: a nested function declaration named like an imported factory is not marked pure", () => {
    const src =
      'import { context } from "sibujs";\n' +
      'function setup() { function context(k) { registry.push(k); } context("a"); }\n';
    expect(annotate(src)).toBe(src);
  });

  it("regression: object/class methods, accessors and generators named like a factory are not marked pure", () => {
    const shapes = [
      "const o = { context(k) { registry.push(k); } };",
      "class A { context(k) { registry.push(k); } }",
      "class A { static context(k) { registry.push(k); } }",
      "const o = { get context() { return registry; } };",
      "const o = { set context(v) { registry.push(v); } };",
      "const o = { async context(k) { registry.push(k); } };",
      "const o = { *context(k) { yield k; } };",
      "function* context(k) { yield k; }",
      "async function run() { async function context(k) { registry.push(k); } }",
      "class A { context(k: string): void { registry.push(k); } }",
    ];
    for (const shape of shapes) {
      const src = `import { context } from "sibujs";\n${shape}\nfunction go() { context("side effect"); }\n`;
      expect(annotate(src), shape).toBe(src);
    }
  });

  it("regression: a private method call this.#context() is not treated as the imported factory", () => {
    const src =
      'import { context } from "sibujs";\n' +
      'class A { #context(k) { registry.push(k); } run() { this.#context("a"); } }\n';
    expect(annotate(src)).toBe(src);
  });

  it("regression: a name also bound by another import is left alone", () => {
    const src = 'import { context } from "sibujs";\nimport { context as context } from "./mine";\ncontext("a");\n';
    expect(annotate(src)).toBe(src);
  });

  it("regression: staticOptimize does not rewrite a call to a local function declaration named like a tag", () => {
    const src =
      'import { div } from "sibujs";\n' +
      "export default () => {\n" +
      "  function div(props) { return { local: props.class }; }\n" +
      '  return div({ class: "x" });\n' +
      "};\n";
    expect(analyzeStaticTemplates(src).hasStaticPatterns).toBe(false);
    const out = viteProd(src, { staticOptimize: true, pureAnnotations: false });
    expect(out).not.toContain("staticTemplate");
    expect(runModule<() => unknown>(out)()).toEqual({ local: "x" });
  });

  it("regression: staticOptimize does not rewrite calls when a method shares the tag's name", () => {
    const src =
      'import { span } from "sibujs";\n' +
      "const ui = { span(o) { return o; } };\n" +
      'export default () => span({ class: "x" }, "t");\n';
    expect(analyzeStaticTemplates(src).hasStaticPatterns).toBe(false);
  });

  it("still annotates real calls after return, in ternaries, and across ASI line breaks", () => {
    const src =
      'import { context } from "sibujs";\n' +
      "const a = b\n" +
      'context("asi")\n' +
      'const t = flag ? context("x") : context("y");\n' +
      'function f() { return context("r"); }\n';
    expect(annotate(src).match(/\/\*#__PURE__\*\/ context\(/g)?.length).toBe(4);
  });
});

// ── Bug 9: webpack read `mode` before webpack applied its defaults ──────────

describe("webpack mode resolution", () => {
  /**
   * A fake compiler that follows webpack 5's `createCompiler` order: plugins
   * are applied while `options.mode` is still what the user wrote, THEN the
   * option defaults are applied, THEN `environment` / `afterEnvironment` fire.
   */
  function createCompiler(userMode: string | undefined, defaultedMode: string | undefined) {
    const taps: Record<string, Array<(...args: unknown[]) => void>> = {};
    const hook = (key: string) => ({
      tap: (_name: string, cb: (...args: unknown[]) => void) => {
        (taps[key] ||= []).push(cb);
      },
    });
    const defined: Record<string, string>[] = [];
    const compiler: any = {
      hooks: {
        compilation: hook("compilation"),
        afterResolvers: hook("afterResolvers"),
        done: hook("done"),
        environment: hook("environment"),
        afterEnvironment: hook("afterEnvironment"),
      },
      options: userMode === undefined ? {} : { mode: userMode },
      webpack: {
        DefinePlugin: class {
          constructor(private defs: Record<string, string>) {}
          apply() {
            defined.push(this.defs);
          }
        },
      },
    };
    return {
      compiler,
      taps,
      defined,
      run(plugin: { apply: (c: any) => void }) {
        plugin.apply(compiler);
        compiler.options.mode = defaultedMode; // applyWebpackOptionsDefaults
        for (const cb of taps.environment ?? []) cb();
        for (const cb of taps.afterEnvironment ?? []) cb();
      },
    };
  }

  let savedEnv: string | undefined;
  beforeEach(() => {
    savedEnv = process.env.NODE_ENV;
    // The usual situation while a webpack config is evaluated.
    process.env.NODE_ENV = "development";
  });
  afterEach(() => {
    process.env.NODE_ENV = savedEnv;
  });

  it("regression: an unset mode that webpack defaults to production defines __SIBU_DEV__ false", () => {
    const fake = createCompiler(undefined, "production");
    fake.run(sibuWebpackPlugin());
    expect(fake.defined).toEqual([{ __SIBU_DEV__: "false" }]);
    expect(fake.taps.done ?? []).toEqual([]);
  });

  it("regression: an unset mode that stays unset after defaults is production, not NODE_ENV", () => {
    const fake = createCompiler(undefined, undefined);
    fake.run(sibuWebpackPlugin());
    expect(fake.defined).toEqual([{ __SIBU_DEV__: "false" }]);
  });

  it("uses the resolved mode, and an explicit devMode still wins", () => {
    const dev = createCompiler(undefined, "development");
    dev.run(sibuWebpackPlugin());
    expect(dev.defined).toEqual([{ __SIBU_DEV__: "true" }]);
    expect(dev.taps.done?.length).toBe(1);

    const forced = createCompiler("production", "production");
    forced.run(sibuWebpackPlugin({ devMode: true }));
    expect(forced.defined).toEqual([{ __SIBU_DEV__: "true" }]);
    expect(forced.taps.done?.length).toBe(1);
  });
});

// ── Bug 10: transforms shifted lines and returned no source map ─────────────

describe("source maps", () => {
  const SRC =
    'import { html, context, div } from "sibujs";\n' + // line 0
    'const ctx = context("theme");\n' + // line 1
    "export default (s) => html`<section\n" + // line 2
    '  class="card">\n' + // line 3
    "  <p>${s.first}</p>\n" + // line 4
    "  <p>${\n" + // line 5
    "    s.second}</p>\n" + // line 6
    "</section>`;\n" + // line 7
    'const after = div({ class: "x" }, "MARKER_AFTER");\n' + // line 8
    "  const indented = MARKER_INDENTED;\n"; // line 9

  function transform(options: Parameters<typeof sibuVitePlugin>[0]) {
    const out = sibuVitePlugin(options).transform?.(SRC, "src/app.js");
    if (!out) throw new Error("nothing transformed");
    return out;
  }

  /** Every token must sit on its original line, and the map must say exactly where it came from. */
  function expectMapped(out: { code: string; map: any }, needle: string): void {
    const src = positionOf(SRC, needle);
    const gen = positionOf(out.code, needle);
    expect(gen.line, `${needle} keeps its line`).toBe(src.line);
    const segments = decodeMappings(out.map.mappings);
    expect(originalPositionFor(segments, gen.line, gen.column), needle).toEqual(src);
  }

  it("regression: the dev prologue adds no line, and the transform returns a valid v3 map", () => {
    const out = transform({ devMode: true, pureAnnotations: true, compileTemplates: false });
    expect(out.code).toContain("__SIBU_DEV__ = true");
    expect(out.code.split("\n").length).toBe(SRC.split("\n").length);
    expect(out.map).toMatchObject({ version: 3, sources: ["src/app.js"], names: [] });
    expect(() => decodeMappings(out.map.mappings)).not.toThrow();
    expectMapped(out, "context(");
    expectMapped(out, "s.first");
    expectMapped(out, "MARKER_AFTER");
    expectMapped(out, "MARKER_INDENTED");
  });

  it("regression: pure annotations and compiled templates keep every line and map tokens back exactly", () => {
    const out = transform({ devMode: true, compileTemplates: true, staticOptimize: true });
    // Everything was applied…
    expect(out.code).toContain("/*#__PURE__*/ context(");
    expect(out.code).not.toContain("html`");
    expect(out.code).toContain("staticTemplate");
    // …the original lines are all still where they were (helpers come after)…
    const genLines = out.code.split("\n");
    expect(genLines.length).toBeGreaterThan(SRC.split("\n").length);
    expect(genLines[9]).toBe("  const indented = MARKER_INDENTED;");
    // …and tokens inside and after the multi-line template map to their
    // exact original line and column.
    expectMapped(out, "context(");
    expectMapped(out, "s.first");
    expectMapped(out, "s.second");
    expectMapped(out, "MARKER_INDENTED");
    const segments = decodeMappings(out.map.mappings);
    for (const s of segments) {
      if (s.genLine < SRC.split("\n").length) expect(s.srcLine, `generated line ${s.genLine}`).toBe(s.genLine);
    }
    // The compiled module still renders what the runtime renders.
    const scope = () => ({ first: "A", second: "B" });
    const runtime = runModule<Render>(SRC.replace(/\n.*MARKER_INDENTED.*\n/, "\n"))(scope());
    const compiled = runModule<Render>(out.code.replace(/\n.*MARKER_INDENTED.*\n/, "\n"))(scope());
    expect(describeRoot(compiled)).toBe(describeRoot(runtime));
  });
});

// ── Bug 11: every step lexed the module again ───────────────────────────────

describe("shared module scan", () => {
  it("regression: one vite transform lexes the module once, whatever steps run", () => {
    // A fresh source string, so no earlier test warmed a cache for it.
    const src =
      `import { html, context, div } from "sibujs";\n// ${Math.random()}\n` +
      'const c = context("k");\n' +
      'export default (s) => [div({ class: "a" }, "t"), html`<b>${s.x}</b>`];\n';
    const plugin = sibuVitePlugin({ devMode: true, compileTemplates: true, staticOptimize: true });
    const before = scanStats.tokenize;
    const out = plugin.transform?.(src, "src/a.js");
    expect(out?.code).toContain("/*#__PURE__*/");
    expect(out?.code).toContain("staticTemplate");
    expect(scanStats.tokenize - before).toBe(1);
  });

  it("regression: the standalone entry points reuse the scan of an unchanged source", () => {
    const src = `import { html, context } from "sibujs";\n// ${Math.random()}\nconst x = context(html\`<b></b>\`);\n`;
    const before = scanStats.tokenize;
    injectPureAnnotations(src);
    compileHtmlTemplates(src);
    analyzeStaticTemplates(src);
    expect(scanStats.tokenize - before).toBe(1);
    // A changed source is scanned afresh.
    injectPureAnnotations(`${src}\n`);
    expect(scanStats.tokenize - before).toBe(2);
  });
});
