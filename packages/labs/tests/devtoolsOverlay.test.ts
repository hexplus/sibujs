import { describe, expect, it } from "vitest";
import { createDevtoolsOverlay } from "../src/devtools/devtoolsOverlay";

describe("devtoolsOverlay", () => {
  it("initializes with default disabled state", () => {
    const overlay = createDevtoolsOverlay();

    expect(overlay.isEnabled()).toBe(false);
    expect(overlay.getPanels()).toEqual([]);

    overlay.dispose();
  });

  it("initializes with enabled state when option is set", () => {
    const overlay = createDevtoolsOverlay({ enabled: true });

    expect(overlay.isEnabled()).toBe(true);

    overlay.dispose();
  });

  it("toggle switches the enabled state", () => {
    const overlay = createDevtoolsOverlay({ enabled: false });

    expect(overlay.isEnabled()).toBe(false);

    overlay.toggle();
    expect(overlay.isEnabled()).toBe(true);

    overlay.toggle();
    expect(overlay.isEnabled()).toBe(false);

    overlay.dispose();
  });

  it("addPanel and removePanel manage panels", () => {
    const overlay = createDevtoolsOverlay();

    overlay.addPanel("Performance", () => "FPS: 60");
    overlay.addPanel("State", () => "count: 0");

    const panels = overlay.getPanels();
    expect(panels).toHaveLength(2);
    expect(panels[0].name).toBe("Performance");
    expect(panels[0].render()).toBe("FPS: 60");
    expect(panels[1].name).toBe("State");

    overlay.removePanel("Performance");

    expect(overlay.getPanels()).toHaveLength(1);
    expect(overlay.getPanels()[0].name).toBe("State");

    overlay.dispose();
  });

  it("addPanel replaces existing panel with the same name", () => {
    const overlay = createDevtoolsOverlay();

    overlay.addPanel("Info", () => "Version 1");
    overlay.addPanel("Info", () => "Version 2");

    expect(overlay.getPanels()).toHaveLength(1);
    expect(overlay.getPanels()[0].render()).toBe("Version 2");

    overlay.dispose();
  });

  it("dispose clears all panels and disables the overlay", () => {
    const overlay = createDevtoolsOverlay({ enabled: true });
    overlay.addPanel("Test", () => "data");

    expect(overlay.isEnabled()).toBe(true);
    expect(overlay.getPanels()).toHaveLength(1);

    overlay.dispose();

    expect(overlay.isEnabled()).toBe(false);
    expect(overlay.getPanels()).toHaveLength(0);
  });
});
