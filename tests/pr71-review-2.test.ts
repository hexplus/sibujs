import { afterEach, describe, expect, it, vi } from "vitest";
import { componentAdapter } from "../src/ecosystem/ui/componentAdapter";
import { checkKeyboardAccess } from "../src/testing/a11y";
import { enableListenerTracking, listenerTypes } from "../src/testing/listenerTracking";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

// ---------------------------------------------------------------------------
// Listener tracking follows DOM listener identity.
// ---------------------------------------------------------------------------
describe("listener tracking identity", () => {
  enableListenerTracking();
  const flagged = (el: Element) => checkKeyboardAccess(el).some((v) => v.level === "error");
  const click = (el: Element) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));

  it("capture is part of the identity", () => {
    const el = document.createElement("div");
    const fn = vi.fn();
    el.addEventListener("click", fn, true);
    el.addEventListener("click", fn, false);
    el.removeEventListener("click", fn, true);

    click(el);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(listenerTypes(el).has("click")).toBe(true);
    expect(flagged(el)).toBe(true);

    el.removeEventListener("click", fn, { capture: false });
    expect(listenerTypes(el).has("click")).toBe(false);
    expect(flagged(el)).toBe(false);
  });

  it("removing with the other capture flag removes nothing", () => {
    const el = document.createElement("div");
    const fn = () => {};
    el.addEventListener("click", fn, { capture: true });
    el.removeEventListener("click", fn);
    expect(listenerTypes(el).has("click")).toBe(true);
  });

  it("duplicate registrations are one listener", () => {
    const el = document.createElement("div");
    const fn = vi.fn();
    el.addEventListener("click", fn);
    el.addEventListener("click", fn);
    el.removeEventListener("click", fn);
    click(el);
    expect(fn).not.toHaveBeenCalled();
    expect(listenerTypes(el).has("click")).toBe(false);
  });

  it("a once listener is forgotten after it fires", () => {
    const el = document.createElement("div");
    const fn = vi.fn();
    el.addEventListener("click", fn, { once: true });
    expect(flagged(el)).toBe(true);

    click(el);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(listenerTypes(el).has("click")).toBe(false);
    expect(flagged(el)).toBe(false);
  });

  it("a once listener removed early, then re-added permanently, stays tracked after dispatch", () => {
    const el = document.createElement("div");
    const fn = vi.fn();
    el.addEventListener("click", fn, { once: true });
    el.removeEventListener("click", fn);
    el.addEventListener("click", fn);

    click(el);
    click(el);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(listenerTypes(el).has("click")).toBe(true);
  });

  it("aborting the signal forgets the listener; a pre-aborted signal never registers", () => {
    const el = document.createElement("div");
    const controller = new AbortController();
    el.addEventListener("click", () => {}, { signal: controller.signal });
    expect(flagged(el)).toBe(true);
    controller.abort();
    expect(listenerTypes(el).has("click")).toBe(false);
    expect(flagged(el)).toBe(false);

    const aborted = new AbortController();
    aborted.abort();
    el.addEventListener("pointerdown", () => {}, { signal: aborted.signal });
    expect(listenerTypes(el).has("pointerdown")).toBe(false);
  });

  it("listener objects are tracked by identity", () => {
    const el = document.createElement("div");
    el.setAttribute("role", "button");
    el.setAttribute("tabindex", "0");
    const handler = { handleEvent: vi.fn() };
    el.addEventListener("keydown", handler);
    el.addEventListener("click", handler);
    expect(flagged(el)).toBe(false);

    el.removeEventListener("keydown", handler);
    expect(flagged(el)).toBe(true);
    el.removeEventListener("click", { handleEvent: handler.handleEvent });
    expect(listenerTypes(el).has("click")).toBe(true);
    el.removeEventListener("click", handler);
    expect(listenerTypes(el).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Overlapping applyTo() handles released in any order.
// ---------------------------------------------------------------------------
describe("theme.applyTo() layers", () => {
  const config = { name: "t", prefix: "t", components: {} };
  const themed = (value: string) => {
    const { theme } = componentAdapter(config);
    theme.setTheme({ variables: { "--accent": value } });
    return theme;
  };
  const accent = (el: HTMLElement) => el.style.getPropertyValue("--accent");

  it("first-in-first-out release keeps the live handle's value, then restores the original", () => {
    const root = document.createElement("div");
    root.style.setProperty("--accent", "original");
    const releaseA = themed("first").applyTo(root);
    const releaseB = themed("second").applyTo(root);

    releaseA();
    expect(accent(root)).toBe("second");
    releaseB();
    expect(accent(root)).toBe("original");
  });

  it("releasing the middle of three handles changes nothing visible", () => {
    const root = document.createElement("div");
    const releaseA = themed("a").applyTo(root);
    const releaseB = themed("b").applyTo(root);
    const releaseC = themed("c").applyTo(root);

    releaseB();
    expect(accent(root)).toBe("c");
    releaseC();
    expect(accent(root)).toBe("a");
    releaseA();
    expect(accent(root)).toBe("");
  });

  it("an update to a lower layer does not override the top layer", () => {
    const root = document.createElement("div");
    const lower = themed("low");
    const releaseLower = lower.applyTo(root);
    const releaseUpper = themed("up").applyTo(root);

    lower.setTheme({ variables: { "--accent": "low-2" } });
    expect(accent(root)).toBe("up");
    releaseUpper();
    expect(accent(root)).toBe("low-2");
    releaseLower();
    expect(accent(root)).toBe("");
  });

  it("dropping a variable from the top layer reveals the layer below", () => {
    const root = document.createElement("div");
    const releaseLower = themed("low").applyTo(root);
    const upper = themed("up");
    const releaseUpper = upper.applyTo(root);

    upper.setTheme({ variables: {} });
    expect(accent(root)).toBe("low");
    releaseUpper();
    releaseLower();
    expect(accent(root)).toBe("");
  });
});
