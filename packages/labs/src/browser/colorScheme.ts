import { signal } from "@sibujs/core";

/**
 * colorScheme returns a reactive getter tracking the user's
 * preferred color scheme (light or dark).
 * Uses `matchMedia("(prefers-color-scheme: dark)")` and listens for changes.
 *
 * @returns Object with reactive scheme getter and dispose function for cleanup
 */
export function colorScheme(): { scheme: () => "light" | "dark"; dispose: () => void } {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    const [scheme] = signal<"light" | "dark">("light");
    return { scheme, dispose: () => {} };
  }

  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  const [scheme, setScheme] = signal<"light" | "dark">(mql.matches ? "dark" : "light");

  const handler = (event: MediaQueryListEvent) => {
    setScheme(event.matches ? "dark" : "light");
  };

  mql.addEventListener("change", handler);

  function dispose() {
    mql.removeEventListener("change", handler);
  }

  return { scheme, dispose };
}
