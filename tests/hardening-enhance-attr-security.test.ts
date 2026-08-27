/**
 * `enhance()`'s reactive `attr()` is an attribute sink on the public surface.
 *
 * Its NAME comes from author-written setup code, but its VALUE is a runtime
 * getter — the same trust level as `bindAttribute`'s getter and `bindAttrs`'
 * static value. It must therefore reach the same verdict as every other
 * attribute writer, or progressive enhancement becomes the one public path
 * where `javascript:` still lands in the DOM.
 */

import { describe, expect, it } from "vitest";
import { enhance } from "../src/platform/enhance";

function host(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

describe("enhance attr() — shared attribute policy", () => {
  it("blocks a javascript: href", () => {
    const root = host('<a id="a" href="/safe">x</a>');
    enhance(root, ({ attr }) => {
      attr("#a", "href", () => "javascript:alert(1)");
    });

    expect(root.querySelector("#a")?.getAttribute("href") ?? "").not.toContain("javascript:");
    root.remove();
  });

  it("blocks a javascript: src", () => {
    const root = host('<img id="i" alt="x">');
    enhance(root, ({ attr }) => {
      attr("#i", "src", () => "javascript:alert(1)");
    });

    expect(root.querySelector("#i")?.getAttribute("src") ?? "").not.toContain("javascript:");
    root.remove();
  });

  it("refuses an on* event-handler attribute", () => {
    const root = host('<button id="b">x</button>');
    enhance(root, ({ attr }) => {
      attr("#b", "onclick", () => "alert(1)");
    });

    expect(root.querySelector("#b")?.hasAttribute("onclick")).toBe(false);
    root.remove();
  });

  it("sanitizes an unsafe style declaration list", () => {
    const root = host('<div id="d"></div>');
    enhance(root, ({ attr }) => {
      attr("#d", "style", () => "background: url(https://attacker.example/leak)");
    });

    expect(root.querySelector("#d")?.getAttribute("style") ?? "").not.toContain("url(");
    root.remove();
  });

  it("validates srcset candidates", () => {
    const root = host('<img id="i" alt="x">');
    enhance(root, ({ attr }) => {
      attr("#i", "srcset", () => "javascript:alert(1) 1x, https://ok.example/a.png 2x");
    });

    expect(root.querySelector("#i")?.getAttribute("srcset") ?? "").not.toContain("javascript:");
    root.remove();
  });

  it("preserves safe values and removal semantics", () => {
    const root = host('<a id="a" href="/old">x</a>');
    enhance(root, ({ attr }) => {
      attr("#a", "href", () => "https://example.com/ok");
      attr("#a", "aria-label", () => "Open");
      attr("#a", "data-count", () => 3);
    });

    const a = root.querySelector("#a") as HTMLElement;
    expect(a.getAttribute("href")).toBe("https://example.com/ok");
    expect(a.getAttribute("aria-label")).toBe("Open");
    expect(a.getAttribute("data-count")).toBe("3");
    root.remove();
  });

  it("still removes the attribute for a null/undefined value", () => {
    const root = host('<div id="d" title="here"></div>');
    enhance(root, ({ attr }) => {
      attr("#d", "title", () => null);
    });

    expect(root.querySelector("#d")?.hasAttribute("title")).toBe(false);
    root.remove();
  });

  it("serializes booleans literally, as documented", () => {
    const root = host('<div id="d"></div>');
    enhance(root, ({ attr }) => {
      attr("#d", "aria-expanded", () => false);
    });

    // Documented behaviour: `aria-expanded` must read "false", not vanish.
    expect(root.querySelector("#d")?.getAttribute("aria-expanded")).toBe("false");
    root.remove();
  });
});
