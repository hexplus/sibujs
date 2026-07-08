import { beforeEach, describe, expect, it } from "vitest";
import { persisted } from "../src/patterns/persist";

describe("persisted", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("should use initial value when no persisted data", () => {
    const [value] = persisted("test-key", "default");
    expect(value()).toBe("default");
  });

  it("should persist value to localStorage on change", () => {
    const [, setValue] = persisted("counter", 0);
    setValue(42);
    expect(JSON.parse(localStorage.getItem("counter") ?? "null")).toBe(42);
  });

  it("should restore persisted value on init", () => {
    localStorage.setItem("name", JSON.stringify("Alice"));
    const [value] = persisted("name", "default");
    expect(value()).toBe("Alice");
  });

  it("should use sessionStorage when session option is true", () => {
    const [, setValue] = persisted("session-key", "a", { session: true });
    setValue("b");
    expect(JSON.parse(sessionStorage.getItem("session-key") ?? "null")).toBe("b");
    expect(localStorage.getItem("session-key")).toBeNull();
  });

  it("should sync across tabs via storage event", () => {
    const [value] = persisted("shared", "initial");
    expect(value()).toBe("initial");
    // Simulate another tab writing to localStorage
    const event = new StorageEvent("storage", {
      key: "shared",
      newValue: JSON.stringify("from-other-tab"),
      oldValue: JSON.stringify("initial"),
      storageArea: localStorage,
    });
    window.dispatchEvent(event);
    expect(value()).toBe("from-other-tab");
  });

  it("should revert to initial when another tab clears the key", () => {
    const [value, setValue] = persisted("cleared", "initial");
    setValue("modified");
    expect(value()).toBe("modified");
    const event = new StorageEvent("storage", {
      key: "cleared",
      newValue: null,
      oldValue: JSON.stringify("modified"),
      storageArea: localStorage,
    });
    window.dispatchEvent(event);
    expect(value()).toBe("initial");
  });

  it("should not sync cross-tab when syncTabs is false", () => {
    const [value] = persisted("no-sync", "initial", { syncTabs: false });
    const event = new StorageEvent("storage", {
      key: "no-sync",
      newValue: JSON.stringify("other-tab"),
      storageArea: localStorage,
    });
    window.dispatchEvent(event);
    expect(value()).toBe("initial");
  });
});
