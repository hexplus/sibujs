import { dispose, effect, registerDisposer, signal } from "@sibujs/core";

// ============================================================================
// VIRTUAL SCROLLING
// ============================================================================

export interface VirtualListProps<T> {
  items: () => T[];
  itemHeight: number;
  containerHeight: number;
  overscan?: number;
  renderItem: (item: T, index: number) => HTMLElement;
  class?: string;
}

/**
 * VirtualList renders only visible items for efficient large-list rendering.
 */
export function VirtualList<T>(props: VirtualListProps<T>): HTMLElement {
  const overscan = props.overscan ?? 3;
  const [scrollTop, setScrollTop] = signal(0);

  const container = document.createElement("div");
  container.style.overflow = "auto";
  container.style.height = `${props.containerHeight}px`;
  container.style.position = "relative";
  if (props.class) container.className = props.class;

  const spacer = document.createElement("div");
  spacer.style.position = "relative";

  const content = document.createElement("div");
  content.style.position = "absolute";
  content.style.left = "0";
  content.style.right = "0";

  spacer.appendChild(content);
  container.appendChild(spacer);

  const onScroll = () => setScrollTop(container.scrollTop);
  container.addEventListener("scroll", onScroll);
  registerDisposer(container, () => container.removeEventListener("scroll", onScroll));

  const update = () => {
    const items = props.items();
    const totalHeight = items.length * props.itemHeight;
    spacer.style.height = `${totalHeight}px`;

    const currentScroll = scrollTop();
    const startIndex = Math.max(0, Math.floor(currentScroll / props.itemHeight) - overscan);
    const visibleCount = Math.ceil(props.containerHeight / props.itemHeight) + 2 * overscan;
    const endIndex = Math.min(items.length, startIndex + visibleCount);

    content.style.top = `${startIndex * props.itemHeight}px`;

    // Clear and re-render visible items. Dispose the previous item nodes first —
    // `renderItem` may register reactive bindings/effects on them, and a bare
    // `innerHTML = ""` would detach them without running those disposers,
    // leaking a subscription per item on every scroll tick.
    while (content.firstChild) {
      dispose(content.firstChild);
      content.removeChild(content.firstChild);
    }
    for (let i = startIndex; i < endIndex; i++) {
      const itemEl = props.renderItem(items[i], i);
      itemEl.style.height = `${props.itemHeight}px`;
      itemEl.style.boxSizing = "border-box";
      content.appendChild(itemEl);
    }
  };

  // Tie the render effect to the container's lifetime; disposing the container
  // (e.g. when its parent unmounts) stops the items()/scrollTop() subscription
  // instead of leaking the effect and the whole subtree.
  registerDisposer(container, effect(update));

  return container;
}
