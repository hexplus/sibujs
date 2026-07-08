import { describe, expect, it, vi } from "vitest";
import { createErrorReporter, formatError, SibuError, withErrorTracking } from "../src/devtools/sourceMaps";

describe("SibuError", () => {
  it("should extend Error", () => {
    const err = new SibuError("test error");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SibuError);
  });

  it("should have name set to 'SibuError'", () => {
    const err = new SibuError("test error");
    expect(err.name).toBe("SibuError");
  });

  it("should store component name", () => {
    const err = new SibuError("render failed", { component: "UserCard" });
    expect(err.component).toBe("UserCard");
  });

  it("should store props", () => {
    const err = new SibuError("render failed", {
      component: "UserCard",
      props: { userId: 42, name: "Alice" },
    });
    expect(err.props).toEqual({ userId: 42, name: "Alice" });
  });

  it("should forward the cause", () => {
    const original = new Error("original");
    const err = new SibuError("wrapped", { cause: original });
    expect(err.cause).toBe(original);
  });

  it("should work with no options", () => {
    const err = new SibuError("plain");
    expect(err.message).toBe("plain");
    expect(err.component).toBeUndefined();
    expect(err.props).toBeUndefined();
  });
});

describe("createErrorReporter", () => {
  it("should report an error and retrieve it via getErrors", () => {
    const reporter = createErrorReporter({ logToConsole: false });
    const err = new Error("something broke");

    reporter.report(err, { component: "Widget" });

    const errors = reporter.getErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(SibuError);
    expect(errors[0].message).toBe("something broke");
    expect(errors[0].component).toBe("Widget");
  });

  it("should return copies from getErrors (not the internal array)", () => {
    const reporter = createErrorReporter({ logToConsole: false });
    reporter.report(new Error("a"));

    const first = reporter.getErrors();
    const second = reporter.getErrors();

    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });

  it("should group errors by component via getErrorsByComponent", () => {
    const reporter = createErrorReporter({ logToConsole: false });

    reporter.report(new Error("e1"), { component: "Header" });
    reporter.report(new Error("e2"), { component: "Footer" });
    reporter.report(new Error("e3"), { component: "Header" });

    const grouped = reporter.getErrorsByComponent();

    expect(grouped.get("Header")).toHaveLength(2);
    expect(grouped.get("Footer")).toHaveLength(1);
  });

  it("should group errors without a component under '<unknown>'", () => {
    const reporter = createErrorReporter({ logToConsole: false });
    reporter.report(new Error("mystery"));

    const grouped = reporter.getErrorsByComponent();
    expect(grouped.get("<unknown>")).toHaveLength(1);
  });

  it("should clear all errors", () => {
    const reporter = createErrorReporter({ logToConsole: false });
    reporter.report(new Error("e1"));
    reporter.report(new Error("e2"));

    expect(reporter.getErrors()).toHaveLength(2);

    reporter.clear();

    expect(reporter.getErrors()).toHaveLength(0);
  });

  it("should call the onError handler", () => {
    const onError = vi.fn();
    const reporter = createErrorReporter({ logToConsole: false, onError });

    reporter.report(new Error("oops"), { component: "Test" });

    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toBeInstanceOf(SibuError);
  });

  it("should respect maxErrors cap", () => {
    const reporter = createErrorReporter({ logToConsole: false, maxErrors: 3 });

    reporter.report(new Error("e1"));
    reporter.report(new Error("e2"));
    reporter.report(new Error("e3"));
    reporter.report(new Error("e4"));

    const errors = reporter.getErrors();
    expect(errors).toHaveLength(3);
    // Oldest error should have been trimmed
    expect(errors[0].message).toBe("e2");
  });

  it("should preserve SibuError instances without re-wrapping", () => {
    const reporter = createErrorReporter({ logToConsole: false });
    const original = new SibuError("already sibu", { component: "Direct" });

    reporter.report(original);

    const errors = reporter.getErrors();
    expect(errors[0]).toBe(original);
    expect(errors[0].component).toBe("Direct");
  });

  it("should merge context into a SibuError if component is not set", () => {
    const reporter = createErrorReporter({ logToConsole: false });
    const err = new SibuError("no comp");

    reporter.report(err, { component: "Merged" });

    expect(reporter.getErrors()[0].component).toBe("Merged");
  });
});

