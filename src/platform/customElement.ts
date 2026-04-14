// ============================================================================
// CUSTOM ELEMENTS (WEB COMPONENTS)
// ============================================================================

import { dispose } from "../core/rendering/dispose";

export interface CustomElementOptions {
  shadow?: boolean;
  mode?: "open" | "closed";
  styles?: string;
  observedAttributes?: string[];
  extends?: string;
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
      if (this._rendered) {
        // Run reactive disposers attached to the rendered subtree before
        // detaching it. Without this, signals/effects/listeners created
        // inside the user component leak across reconnects.
        dispose(this._rendered);
        this._rendered = null;
      }
      this._root.replaceChildren();
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
 */
export function svgElement(
  tag: string,
  props: Record<string, unknown> = {},
  ...nodes: (SVGElement | string)[]
): SVGElement {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const el = document.createElementNS(SVG_NS, tag);

  for (const [key, value] of Object.entries(props)) {
    if (key === "nodes") continue;
    if (typeof value === "function" && key.startsWith("on")) {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (value != null) {
      el.setAttribute(key, String(value));
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
