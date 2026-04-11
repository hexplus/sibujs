// ============================================================================
// COMPONENT PATTERNS
// ============================================================================
//
// Note: `composable()` was removed in 1.4.0 — it was an identity wrapper
// (`return setup`) that added nothing over calling the setup function
// directly. Plain functions are already composables in SibuJS.

/**
 * RenderProp implements the render-prop pattern.
 * The render function receives data and returns DOM nodes.
 */
export function RenderProp<T>(props: { data: () => T; render: (data: T) => HTMLElement }): HTMLElement {
  return props.render(props.data());
}

/**
 * withBoundary creates an isolated component boundary for debugging.
 * Wraps component output in a named container with error isolation.
 */
export function withBoundary(
  name: string,
  component: (props?: unknown) => HTMLElement,
): (props?: unknown) => HTMLElement {
  return (props?: unknown) => {
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-sibu-boundary", name);

    try {
      const el = component(props);
      wrapper.appendChild(el);
    } catch (error) {
      const errorEl = document.createElement("div");
      errorEl.setAttribute("data-sibu-boundary-error", name);
      errorEl.style.cssText = "color: red; border: 1px solid red; padding: 8px; margin: 4px;";
      errorEl.textContent = `[${name}] ${error instanceof Error ? error.message : String(error)}`;
      wrapper.appendChild(errorEl);
    }

    return wrapper;
  };
}

/**
 * Slot pattern — provides named slots for component composition.
 */
export function createSlots(slots: Record<string, () => HTMLElement | HTMLElement[] | null>): {
  renderSlot: (name: string, fallback?: () => HTMLElement) => HTMLElement | null;
  hasSlot: (name: string) => boolean;
} {
  return {
    renderSlot(name: string, fallback?: () => HTMLElement): HTMLElement | null {
      const slotFn = slots[name];
      if (slotFn) {
        const result = slotFn();
        if (Array.isArray(result)) {
          const fragment = document.createElement("div");
          fragment.style.display = "contents";
          for (const el of result) fragment.appendChild(el);
          return fragment;
        }
        return result;
      }
      return fallback ? fallback() : null;
    },
    hasSlot(name: string): boolean {
      return name in slots;
    },
  };
}
