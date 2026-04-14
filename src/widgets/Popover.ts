import { effect } from "../core/signals/effect";
import { signal } from "../core/signals/signal";

let popoverIdCounter = 0;
const boundPopovers = new WeakMap<HTMLElement, () => void>();

/**
 * popover provides simple state management for positioned floating content.
 * Manages open/close/toggle without any DOM coupling.
 */
export function popover(): {
  isOpen: () => boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
  /** WAI-ARIA non-modal dialog wiring: `role=dialog`, `aria-expanded` on
   *  trigger, Escape closes, click-outside closes. Returns dispose. */
  bind: (els: { trigger: HTMLElement; popover: HTMLElement; labelledBy?: HTMLElement }) => () => void;
} {
  const [isOpen, setIsOpen] = signal<boolean>(false);

  function open(): void {
    setIsOpen(true);
  }

  function close(): void {
    setIsOpen(false);
  }

  function toggle(): void {
    setIsOpen((prev) => !prev);
  }

  function bind(els: { trigger: HTMLElement; popover: HTMLElement; labelledBy?: HTMLElement }): () => void {
    const existing = boundPopovers.get(els.trigger);
    if (existing) return existing;

    const id = `sibu-popover-${++popoverIdCounter}`;
    // Capture prior attribute state so teardown can restore (or remove)
    // every attribute we touch — bind() should be reversible.
    const prevPopoverRole = els.popover.getAttribute("role");
    const prevPopoverId = els.popover.id;
    const prevLabelledBy = els.popover.getAttribute("aria-labelledby");
    const prevTriggerHaspopup = els.trigger.getAttribute("aria-haspopup");
    const prevTriggerControls = els.trigger.getAttribute("aria-controls");

    els.popover.setAttribute("role", "dialog");
    els.popover.id = id;
    els.trigger.setAttribute("aria-haspopup", "dialog");
    els.trigger.setAttribute("aria-controls", id);
    let assignedLabelId: string | null = null;
    if (els.labelledBy) {
      if (!els.labelledBy.id) {
        els.labelledBy.id = `${id}-label`;
        assignedLabelId = els.labelledBy.id;
      }
      els.popover.setAttribute("aria-labelledby", els.labelledBy.id);
    }

    const fxTeardown = effect(() => {
      const open = isOpen();
      els.trigger.setAttribute("aria-expanded", open ? "true" : "false");
      els.popover.hidden = !open;
    });

    const onTriggerClick = (e: Event) => {
      e.preventDefault();
      toggle();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen()) {
        e.stopPropagation();
        close();
        els.trigger.focus();
      }
    };
    const onDocPointer = (e: PointerEvent) => {
      if (!isOpen()) return;
      const t = e.target as Node | null;
      if (!t) return;
      if (els.trigger.contains(t) || els.popover.contains(t)) return;
      close();
    };

    els.trigger.addEventListener("click", onTriggerClick);
    els.popover.addEventListener("keydown", onKey);
    els.trigger.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDocPointer);

    const teardown = () => {
      boundPopovers.delete(els.trigger);
      fxTeardown();
      els.trigger.removeEventListener("click", onTriggerClick);
      els.popover.removeEventListener("keydown", onKey);
      els.trigger.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDocPointer);
      // Reverse every attribute mutation to leave the DOM as we found it.
      if (prevPopoverRole === null) els.popover.removeAttribute("role");
      else els.popover.setAttribute("role", prevPopoverRole);
      if (prevPopoverId === "") els.popover.removeAttribute("id");
      else els.popover.id = prevPopoverId;
      if (prevLabelledBy === null) els.popover.removeAttribute("aria-labelledby");
      else els.popover.setAttribute("aria-labelledby", prevLabelledBy);
      if (assignedLabelId && els.labelledBy?.id === assignedLabelId) {
        els.labelledBy.removeAttribute("id");
      }
      if (prevTriggerHaspopup === null) els.trigger.removeAttribute("aria-haspopup");
      else els.trigger.setAttribute("aria-haspopup", prevTriggerHaspopup);
      if (prevTriggerControls === null) els.trigger.removeAttribute("aria-controls");
      else els.trigger.setAttribute("aria-controls", prevTriggerControls);
      els.trigger.removeAttribute("aria-expanded");
    };
    boundPopovers.set(els.trigger, teardown);
    return teardown;
  }

  return { isOpen, open, close, toggle, bind };
}
