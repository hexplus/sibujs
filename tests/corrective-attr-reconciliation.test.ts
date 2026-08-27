/**
 * Attribute security is a POSTCONDITION on the managed attribute, not a promise
 * about what this particular write added.
 *
 * These APIs attach to DOM that already exists — server-rendered markup,
 * third-party widgets, anything `enhance()` is pointed at. A binding that takes
 * ownership of an attribute slot and then leaves a pre-existing `javascript:`
 * href, unsafe `style`, or live `on*` handler in place has not enforced the
 * policy; it has merely declined to add a second violation.
 *
 * Two concrete escapes existed:
 *   1. `enhance().attr()` compared the RAW desired value against the RAW DOM
 *      value and skipped the write when they matched — so identical unsafe
 *      input never reached the sanitizer at all.
 *   2. `setSafeAttribute()` refused an `on*` string but left any existing
 *      content attribute in that slot untouched.
 */

import { describe, expect, it } from "vitest";
import { div } from "../src/core/rendering/html";
import { enhance } from "../src/platform/enhance";
import { bindAttribute } from "../src/reactivity/bindAttribute";
import { bindAttrs } from "../src/ui/reactiveAttr";
import { setSafeAttribute } from "../src/utils/setSafeAttribute";

function serverAnchor(href: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = `<a id="a" href="${href}">x</a>`;
  document.body.appendChild(root);
  return root;
}

/** Every writer that can attach to pre-existing DOM. */
const WRITERS: Array<{ name: string; bind: (el: HTMLElement, attr: string, value: string) => void }> = [
  {
    name: "bindAttribute",
    bind: (el, attr, value) => {
      bindAttribute(el, attr, () => value);
    },
  },
  {
    name: "bindAttrs (reactive)",
    bind: (el, attr, value) => {
      bindAttrs(el, { [attr]: () => value });
    },
  },
  {
    name: "bindAttrs (static)",
    bind: (el, attr, value) => {
      bindAttrs(el, { [attr]: value });
    },
  },
  {
    name: "setSafeAttribute",
    bind: (el, attr, value) => {
      setSafeAttribute(el, attr, value);
    },
  },
];

describe("existing-DOM reconciliation — dangerous value already present", () => {
  for (const w of WRITERS) {
    it(`${w.name} sanitizes an href that already equals the dangerous input`, () => {
      const el = document.createElement("a");
      el.setAttribute("href", "javascript:alert(1)");

      w.bind(el, "href", "javascript:alert(1)");

      expect(el.getAttribute("href") ?? "", `${w.name} left the unsafe href in place`).not.toContain("javascript:");
    });

    it(`${w.name} sanitizes a style that already equals the dangerous input`, () => {
      const el = document.createElement("div");
      const css = "background: url(https://attacker.example/leak)";
      el.setAttribute("style", css);

      w.bind(el, "style", css);

      expect(el.getAttribute("style") ?? "", `${w.name} left the unsafe style in place`).not.toContain("url(");
    });

    it(`${w.name} removes a pre-existing on* handler when it takes that slot`, () => {
      const el = document.createElement("button");
      el.setAttribute("onclick", "alert(1)");

      w.bind(el, "onclick", "alert(2)");

      expect(el.hasAttribute("onclick"), `${w.name} left a live onclick attribute`).toBe(false);
    });
  }
});

describe("enhance().attr() — reconciles the DOM it attaches to", () => {
  it("replaces a server-rendered javascript: href", () => {
    const root = serverAnchor("javascript:alert(1)");
    enhance(root, ({ attr }) => {
      attr("#a", "href", () => "javascript:alert(1)");
    });

    expect(root.querySelector("#a")?.getAttribute("href") ?? "").not.toContain("javascript:");
    root.remove();
  });

  it("replaces a server-rendered unsafe style", () => {
    const root = document.createElement("div");
    root.innerHTML = '<div id="d" style="background: url(https://attacker.example/leak)"></div>';
    document.body.appendChild(root);

    enhance(root, ({ attr }) => {
      attr("#d", "style", () => "background: url(https://attacker.example/leak)");
    });

    expect(root.querySelector("#d")?.getAttribute("style") ?? "").not.toContain("url(");
    root.remove();
  });

  it("removes a server-rendered on* handler in a slot it binds", () => {
    const root = document.createElement("div");
    root.innerHTML = '<button id="b" onclick="alert(1)">x</button>';
    document.body.appendChild(root);

    enhance(root, ({ attr }) => {
      attr("#b", "onclick", () => "alert(2)");
    });

    expect(root.querySelector("#b")?.hasAttribute("onclick")).toBe(false);
    root.remove();
  });

  it("still writes a safe value over a pre-existing safe value", () => {
    const root = serverAnchor("/old");
    enhance(root, ({ attr }) => {
      attr("#a", "href", () => "/new");
    });

    expect(root.querySelector("#a")?.getAttribute("href")).toBe("/new");
    root.remove();
  });
});

describe("externally-mutated DOM is reconciled on the next reactive run", () => {
  it("re-sanitizes after an external write, when the binding re-runs", () => {
    const [get, set] = [() => value, (v: string) => (value = v)] as const;
    let value = "/safe-one";
    const el = document.createElement("a");

    // A real signal is not required: the binding re-runs on its own schedule in
    // the framework. What matters is that a commit re-asserts the policy on the
    // slot rather than trusting the DOM's current contents.
    bindAttribute(el, "href", () => get());
    expect(el.getAttribute("href")).toBe("/safe-one");

    // Something outside SibuJS rewrites the attribute it does not own.
    el.setAttribute("href", "javascript:alert(1)");

    set("/safe-two");
    // Force the next commit the way the runtime would.
    bindAttribute(el, "href", () => get());
    expect(el.getAttribute("href")).toBe("/safe-two");
  });
});

describe("blank DOM + dangerous input still refused (unchanged)", () => {
  it("tag factory refuses on* and blocks javascript:", () => {
    const el = div({ href: "javascript:alert(1)", onclick: "alert(1)" }) as HTMLElement;
    expect(el.getAttribute("href") ?? "").not.toContain("javascript:");
    expect(el.hasAttribute("onclick")).toBe(false);
  });
});
