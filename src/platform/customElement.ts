// ============================================================================
// CUSTOM ELEMENTS (WEB COMPONENTS)
// ============================================================================

import { reportError } from "../core/errors";
import { dispose, replaceChildrenSafely, withDisposerRollback } from "../core/rendering/dispose";
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

/** Consecutive renders allowed while a component keeps changing its own observed attributes. */
const MAX_RENDER_PASSES = 10;

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

    // Re-rendering is keyed on connection, not on a previous render: a first render
    // that throws leaves nothing rendered, and the element must still re-render
    // when a later attribute change fixes the input.
    private _connected = false;
    // A render in progress, and whether an attribute changed during it. The
    // component may write its host's observed attributes while rendering; with
    // the old subtree kept during the build, rendering again from inside the
    // callback recursed until the stack overflowed.
    private _rendering = false;
    private _dirty = false;

    connectedCallback(): void {
      this._connected = true;
      // Moved in the DOM by its own component while rendering: finish that
      // render, then render again, instead of nesting.
      if (this._rendering) {
        this._dirty = true;
        return;
      }
      this._render();
    }

    disconnectedCallback(): void {
      this._connected = false;
      this._teardown();
    }

    attributeChangedCallback(_name: string, oldValue: string | null, newValue: string | null): void {
      // Browsers call this even when the value is unchanged; a component that
      // mirrors state onto its host would otherwise re-render on every write.
      if (oldValue === newValue || !this._connected) return;
      if (this._rendering) {
        this._dirty = true;
        return;
      }
      this._render();
    }

    private _teardown(): void {
      // Run reactive disposers attached to the rendered subtree before
      // detaching it. Without this, signals/effects/listeners created
      // inside the user component leak across reconnects. Routed through the
      // disposal-aware replacement primitive so the ordering guarantee lives in
      // one place rather than being re-derived per call site.
      replaceChildrenSafely(this._root);
    }

    /**
     * Render as a transaction: build the replacement first, commit only if that
     * succeeds. Tearing the current subtree down before calling the factory
     * meant a throwing rerender (an invalid attribute, say) left the element
     * blank with its live state already disposed. Now a failure keeps the
     * working subtree, releases whatever the failed attempt registered, and is
     * reported with this element as its node so an enclosing ErrorBoundary can
     * claim it.
     */
    private _render(): void {
      this._rendering = true;
      try {
        // Attribute changes made during a render are applied by one more pass
        // after it commits. A component whose every render changes an observed
        // attribute would never settle, so the passes are bounded and reported.
        let passes = 0;
        do {
          this._dirty = false;
          if (++passes > MAX_RENDER_PASSES) {
            reportError(
              new Error(
                `[SibuJS] defineElement(${name}): the component changed its own observed attributes on ${MAX_RENDER_PASSES} consecutive renders; stopped re-rendering.`,
              ),
              { phase: "render", name: `defineElement(${name})`, node: this },
            );
            break;
          }
          this._renderOnce();
        } while (this._dirty && this._connected);
      } finally {
        this._rendering = false;
        this._dirty = false;
      }
    }

    private _renderOnce(): void {
      const props = this._getProps();

      let el: HTMLElement;
      try {
        el = withDisposerRollback(() => component(props, this));
      } catch (err) {
        reportError(err, { phase: "render", name: `defineElement(${name})`, node: this });
        return;
      }

      // Disconnected while the component ran (it removed its own host): the
      // disconnect teardown has already run, so committing would leave a live
      // subtree nothing ever disposes. Release the fresh build instead.
      if (!this._connected) {
        dispose(el);
        return;
      }

      const next: Node[] = [];
      if (options.styles && this._root instanceof ShadowRoot) {
        const styleEl = document.createElement("style");
        styleEl.textContent = options.styles;
        next.push(styleEl);
      }
      next.push(el);

      // Disposes the previous subtree exactly once, then commits the new one.
      replaceChildrenSafely(this._root, ...next);
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
