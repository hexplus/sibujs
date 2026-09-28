/**
 * Runtime values must not select an applied stylesheet.
 *
 * THREAT MODEL. `sanitizeUrl` refuses dangerous SCHEMES, so an `https:` or
 * relative URL passes it — and on `<link rel="stylesheet">` that URL is a
 * program in all but name: hostile CSS can redress or hide UI, overlay
 * controls, spoof content, load further subresources and, through selector
 * side channels, leak page data. It does not run script, but "the URL is
 * well-formed" is not "the stylesheet is trusted", exactly as it is not for
 * `<script src>`.
 *
 * THE RULE (utils/elementPolicy.ts): an `href` written by a runtime or reactive
 * writer never ends up on a `<link>` whose `rel` token list contains
 * `stylesheet`, in whichever order `rel` and `href` arrive and through whichever
 * transition. The check runs BEFORE the write, so a stylesheet is never
 * requested and then withdrawn. Developer-authored static template source may
 * still name a stylesheet, and `Head({ link })` remains the explicit API for a
 * runtime-chosen one.
 */

import { afterEach, describe, expect, it } from "vitest";
import { compileHtmlTemplates } from "../src/build/compileTemplates";
import { dispose } from "../src/core/rendering/dispose";
import { html } from "../src/core/rendering/htm";
import { link } from "../src/core/rendering/html";
import { signal } from "../src/core/signals/signal";
import { enhance } from "../src/platform/enhance";
import { Head } from "../src/platform/head";
import { collectStream, renderToStream, renderToString } from "../src/platform/ssr";
import { bindAttribute, bindDynamic } from "../src/reactivity/bindAttribute";
import { bindAttrs } from "../src/ui/reactiveAttr";
import { setSafeAttribute, setTrustedAttribute } from "../src/utils/setSafeAttribute";
import { runModule } from "./helpers/buildTransformHarness";

const EVIL = "https://attacker.example/evil.css";
const RUNTIME = "/runtime.css";
const TRUSTED = "/trusted.css";

/** Is this element, as it stands, an applied stylesheet loading `href`? */
function loadsStylesheet(el: Element): boolean {
  const rel = (el.getAttribute("rel") ?? "").toLowerCase().split(/[\t\n\f\r ]+/);
  return rel.includes("stylesheet") && el.hasAttribute("href");
}

