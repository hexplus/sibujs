import { effect } from "../core/signals/effect";
import { signal } from "../core/signals/signal";

let tooltipIdCounter = 0;

// Track which trigger elements already have a bind() active so a second
// call short-circuits rather than corrupting aria-describedby restore.
const boundTriggers = new WeakMap<HTMLElement, () => void>();

/**
 * tooltip manages tooltip visibility with optional show delay.
 * Timer cleanup is handled via closure variables per the framework convention.
 */
export function tooltip(options?: { delay?: number; hideDelay?: number }): {
  isVisible: () => boolean;
  show: () => void;
  hide: () => void;
  content: () => string;
  setContent: (text: string) => void;
  /** WAI-ARIA Tooltip pattern — wires `role=tooltip`, `aria-describedby`,
   *  Escape-to-dismiss, and pointer hover-grace per WCAG 1.4.13. */
  bind: (els: { trigger: HTMLElement; tooltip: HTMLElement }) => () => void;
} {
  const delay = options?.delay ?? 0;
  const hideDelay = options?.hideDelay ?? 100;

  const [isVisible, setIsVisible] = signal<boolean>(false);
  const [content, setContent] = signal<string>("");

  let delayTimer: ReturnType<typeof setTimeout> | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  function show(): void {
    if (hideTimer !== null) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    if (delay > 0) {
      if (delayTimer !== null) clearTimeout(delayTimer);
      delayTimer = setTimeout(() => {
        setIsVisible(true);
        delayTimer = null;
      }, delay);
    } else {
      setIsVisible(true);
    }
  }

  function hide(): void {
    if (delayTimer !== null) {
      clearTimeout(delayTimer);
      delayTimer = null;
    }
    setIsVisible(false);
  }

  function scheduleHide(): void {
    if (delayTimer !== null) {
      clearTimeout(delayTimer);
      delayTimer = null;
    }
    if (hideTimer !== null) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      hideTimer = null;
      setIsVisible(false);
    }, hideDelay);
  }

  function bind(els: { trigger: HTMLElement; tooltip: HTMLElement }): () => void {
    // Idempotent: returning the prior teardown prevents corrupted
    // aria-describedby restore on double-bind.
    const existing = boundTriggers.get(els.trigger);
    if (existing) return existing;
    const id = `sibu-tooltip-${++tooltipIdCounter}`;
    els.tooltip.setAttribute("role", "tooltip");
    els.tooltip.id = id;
    const prevDescribedBy = els.trigger.getAttribute("aria-describedby");
    els.trigger.setAttribute("aria-describedby", prevDescribedBy ? `${prevDescribedBy} ${id}` : id);

    const fxTeardown = effect(() => {
      els.tooltip.hidden = !isVisible();
    });

    const onTriggerEnter = () => show();
    const onTriggerLeave = () => scheduleHide();
    // Hoverable: keep visible while pointer is over the tooltip itself.
    const onTooltipEnter = () => {
      if (hideTimer !== null) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
    };
    const onTooltipLeave = () => scheduleHide();
    const onFocus = () => show();
    const onBlur = () => hide();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isVisible()) {
        e.stopPropagation();
        hide();
      }
    };

    els.trigger.addEventListener("pointerenter", onTriggerEnter);
    els.trigger.addEventListener("pointerleave", onTriggerLeave);
    els.trigger.addEventListener("focus", onFocus);
    els.trigger.addEventListener("blur", onBlur);
    els.trigger.addEventListener("keydown", onKey);
    els.tooltip.addEventListener("pointerenter", onTooltipEnter);
    els.tooltip.addEventListener("pointerleave", onTooltipLeave);

    const teardown = () => {
      boundTriggers.delete(els.trigger);
      fxTeardown();
      els.trigger.removeEventListener("pointerenter", onTriggerEnter);
      els.trigger.removeEventListener("pointerleave", onTriggerLeave);
      els.trigger.removeEventListener("focus", onFocus);
      els.trigger.removeEventListener("blur", onBlur);
      els.trigger.removeEventListener("keydown", onKey);
      els.tooltip.removeEventListener("pointerenter", onTooltipEnter);
      els.tooltip.removeEventListener("pointerleave", onTooltipLeave);
      // Splice our id out of the CURRENT aria-describedby value so any ids
      // that other libraries added between bind and teardown survive.
      const cur = els.trigger.getAttribute("aria-describedby");
      if (cur) {
        const remaining = cur.split(/\s+/).filter((part) => part && part !== id);
        if (remaining.length > 0) els.trigger.setAttribute("aria-describedby", remaining.join(" "));
        else els.trigger.removeAttribute("aria-describedby");
      } else if (prevDescribedBy) {
        // Something stripped our addition and the prior value — restore it.
        els.trigger.setAttribute("aria-describedby", prevDescribedBy);
      }
      if (delayTimer !== null) clearTimeout(delayTimer);
      if (hideTimer !== null) clearTimeout(hideTimer);
    };
    boundTriggers.set(els.trigger, teardown);
    return teardown;
  }

  return { isVisible, show, hide, content, setContent, bind };
}
