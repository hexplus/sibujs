import { effect } from "../core/signals/effect";
import { signal } from "../core/signals/signal";
import { isUnsafeKey } from "../utils/guards";

type ElementTarget = (() => HTMLElement | null) | { current: HTMLElement | null };
function resolveTarget(target: ElementTarget): () => HTMLElement | null {
  return typeof target === "function" ? target : () => target.current;
}

/**
 * draggable makes an element draggable and tracks its dragging state.
 * Sets the `draggable` attribute and attaches dragstart/dragend listeners.
 * Serializes the provided data as JSON into the dataTransfer.
 *
 * @param element Reactive getter or ref returning the HTMLElement to make draggable (or null)
 * @param data Optional data payload to transfer on drag
 * @returns Object with reactive isDragging getter and dispose function
 */
export function draggable(element: ElementTarget, data?: unknown): { isDragging: () => boolean; dispose: () => void } {
  const [isDragging, setIsDragging] = signal(false);

  if (typeof window === "undefined") {
    return { isDragging, dispose: () => {} };
  }

  let currentEl: HTMLElement | null = null;
  let onDragStart: ((e: DragEvent) => void) | null = null;
  let onDragEnd: (() => void) | null = null;
  // The element's `draggable` attribute before this helper set it.
  let prevDraggableAttr: string | null = null;

  // Give the current element back exactly as it was: listeners removed, the
  // original `draggable` attribute restored, and any in-progress drag state
  // cleared. Retargeting and disposal used to remove only the listeners, so a
  // relinquished element stayed natively draggable and `isDragging` could stay
  // true forever.
  function detach(): void {
    if (!currentEl) return;
    if (onDragStart) currentEl.removeEventListener("dragstart", onDragStart);
    if (onDragEnd) currentEl.removeEventListener("dragend", onDragEnd);
    if (prevDraggableAttr === null) currentEl.removeAttribute("draggable");
    else currentEl.setAttribute("draggable", prevDraggableAttr);
    currentEl = null;
    onDragStart = null;
    onDragEnd = null;
    setIsDragging(false);
  }

  const getter = resolveTarget(element);
  const cleanup = effect(() => {
    const el = getter();
    if (el === currentEl) return;
    detach();
    if (!el) return;

    currentEl = el;
    prevDraggableAttr = el.getAttribute("draggable");
    el.draggable = true;

    onDragStart = (e: DragEvent) => {
      setIsDragging(true);
      if (e.dataTransfer && data !== undefined) {
        e.dataTransfer.setData("application/json", JSON.stringify(data));
      }
    };

    onDragEnd = () => {
      setIsDragging(false);
    };

    el.addEventListener("dragstart", onDragStart);
    el.addEventListener("dragend", onDragEnd);
  });

  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    cleanup();
    detach();
  }

  return { isDragging, dispose };
}

/**
 * dropZone turns an element into a drop zone and tracks drag-over state.
 * Listens for dragenter, dragleave, dragover, and drop events.
 * Calls options.onDrop with the parsed data payload and the DragEvent.
 *
 * @param element Reactive getter or ref returning the HTMLElement to use as drop zone (or null)
 * @param options Object with onDrop callback receiving the transferred data and event
 * @returns Object with reactive isOver getter and dispose function
 */
export function dropZone(
  element: ElementTarget,
  options: { onDrop: (data: unknown, event: DragEvent) => void },
): { isOver: () => boolean; dispose: () => void } {
  const [isOver, setIsOver] = signal(false);

  if (typeof window === "undefined") {
    return { isOver, dispose: () => {} };
  }

  let currentEl: HTMLElement | null = null;
  let onDragOver: ((e: DragEvent) => void) | null = null;
  let onDragEnter: ((e: DragEvent) => void) | null = null;
  let onDragLeave: ((e: DragEvent) => void) | null = null;
  let onDrop: ((e: DragEvent) => void) | null = null;
  // Balanced enter/leave depth. `dragenter` / `dragleave` bubble from every
  // descendant, and moving between children fires the new child's enter before
  // the old child's leave — so clearing on every leave made `isOver` flicker
  // false while the pointer was still inside the zone.
  let depth = 0;

  function resetOver(): void {
    depth = 0;
    setIsOver(false);
  }

  function detach(): void {
    if (currentEl && onDragOver && onDragEnter && onDragLeave && onDrop) {
      currentEl.removeEventListener("dragover", onDragOver);
      currentEl.removeEventListener("dragenter", onDragEnter);
      currentEl.removeEventListener("dragleave", onDragLeave);
      currentEl.removeEventListener("drop", onDrop);
    }
    currentEl = null;
    resetOver();
  }

  const getter = resolveTarget(element);
  const cleanup = effect(() => {
    const el = getter();
    if (el === currentEl) return;
    detach();

    if (!el) return;
    currentEl = el;

    onDragOver = (e: DragEvent) => {
      e.preventDefault();
    };

    onDragEnter = (e: DragEvent) => {
      e.preventDefault();
      depth++;
      setIsOver(true);
    };

    onDragLeave = (e: DragEvent) => {
      depth = Math.max(0, depth - 1);
      // A leave whose destination is outside the zone ends the hover outright,
      // even if an enter was missed along the way.
      const to = e.relatedTarget as Node | null;
      const leftZone = to != null && typeof (to as Node).nodeType === "number" && !el.contains(to);
      if (depth === 0 || leftZone) resetOver();
    };

    onDrop = (e: DragEvent) => {
      e.preventDefault();
      resetOver();

      let transferData: unknown = null;
      if (e.dataTransfer) {
        const raw = e.dataTransfer.getData("application/json");
        if (raw) {
          try {
            // Reviver blocks prototype-pollution keys from a foreign drag
            // source (CWE-1321) via the shared guard.
            transferData = JSON.parse(raw, (k, v) => (isUnsafeKey(k) ? undefined : v));
          } catch {
            transferData = raw;
          }
        }
      }
      options.onDrop(transferData, e);
    };

    el.addEventListener("dragover", onDragOver);
    el.addEventListener("dragenter", onDragEnter);
    el.addEventListener("dragleave", onDragLeave);
    el.addEventListener("drop", onDrop);
  });

  function dispose() {
    cleanup();
    detach();
  }

  return { isOver, dispose };
}
