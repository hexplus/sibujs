import { afterEach, describe, expect, it, vi } from "vitest";
import { div } from "../src/core/rendering/html";
import { signal } from "../src/core/signals/signal";
import { installServerDom } from "../src/platform/serverDom";
import { renderToString } from "../src/platform/ssr";
import { styleKeyToProperty } from "../src/utils/styleKey";

// ---------------------------------------------------------------------------
// A style-map key names ONE CSS property, wherever the element is rendered.
//
// The client renderer kebab-cased every capital letter, so a case-sensitive
// custom property (`--fooBar`) became a different one (`--foo-bar`), and the
// CSSOM names `cssFloat` / `msTransform` / `webkitLineClamp` became invalid
// properties (`css-float`, `ms-transform`, `webkit-line-clamp`) that a browser
// drops. The server DOM had its own, different copy of the rule for
// `style.fooBar` access, while the tag factory still used the broken one there
// too — so the server emitted the invalid names verbatim.
// ---------------------------------------------------------------------------

const CASES: [key: string, property: string][] = [
  ["--x", "--x"],
  ["--fooBar", "--fooBar"],
  ["--foo-bar", "--foo-bar"],
  ["cssFloat", "float"],
  ["msTransform", "-ms-transform"],
  ["MsTransform", "-ms-transform"],
  ["WebkitLineClamp", "-webkit-line-clamp"],
  ["webkitLineClamp", "-webkit-line-clamp"],
  ["MozAppearance", "-moz-appearance"],
  ["oTransition", "-o-transition"],
  ["backgroundColor", "background-color"],
  ["background-color", "background-color"],
  ["-webkit-line-clamp", "-webkit-line-clamp"],
  ["zIndex", "z-index"],
];

/** Property names a client render passes to the CSSOM, in call order. */
function clientProperties(build: () => Element): string[] {
  const names: string[] = [];
  const original = CSSStyleDeclaration.prototype.setProperty;
  const spy = vi.spyOn(CSSStyleDeclaration.prototype, "setProperty").mockImplementation(function (
    this: CSSStyleDeclaration,
    name: string,
    value: string | null,
    priority?: string,
  ) {
    names.push(name);
    return original.call(this, name, value, priority);
  });
  try {
    build();
  } finally {
    spy.mockRestore();
  }
  return names;
}

/** Property names in the server DOM's serialized `style` attribute. */
function serverProperties(build: () => Element): string[] {
  const uninstall = installServerDom({ force: true });
  try {
    const html = renderToString(build());
    const style = /style="([^"]*)"/.exec(html)?.[1] ?? "";
    return style
      .split(";")
      .map((decl) => decl.slice(0, decl.indexOf(":")).trim())
      .filter(Boolean);
  } finally {
    uninstall();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("styleKeyToProperty", () => {
  for (const [key, property] of CASES) {
    it(`maps ${JSON.stringify(key)} to ${JSON.stringify(property)}`, () => {
      expect(styleKeyToProperty(key)).toBe(property);
    });
  }
});

describe("client and server render the same declarations for a style map", () => {
  for (const [key, property] of CASES) {
    it(`static map: ${JSON.stringify(key)}`, () => {
      const build = () => div({ style: { [key]: "1" } });
      expect(clientProperties(build)).toEqual([property]);
      expect(serverProperties(build)).toEqual([property]);
    });

    it(`per-property getter: ${JSON.stringify(key)}`, () => {
      const build = () => div({ style: { [key]: () => "1" } });
      expect(clientProperties(build)).toEqual([property]);
      expect(serverProperties(build)).toEqual([property]);
    });

    it(`whole-style getter: ${JSON.stringify(key)}`, () => {
      const build = () => div({ style: () => ({ [key]: "1" }) });
      expect(clientProperties(build)).toEqual([property]);
      expect(serverProperties(build)).toEqual([property]);
    });
  }

  it("renders a mixed map identically on both sides", () => {
    const map = Object.fromEntries(CASES.map(([key], i) => [key, String(i + 1)]));
    // Several keys name the same property; the CSSOM keeps the last write, as
    // the server DOM does.
    const build = () => div({ style: map });
    expect(clientProperties(build)).toEqual(CASES.map(([, property]) => property));
    expect(serverProperties(build)).toEqual([...new Set(CASES.map(([, property]) => property))]);
  });
});

describe("a case-sensitive custom property set from a style map", () => {
  it("is written under its own name, readable with getPropertyValue", () => {
    const el = div({ style: { "--fooBar": "1", "--foo-bar": "2" } }) as HTMLElement;
    expect(el.style.getPropertyValue("--fooBar")).toBe("1");
    expect(el.style.getPropertyValue("--foo-bar")).toBe("2");
  });

  it("is removed under the name it was set with when a whole-style getter drops it", () => {
    const [on, setOn] = signal(true);
    const removed: string[] = [];
    const original = CSSStyleDeclaration.prototype.removeProperty;
    vi.spyOn(CSSStyleDeclaration.prototype, "removeProperty").mockImplementation(function (
      this: CSSStyleDeclaration,
      name: string,
    ) {
      removed.push(name);
      return original.call(this, name);
    });
    const el = div({ style: () => (on() ? { "--fooBar": "1", cssFloat: "left" } : {}) }) as HTMLElement;
    expect(el.style.getPropertyValue("--fooBar")).toBe("1");
    expect(el.style.getPropertyValue("float")).toBe("left");

    setOn(false);
    expect(removed).toEqual(["--fooBar", "float"]);
    expect(el.style.getPropertyValue("--fooBar")).toBe("");
    expect(el.style.getPropertyValue("float")).toBe("");
    expect(el.getAttribute("style") ?? "").toBe("");
  });

  it("the server DOM's property access uses the same mapping", () => {
    const uninstall = installServerDom({ force: true });
    try {
      const el = document.createElement("div") as HTMLElement;
      (el.style as unknown as Record<string, string>).cssFloat = "left";
      (el.style as unknown as Record<string, string>).MsTransform = "none";
      (el.style as unknown as Record<string, string>)["--fooBar"] = "1";
      expect(el.getAttribute("style")).toBe("float: left; -ms-transform: none; --fooBar: 1;");
    } finally {
      uninstall();
    }
  });
});
