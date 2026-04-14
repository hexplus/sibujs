import { effect } from "../core/signals/effect";
import { signal } from "../core/signals/signal";

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

  const getter = resolveTarget(element);
  const cleanup = effect(() => {
    // Remove previous listeners
    if (currentEl && onDragStart && onDragEnd) {
      currentEl.removeEventListener("dragstart", onDragStart);
      currentEl.removeEventListener("dragend", onDragEnd);
    }

    const el = getter();
    currentEl = el;

    if (!el) return;

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

  function dispose() {
    cleanup();
    if (currentEl && onDragStart && onDragEnd) {
      currentEl.removeEventListener("dragstart", onDragStart);
      currentEl.removeEventListener("dragend", onDragEnd);
      currentEl = null;
    }
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
  let onDragLeave: (() => void) | null = null;
  let onDrop: ((e: DragEvent) => void) | null = null;

  const getter = resolveTarget(element);
  const cleanup = effect(() => {
    // Remove previous listeners
    if (currentEl && onDragOver && onDragEnter && onDragLeave && onDrop) {
      currentEl.removeEventListener("dragover", onDragOver);
      currentEl.removeEventListener("dragenter", onDragEnter);
      currentEl.removeEventListener("dragleave", onDragLeave);
      currentEl.removeEventListener("drop", onDrop);
    }

    const el = getter();
    currentEl = el;

    if (!el) return;

    onDragOver = (e: DragEvent) => {
      e.preventDefault();
    };

    onDragEnter = (e: DragEvent) => {
      e.preventDefault();
      setIsOver(true);
    };

    onDragLeave = () => {
      setIsOver(false);
    };

    onDrop = (e: DragEvent) => {
      e.preventDefault();
      setIsOver(false);

      let transferData: unknown = null;
      if (e.dataTransfer) {
        const raw = e.dataTransfer.getData("application/json");
        if (raw) {
          try {
            // Reviver blocks __proto__/constructor/prototype to prevent
            // prototype pollution from a foreign drag source (CWE-1321).
            transferData = JSON.parse(raw, (k, v) =>
              k === "__proto__" || k === "constructor" || k === "prototype" ? undefined : v,
            );
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
    if (currentEl && onDragOver && onDragEnter && onDragLeave && onDrop) {
      currentEl.removeEventListener("dragover", onDragOver);
      currentEl.removeEventListener("dragenter", onDragEnter);
      currentEl.removeEventListener("dragleave", onDragLeave);
      currentEl.removeEventListener("drop", onDrop);
      currentEl = null;
    }
  }

  return { isOver, dispose };
}
