import { afterEach, describe, expect, it, vi } from "vitest";
import { compileHtmlTemplates } from "../../src/build/compileTemplates";
import { sibuWebpackPlugin } from "../../src/build/webpack";
import { disposeNodeOwn } from "../../src/core/rendering/dispose";
import { html as runtimeHtml } from "../../src/core/rendering/htm";
import { signal } from "../../src/core/signals/signal";
import { runModule } from "../helpers/buildTransformHarness";

type Scope = Record<string, unknown>;
const mod = (template: string) => `import { html } from "sibujs";\nexport default (s) => ${template};\n`;

function compiled<T = Element>(src: string): (s: Scope) => T {
  const result = compileHtmlTemplates(src);
  expect(result.compiledCount, "template should compile").toBeGreaterThan(0);
  return runModule<(s: Scope) => T>(result.code ?? src);
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as { __SIBU_DEV__?: unknown }).__SIBU_DEV__;
});

describe("template compiler gaps (BUGS.md B4)", () => {
  it("regression: disposeNodeOwn(el) releases a compiled function child, as it does at runtime", () => {
    const [label, setLabel] = signal("a");
    let reads = 0;
    const getter = () => {
      reads++;
      return label();
    };
    const runtimeEl = runtimeHtml`<p>${getter}</p>`;
    const compiledEl = compiled(mod("html`<p>${s.child}</p>`"))({ child: getter });
    disposeNodeOwn(runtimeEl);
    disposeNodeOwn(compiledEl);
    const before = reads;
    setLabel("b");
    // Neither binding re-ran: both were owned by the element itself.
    expect(reads).toBe(before);
    expect(compiledEl.textContent).toBe(runtimeEl.textContent);
  });

  it("regression: compiled code emits the runtime's dev warning for a non-function on:event", () => {
    (globalThis as { __SIBU_DEV__?: unknown }).__SIBU_DEV__ = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    runtimeHtml`<button on:click=${"alert(1)"}>x</button>`;
    compiled(mod("html`<button on:click=${s.h}>x</button>`"))({ h: "alert(1)" });
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages).toHaveLength(2);
    expect(messages[1]).toBe(messages[0]);
    expect(messages[0]).toContain("on:click handler is not a function (got string)");
  });

  it("the compiled dev warning stays silent when __SIBU_DEV__ is off", () => {
    (globalThis as { __SIBU_DEV__?: unknown }).__SIBU_DEV__ = false;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    compiled(mod("html`<button on:click=${s.h}>x</button>`"))({ h: 42 });
    expect(warn).not.toHaveBeenCalled();
  });

  it("regression: webpack pureAnnotations: true says what to do instead of silently doing nothing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const compiler = { options: {}, hooks: {} };
    sibuWebpackPlugin({ pureAnnotations: true }).apply(compiler);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("createPureAnnotationsLoader");
    warn.mockClear();
    sibuWebpackPlugin().apply(compiler);
    sibuWebpackPlugin({ pureAnnotations: false }).apply(compiler);
    expect(warn).not.toHaveBeenCalled();
  });

  describe("regression: former runtime fallbacks compile, with the runtime's output", () => {
    const describeNode = (el: Element) => el.outerHTML;
    const cases: { name: string; src: string; scope: () => Scope }[] = [
      { name: "expression on value", src: mod("html`<input value=${s.v}>`"), scope: () => ({ v: "x" }) },
      {
        name: "expression on checked",
        src: mod("html`<input type=checkbox checked=${s.c}>`"),
        scope: () => ({ c: "" }),
      },
      { name: "top-level expression", src: mod("html`a ${s.x} b`"), scope: () => ({ x: "mid" }) },
      { name: "top-level Node", src: mod("html`${s.n}`"), scope: () => ({ n: document.createElement("hr") }) },
      {
        name: "meta element",
        src: mod('html`<meta content=${s.c} http-equiv="refresh">`'),
        scope: () => ({ c: "0;url=javascript:alert(1)" }),
      },
      { name: "static srcdoc", src: mod('html`<iframe srcdoc="<p>x</p>"></iframe>`'), scope: () => ({}) },
      {
        name: "escape with no cooked value",
        src: mod("html`<p>\\u{zz}${s.x}</p>`"),
        scope: () => ({ x: "y" }),
      },
    ];
    for (const c of cases) {
      it(c.name, () => {
        const runtime = runModule<(s: Scope) => Element>(c.src)(c.scope());
        const built = compiled(c.src)(c.scope());
        expect(describeNode(built)).toBe(describeNode(runtime));
      });
    }

    it("a template of one invalid escape is the single template left to the runtime", () => {
      const result = compileHtmlTemplates(mod("html`\\u{zz}`"));
      expect(result.compiledCount).toBe(0);
    });
  });
});
