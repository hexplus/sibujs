import { effect } from "../core/signals/effect";
import { signal } from "../core/signals/signal";

export interface ImageLoaderState {
  /** Reactive loading state: "pending" | "loaded" | "error". */
  status: () => "pending" | "loaded" | "error";
  /** The loaded HTMLImageElement (null until `status === "loaded"`). */
  image: () => HTMLImageElement | null;
  /** Intrinsic width, 0 until loaded. */
  width: () => number;
  /** Intrinsic height, 0 until loaded. */
  height: () => number;
  /** Abort in-flight load and reset state. */
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
  let disposed = false;

  function start(url: string) {
    if (current) {
      current.onload = null;
      current.onerror = null;
    }
    setStatus("pending");
    setImage(null);
    const img = new Image();
    current = img;
    img.onload = () => {
      if (disposed || current !== img) return;
      setImage(img);
      setWidth(img.naturalWidth);
      setHeight(img.naturalHeight);
      setStatus("loaded");
    };
    img.onerror = () => {
      if (disposed || current !== img) return;
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
    disposed = true;
    if (srcEffectTeardown) {
      srcEffectTeardown();
      srcEffectTeardown = null;
    }
    if (current) {
      current.onload = null;
      current.onerror = null;
      current = null;
    }
  }

  return { status, image, width, height, dispose };
}
