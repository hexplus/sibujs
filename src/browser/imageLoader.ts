import { effect } from "../core/signals/effect";
import { signal } from "../core/signals/signal";
import { batch } from "../reactivity/batch";

export interface ImageLoaderState {
  /** Reactive loading state: "pending" | "loaded" | "error". */
  status: () => "pending" | "loaded" | "error";
  /** The loaded HTMLImageElement (null until `status === "loaded"`). */
  image: () => HTMLImageElement | null;
  /** Intrinsic width, 0 until loaded. */
  width: () => number;
  /** Intrinsic height, 0 until loaded. */
  height: () => number;
  /**
   * Stop tracking `src`, best-effort cancel an in-flight load (its result is
   * ignored either way), and reset every signal to its initial value.
   */
  dispose: () => void;
}

/**
 * imageLoader reactively loads an image via a hidden `Image()` instance.
 * Exposes `status`, `image`, `width`, `height` as reactive signals — useful
 * for responsive layouts that need the intrinsic dimensions before render,
 * lazy-loaded galleries, and preloading checks.
 *
 * Accepts a reactive `src` getter OR a plain string. When a getter is given
 * and its value changes, the previous load is abandoned and a new one
 * starts.
 *
 * @example
 * ```ts
 * const img = imageLoader("/hero.jpg");
 * // Size the container so there's no layout jump
 * div({ style: () => ({
 *   aspectRatio: `${img.width()} / ${img.height() || 1}`,
 * })});
 * ```
 */
export function imageLoader(src: string | (() => string)): ImageLoaderState {
  const [status, setStatus] = signal<"pending" | "loaded" | "error">("pending");
  const [image, setImage] = signal<HTMLImageElement | null>(null);
  const [width, setWidth] = signal(0);
  const [height, setHeight] = signal(0);

  if (typeof Image === "undefined") {
    return {
      status,
      image,
      width,
      height,
      dispose: () => {},
    };
  }

  let current: HTMLImageElement | null = null;
  // Whether `current` has fired load/error. Only an unsettled request is
  // cancelled: a loaded element may already be held and displayed by a caller.
  let currentSettled = false;
  let disposed = false;

  // Every field describes the CURRENT source, so they are reset together — a
  // pending or failed load must never report the previous image's dimensions.
  function resetState() {
    batch(() => {
      setStatus("pending");
      setImage(null);
      setWidth(0);
      setHeight(0);
    });
  }

  // Detach the previous request and, if it is still in flight, ask the browser
  // to drop it: assigning an empty src aborts the pending fetch. Its handlers
  // are removed first, so the error that assignment may raise is never seen.
  function abandonCurrent() {
    if (!current) return;
    const prev = current;
    current = null;
    prev.onload = null;
    prev.onerror = null;
    if (!currentSettled) prev.src = "";
  }

  function start(url: string) {
    abandonCurrent();
    resetState();
    const img = new Image();
    current = img;
    currentSettled = false;
    img.onload = () => {
      if (disposed || current !== img) return;
      currentSettled = true;
      batch(() => {
        setImage(img);
        setWidth(img.naturalWidth);
        setHeight(img.naturalHeight);
        setStatus("loaded");
      });
    };
    img.onerror = () => {
      if (disposed || current !== img) return;
      currentSettled = true;
      setStatus("error");
    };
    img.src = url;
  }

  let srcEffectTeardown: (() => void) | null = null;
  if (typeof src === "function") {
    // Re-run when the reactive src changes; abandons the prior in-flight load
    // via the `current !== img` guard inside start().
    srcEffectTeardown = effect(() => {
      const url = (src as () => string)();
      start(url);
    });
  } else {
    start(src);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (srcEffectTeardown) {
      srcEffectTeardown();
      srcEffectTeardown = null;
    }
    abandonCurrent();
    resetState();
  }

  return { status, image, width, height, dispose };
}