/** Every intermediate state of every <link>, recorded after each mutation. */
const states: string[] = [];
const originals: [Record<string, unknown>, string, unknown][] = [];
/** Runtime-chosen URLs the trace flags when they appear on an applied stylesheet. */
let watched: readonly string[] = [EVIL];
function installTrace(urls: readonly string[] = [EVIL]): void {
  watched = urls;
  const proto = Element.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const method of ["setAttribute", "removeAttribute"] as const) {
    const original = proto[method];
    originals.push([proto, method, original]);
    proto[method] = function (this: Element, ...args: unknown[]) {
      const result = original.apply(this, args);
      // Only a stylesheet loading a RUNTIME-chosen URL is a violation; a static,
      // developer-authored one is allowed by the trust model.
      const href = this.getAttribute("href");
      if (this.localName === "link" && loadsStylesheet(this) && href !== null && watched.includes(href)) {
        states.push(href);
      }
      return result;
    };
  }
}
afterEach(() => {
  for (const [proto, method, original] of originals.splice(0)) proto[method] = original;
  states.length = 0;
  watched = [EVIL];
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

describe("runtime href never becomes an applied stylesheet", () => {
  const REL_SPELLINGS = [
    "stylesheet",
    "STYLESHEET",
    "StyleSheet",
    "alternate stylesheet",
    " stylesheet\t",
    "icon stylesheet",
  ];

  for (const rel of REL_SPELLINGS) {
    it(`PoC: link({ rel: ${JSON.stringify(rel)}, href: runtimeUrl }) — either order`, () => {
      installTrace();
      const a = link({ rel, href: EVIL });
      const b = link({ href: EVIL, rel });
      for (const el of [a, b]) expect(loadsStylesheet(el), el.outerHTML).toBe(false);
      expect(states).toEqual([]);
    });
  }

  it("PoC: html`` with a runtime href, static rel before or after", () => {
    installTrace();
    const a = html`<link rel="stylesheet" href=${EVIL}>`;
    const b = html`<link href=${EVIL} rel="stylesheet">`;
    const c = html`<link REL="Alternate StyleSheet" href="${EVIL}">`;
    for (const el of [a, b, c]) expect(loadsStylesheet(el), el.outerHTML).toBe(false);
    expect(states).toEqual([]);
  });

  it("every URL form is refused on a stylesheet — the rule is about provenance, not scheme", () => {
    for (const href of [EVIL, "/app.css", "./theme.css", "//cdn.example/x.css", "theme.css?v=2"]) {
      expect(loadsStylesheet(link({ rel: "stylesheet", href })), href).toBe(false);
    }
  });

  it("bindAttrs / bindAttribute / bindDynamic / enhance() refuse it too", () => {
    const a = document.createElement("link");
    a.setAttribute("rel", "stylesheet");
    bindAttrs(a, { href: EVIL });

    const b = document.createElement("link");
    b.setAttribute("rel", "stylesheet");
    bindAttribute(b, "href", () => EVIL);

    const c = document.createElement("link");
    c.setAttribute("rel", "stylesheet");
    const [name, setName] = signal("data-x");
    bindDynamic(c, () => name(), EVIL);
    setName("HREF");

    const root = document.createElement("div");
    root.innerHTML = '<link id="l" rel="stylesheet">';
    enhance(root, ({ attr }) => attr("#l", "href", () => EVIL));
    const d = root.querySelector("#l") as Element;

    for (const el of [a, b, c, d]) expect(loadsStylesheet(el), el.outerHTML).toBe(false);
  });
});

describe("reactive transitions never pass through an applied stylesheet", () => {
  interface Case {
    label: string;
    run(): Element;
  }
  const CASES: Case[] = [
    {
      label: "rel preload → stylesheet, runtime href",
      run() {
        const [rel, setRel] = signal("preload");
        const el = link({ rel: () => rel(), href: EVIL, as: "style" });
        setRel("stylesheet");
        return el;
      },
    },
    {
      label: "rel null → stylesheet, runtime href",
      run() {
        const [rel, setRel] = signal<string | null>(null);
        const el = link({ rel: () => rel(), href: EVIL });
        setRel("stylesheet");
        return el;
      },
    },
    {
      label: "rel stylesheet, href safe → attacker",
      run() {
        const [href, setHref] = signal("/safe.css");
        const el = link({ rel: "stylesheet", href: () => href() });
        setHref(EVIL);
        return el;
      },
    },
    {
      label: "static stylesheet link, reactive href rebinding",
      run() {
        const el = html`<link rel="stylesheet" href="/theme.css">`;
        document.head.appendChild(el);
        bindAttribute(el as HTMLElement, "href", () => EVIL);
        return el;
      },
    },
    {
      label: "rel stylesheet → preload → stylesheet, runtime href",
      run() {
        const [rel, setRel] = signal("stylesheet");
        const el = link({ rel: () => rel(), href: EVIL });
        setRel("preload");
        setRel("alternate  STYLESHEET");
        return el;
      },
    },
  ];

  for (const connected of [false, true]) {
    for (const c of CASES) {
      it(`${c.label} (${connected ? "connected" : "detached"})`, () => {
        installTrace();
        const el = c.run();
        if (connected && !el.isConnected) document.head.appendChild(el);
        expect(loadsStylesheet(el), el.outerHTML).toBe(false);
        expect(states, "a stylesheet state existed between two writes").toEqual([]);
      });
    }
  }

  it("stylesheet → null is always allowed (removal cannot load anything)", () => {
    const [rel, setRel] = signal<string | null>("stylesheet");
    const el = html`<link rel=${() => rel()} href="/app.css">`;
    setRel(null);
    expect(el.hasAttribute("rel")).toBe(false);
    expect(el.getAttribute("href")).toBe("/app.css");
  });
});

/**
 * Provenance describes the CURRENT `href`, not the element's history. The
 * invariant is unchanged — a link whose current `href` came from runtime data
 * never becomes an applied stylesheet — but a runtime `href` that was refused,
 * removed or replaced by static source no longer blocks what replaced it.
 */
describe("stylesheet provenance follows the current href", () => {
  interface Sequence {
    label: string;
    run(el: HTMLLinkElement): void;
    /** Is the final state an applied stylesheet (loading `TRUSTED`)? */
    applied: boolean;
  }
  const SEQUENCES: Sequence[] = [
    {
      label: "runtime href → removed → static href → rel stylesheet",
      run(el) {
        setSafeAttribute(el, "href", RUNTIME);
        setSafeAttribute(el, "href", null);
        setTrustedAttribute(el, "href", TRUSTED);
        setSafeAttribute(el, "rel", "stylesheet");
      },
      applied: true,
    },
    {
      label: "runtime href → static replacement → rel stylesheet",
      run(el) {
        setSafeAttribute(el, "href", RUNTIME);
        setTrustedAttribute(el, "href", TRUSTED);
        setSafeAttribute(el, "rel", "stylesheet");
      },
      applied: true,
    },
    {
      label: "runtime HREF → static replacement → STATIC rel stylesheet",
      run(el) {
        setSafeAttribute(el, "HREF", RUNTIME);
        setTrustedAttribute(el, "href", TRUSTED);
        setTrustedAttribute(el, "rel", "stylesheet");
      },
      applied: true,
    },
    {
      label: "a refused runtime href does not taint: stylesheet → runtime href → preload → static href → stylesheet",
      run(el) {
        setSafeAttribute(el, "rel", "stylesheet");
        setSafeAttribute(el, "href", RUNTIME);
        setSafeAttribute(el, "rel", "preload");
        setTrustedAttribute(el, "href", TRUSTED);
        setSafeAttribute(el, "rel", "stylesheet");
      },
      applied: true,
    },
    {
      label: "a runtime href the URL policy removes leaves no mark",
      run(el) {
        setSafeAttribute(el, "href", "javascript:alert(1)");
        setTrustedAttribute(el, "href", TRUSTED);
        setSafeAttribute(el, "rel", "stylesheet");
      },
      applied: true,
    },
    {
      label: "runtime href survives → runtime rel stylesheet is refused",
      run(el) {
        setSafeAttribute(el, "href", RUNTIME);
        setSafeAttribute(el, "rel", "stylesheet");
      },
      applied: false,
    },
    {
      label: "runtime href survives → STATIC rel stylesheet is refused",
      run(el) {
        setSafeAttribute(el, "href", RUNTIME);
        setTrustedAttribute(el, "rel", "stylesheet");
      },
      applied: false,
    },
    {
      label: "static href → runtime replacement → rel stylesheet is refused",
      run(el) {
        setTrustedAttribute(el, "href", TRUSTED);
        setSafeAttribute(el, "href", RUNTIME);
        setSafeAttribute(el, "rel", "stylesheet");
      },
      applied: false,
    },
    {
      label: "a runtime write equal to the static value still counts as runtime (conservative)",
      run(el) {
        setTrustedAttribute(el, "href", TRUSTED);
        setSafeAttribute(el, "href", TRUSTED);
        setSafeAttribute(el, "rel", "stylesheet");
      },
      applied: false,
    },
    {
      label: "reactive href stays runtime across values",
      run(el) {
        const [href, setHref] = signal("/a.css");
        bindAttribute(el, "href", () => href());
        setHref("/b.css");
        setSafeAttribute(el, "rel", "stylesheet");
      },
      applied: false,
    },
    {
      label: "reactive href → null → static href → rel stylesheet",
      run(el) {
        const [href, setHref] = signal<string | null>("/a.css");
        bindAttribute(el, "href", () => href());
        setHref(null);
        setTrustedAttribute(el, "href", TRUSTED);
        setSafeAttribute(el, "rel", "stylesheet");
      },
      applied: true,
    },
  ];

  for (const connected of [false, true]) {
    for (const c of SEQUENCES) {
      it(`${c.label} (${connected ? "connected" : "detached"})`, () => {
        installTrace([EVIL, RUNTIME, "/a.css", "/b.css"]);
        const el = document.createElement("link");
        if (connected) document.head.appendChild(el);
        c.run(el);
        expect(loadsStylesheet(el), el.outerHTML).toBe(c.applied);
        if (c.applied) expect(el.getAttribute("href")).toBe(TRUSTED);
        expect(states, "a runtime href was on an applied stylesheet between two writes").toEqual([]);
      });
    }
  }

  it("a reactive href going to null and back is judged again", () => {
    installTrace([RUNTIME]);
    const [href, setHref] = signal<string | null>(RUNTIME);
    const [rel, setRel] = signal("preload");
    const el = link({ rel: () => rel(), href: () => href() });
    setHref(null);
    setRel("stylesheet");
    expect(el.getAttribute("rel")).toBe("stylesheet");
    setHref(RUNTIME);
    expect(loadsStylesheet(el), el.outerHTML).toBe(false);
    expect(states).toEqual([]);
  });

  it("a runtime rel over a static href, in either attribute order", () => {
    const [rel, setRel] = signal("preload");
    const a = html`<link href="/static.css" rel=${() => rel()}>`;
    const b = html`<link rel=${() => rel()} href="/static.css">`;
    setRel("stylesheet");
    for (const el of [a, b]) {
      expect(loadsStylesheet(el), el.outerHTML).toBe(true);
      expect(el.getAttribute("href")).toBe("/static.css");
    }
  });
});

describe("compiled templates apply the same stylesheet rule", () => {
  const compile = (template: string) => {
    const src = `import { html } from "sibujs";\nexport default (s) => html\`${template}\`;\n`;
    const result = compileHtmlTemplates(src);
    expect(result.compiledCount).toBeGreaterThan(0);
    return runModule<(s: Record<string, unknown>) => Element>(result.code ?? src);
  };

  it("PoC: a compiled runtime href with a static stylesheet rel is refused, in either order", () => {
    installTrace();
    const a = compile('<link href=${s.url} rel="stylesheet">')({ url: EVIL });
    const b = compile('<link rel="stylesheet" href=${s.url}>')({ url: EVIL });
    for (const el of [a, b]) expect(loadsStylesheet(el), el.outerHTML).toBe(false);
    expect(states).toEqual([]);
  });

  it("a compiled static stylesheet link is still applied", () => {
    const el = compile('<link rel="stylesheet" href="/static.css">')({});
    expect(loadsStylesheet(el)).toBe(true);
  });
});

describe("what stays allowed", () => {
  it("developer-authored static template source may name a stylesheet", () => {
    const el = html`<link rel="stylesheet" href="https://fonts.example.com/style.css">`;
    expect(loadsStylesheet(el)).toBe(true);
  });

  it("a runtime rel over a STATIC href turns on the stylesheet the developer named", () => {
    const [rel, setRel] = signal("preload");
    const el = html`<link rel=${() => rel()} href="/print.css">`;
    setRel("stylesheet");
    expect(loadsStylesheet(el)).toBe(true);
    expect(el.getAttribute("href")).toBe("/print.css");
  });

  it("runtime hrefs keep working on non-stylesheet links", () => {
    expect(link({ rel: "preload", as: "style", href: "/x.css" }).getAttribute("href")).toBe("/x.css");
    expect(link({ rel: "icon", href: "/favicon.png" }).getAttribute("href")).toBe("/favicon.png");
    expect(link({ rel: "canonical", href: "https://example.com/a" }).getAttribute("href")).toBe(
      "https://example.com/a",
    );
    expect(link({ rel: "stylesheets", href: "/x" }).getAttribute("href")).toBe("/x");
  });

  it("Head({ link }) remains the explicit trust decision for a runtime-chosen stylesheet", () => {
    const anchor = Head({ link: [{ rel: "stylesheet", href: "/runtime-theme.css" }] });
    const el = document.head.querySelector('link[rel="stylesheet"]') as Element;
    expect(el.getAttribute("href")).toBe("/runtime-theme.css");
    dispose(anchor);
  });

  it("SSR serializes exactly the post-policy DOM, string and stream alike", async () => {
    const tree = html`<div>${link({ rel: "stylesheet", href: EVIL })}${html`<link rel="stylesheet" href="/static.css">`}</div>`;
    const string = renderToString(tree);
    expect(await collectStream(renderToStream(tree))).toBe(string);
    expect(string).not.toContain("attacker.example");
    expect(string).toContain('href="/static.css"');
  });
});
