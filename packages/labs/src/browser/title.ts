import { effect } from "@sibujs/core";

/**
 * title sets `document.title` reactively. Accepts a static string
 * or a reactive getter function. Returns a dispose function that
 * restores the previous document title.
 *
 * @param title Static string or reactive getter for the document title
 * @returns Dispose function that restores the original title
 */
export function title(value: string | (() => string)): () => void {
  if (typeof document === "undefined") {
    return () => {};
  }

  const previousTitle = document.title;

  if (typeof value === "function") {
    const cleanup = effect(() => {
      document.title = value();
    });

    return () => {
      cleanup();
      document.title = previousTitle;
    };
  }

  // Static string
  document.title = value;

  return () => {
    document.title = previousTitle;
  };
}
