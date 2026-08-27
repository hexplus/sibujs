// ============================================================================
// CUSTOM ELEMENTS (WEB COMPONENTS)
// ============================================================================

import { replaceChildrenSafely } from "../core/rendering/dispose";
import { isEventHandlerAttr } from "../utils/sanitize";
import { setSafeAttribute } from "../utils/setSafeAttribute";

const SVG_NS = "http://www.w3.org/2000/svg";

export interface CustomElementOptions {
  shadow?: boolean;
  mode?: "open" | "closed";
  styles?: string;
  observedAttributes?: string[];
  // NOTE: there is deliberately no `extends` option. Customized built-in
  // elements need the constructor to derive from the concrete element class
  // (`HTMLButtonElement`, …), `customElements.define(name, ctor, { extends })`,
  // and `is=""` at every call site — and Safari has never shipped them. The
  // option previously existed on this interface and was read nowhere, so it
  // advertised support that did not exist. Removed rather than faked.
}

/**
 * defineElement creates a Web Component wrapping a SibuJS component function.
 */
export function defineElement(
  name: string,
  component: (props: Record<string, unknown>, element: HTMLElement) => HTMLElement,
  options: CustomElementOptions = {},
): void {
  if (customElements.get(name)) return;

  const observed = options.observedAttributes || [];

  class SibuElement extends HTMLElement {
    private _root: HTMLElement | ShadowRoot;
    private _rendered: HTMLElement | null = null;

    static get observedAttributes(): string[] {
      return observed;
    }

    constructor() {
      super();
      if (options.shadow !== false) {
        this._root = this.attachShadow({ mode: options.mode || "open" });
      } else {
        this._root = this;
      }
    }

    connectedCallback(): void {
      this._render();
    }

    disconnectedCallback(): void {
      this._teardown();
    }

    attributeChangedCallback(): void {
      if (this._rendered) {
        this._render();
      }
    }

    private _teardown(): void {
      // Run reactive disposers attached to the rendered subtree before
      // detaching it. Without this, signals/effects/listeners created
      // inside the user component leak across reconnects. Routed through the
      // disposal-aware replacement primitive so the ordering guarantee lives in
      // one place rather than being re-derived per call site.
      this._rendered = null;
      replaceChildrenSafely(this._root);
    }

    private _render(): void {
      this._teardown();
      const props = this._getProps();

      if (options.styles && this._root instanceof ShadowRoot) {
        const styleEl = document.createElement("style");
        styleEl.textContent = options.styles;
        this._root.appendChild(styleEl);
      }

      const el = component(props, this);
      this._root.appendChild(el);
      this._rendered = el;
    }

    private _getProps(): Record<string, unknown> {
      const props: Record<string, unknown> = {};
      for (const attr of this.attributes) {
        props[attr.name] = attr.value;
      }
      return props;
    }
  }

  customElements.define(name, SibuElement);
}

/**
 * Creates an SVG element with proper namespace.
 *
 * Attribute writes go through the framework's shared commit primitive, so the
 * SVG helper enforces exactly the policy the HTML tag factory and the reactive
 * bindings enforce: `on*` strings are refused, `href` / `xlink:href` go through
 * the URL allowlist, and `style` goes through the declaration-list sanitizer.
 * Previously every non-function prop was a raw `setAttribute`, so
 * `svgElement("svg", { onload: "alert(1)" })` installed a live handler that the
 * equivalent HTML call had always refused.
 *
 * Function-valued `on*` props keep their existing meaning — `addEventListener`,
 * never an attribute.
 */
export function svgElement(
  tag: string,
  props: Record<string, unknown> = {},
  ...nodes: (SVGElement | string)[]
): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);

  for (const [key, value] of Object.entries(props)) {
    if (key === "nodes") continue;
    if (typeof value === "function" && isEventHandlerAttr(key)) {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (value != null) {
      setSafeAttribute(el, key, value, { label: "svgElement" });
    }
  }

  for (const child of nodes) {
    if (typeof child === "string") {
      el.appendChild(document.createTextNode(child));
    } else if (child instanceof Node) {
      el.appendChild(child);
    }
  }

  return el;
}