describe("withErrorTracking", () => {
  it("should return the component element when no error occurs", () => {
    const reporter = createErrorReporter({ logToConsole: false });
    const component = () => {
      const el = document.createElement("div");
      el.textContent = "Hello";
      return el;
    };

    const safe = withErrorTracking("MyComp", component, reporter);
    const el = safe();

    expect(el.tagName).toBe("DIV");
    expect(el.textContent).toBe("Hello");
    expect(reporter.getErrors()).toHaveLength(0);
  });

  it("should catch errors and return a fallback element", () => {
    const reporter = createErrorReporter({ logToConsole: false });
    const component = () => {
      throw new Error("render boom");
    };

    const safe = withErrorTracking("Broken", component, reporter);
    const el = safe();

    expect(el.tagName).toBe("DIV");
    expect(el.getAttribute("data-sibu-error")).toBe("Broken");
    expect(el.textContent).toContain("Broken");
    expect(el.textContent).toContain("render boom");
  });

  it("should report the caught error to the reporter", () => {
    const reporter = createErrorReporter({ logToConsole: false });
    const component = () => {
      throw new Error("tracked error");
    };

    const safe = withErrorTracking("Tracked", component, reporter);
    safe();

    const errors = reporter.getErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0].component).toBe("Tracked");
    expect(errors[0].message).toBe("tracked error");
  });

  it("should handle non-Error throws", () => {
    const reporter = createErrorReporter({ logToConsole: false });
    const component = () => {
      throw "string error";
    };

    const safe = withErrorTracking("StringThrow", component, reporter);
    const el = safe();

    expect(el.getAttribute("data-sibu-error")).toBe("StringThrow");
    expect(reporter.getErrors()).toHaveLength(1);
  });

  it("should create a default reporter when none is provided", () => {
    // Suppress console.error for this test
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const component = () => {
      throw new Error("default reporter");
    };

    const safe = withErrorTracking("DefaultRep", component);
    const el = safe();

    expect(el.getAttribute("data-sibu-error")).toBe("DefaultRep");

    spy.mockRestore();
  });
});

describe("formatError", () => {
  it("should format an error with component context", () => {
    const err = new Error("failed");
    const formatted = formatError(err, { component: "App" });

    expect(formatted).toContain("[SibuJS:App]");
    expect(formatted).toContain("failed");
  });

  it("should format without component context", () => {
    const err = new Error("no context");
    const formatted = formatError(err);

    expect(formatted).toContain("[SibuJS]");
    expect(formatted).toContain("no context");
  });

  it("should include component label from SibuError", () => {
    const err = new SibuError("sibu fail", { component: "Card" });
    const formatted = formatError(err);

    expect(formatted).toContain("[SibuJS:Card]");
    expect(formatted).toContain("--- in <Card> ---");
  });

  it("should include props when present on SibuError", () => {
    const err = new SibuError("with props", {
      component: "Item",
      props: { id: 1, name: "test" },
    });
    const formatted = formatError(err);

    expect(formatted).toContain("Props:");
    expect(formatted).toContain('"id":1');
    expect(formatted).toContain('"name":"test"');
  });

  it("should handle cause chain", () => {
    const root = new Error("root cause");
    const wrapper = new SibuError("wrapper", {
      component: "Outer",
      cause: root,
    });
    const formatted = formatError(wrapper);

    expect(formatted).toContain("Caused by:");
    expect(formatted).toContain("root cause");
  });

  it("should handle unserializable props gracefully", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const err = new SibuError("circular", {
      component: "Circ",
      props: circular,
    });
    const formatted = formatError(err);

    expect(formatted).toContain("[unserializable]");
  });
});
