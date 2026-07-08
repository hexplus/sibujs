import { signal } from "@sibujs/core";

export interface DevtoolsOverlayOptions {
  enabled?: boolean;
  position?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
}

/**
 * Creates an in-browser devtools overlay manager.
 * Manages panels and visibility state reactively.
 * Does NOT create actual DOM elements — that's the consumer's job.
 */
export function createDevtoolsOverlay(options?: DevtoolsOverlayOptions): {
  isEnabled: () => boolean;
  toggle: () => void;
  addPanel: (name: string, render: () => string) => void;
  removePanel: (name: string) => void;
  getPanels: () => Array<{ name: string; render: () => string }>;
  dispose: () => void;
} {
  const [enabled, setEnabled] = signal<boolean>(options?.enabled ?? false);
  const panels: Array<{ name: string; render: () => string }> = [];

  const isEnabled = (): boolean => {
    return enabled();
  };

  const toggle = (): void => {
    setEnabled((prev) => !prev);
  };

  const addPanel = (name: string, render: () => string): void => {
    // Avoid duplicates
    const existing = panels.findIndex((p) => p.name === name);
    if (existing !== -1) {
      panels[existing] = { name, render };
    } else {
      panels.push({ name, render });
    }
  };

  const removePanel = (name: string): void => {
    const index = panels.findIndex((p) => p.name === name);
    if (index !== -1) {
      panels.splice(index, 1);
    }
  };

  const getPanels = (): Array<{ name: string; render: () => string }> => {
    return [...panels];
  };

  const dispose = (): void => {
    panels.length = 0;
    setEnabled(false);
  };

  return { isEnabled, toggle, addPanel, removePanel, getPanels, dispose };
}
