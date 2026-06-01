import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorDisplay } from "../src/components/ErrorDisplay";

describe("ErrorDisplay coverage", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("renders headline and code, escaping via textContent (XSS-safe)", () => {
    const err = new Error("<img src=x onerror=alert(1)>");
    const el = ErrorDisplay({ error: err, alwaysShowDetails: true });

    // The dangerous markup must appear as text, never as a live element.
    expect(el.querySelector("img")).toBeNull();
    const message = el.querySelector(".sibu-err-message") as HTMLElement;
    expect(message.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(message.innerHTML).not.toContain("<img");
  });

  it("injects styles once into document head", () => {
    ErrorDisplay({ error: new Error("a") });
    const first = document.head.querySelectorAll("style").length;
    ErrorDisplay({ error: new Error("b") });
    const second = document.head.querySelectorAll("style").length;
    // Styles are injected exactly once across the page lifetime.
    expect(second).toBe(first);
  });

  it("renders the error code badge from error.code", () => {
    const err = new Error("boom") as Error & { code?: string };
    err.code = "E_CUSTOM";
    const el = ErrorDisplay({ error: err, alwaysShowDetails: true });
    const icon = el.querySelector(".sibu-err-icon") as HTMLElement;
    expect(icon.textContent).toBe("E_CUSTOM");
  });

  it("falls back to error.name for code when no code present", () => {
    const err = new TypeError("type boom");
    const el = ErrorDisplay({ error: err });
    const icon = el.querySelector(".sibu-err-icon") as HTMLElement;
    expect(icon.textContent).toBe("TypeError");
  });

  it("handles non-Error string values", () => {
    const el = ErrorDisplay({ error: "plain string failure", alwaysShowDetails: true });
    const icon = el.querySelector(".sibu-err-icon") as HTMLElement;
    expect(icon.textContent).toBe("NON_ERROR");
    const message = el.querySelector(".sibu-err-message") as HTMLElement;
    expect(message.textContent).toBe("plain string failure");
  });

  it("handles non-Error non-string values via JSON.stringify", () => {
    const el = ErrorDisplay({ error: { foo: "bar" }, alwaysShowDetails: true });
    const message = el.querySelector(".sibu-err-message") as HTMLElement;
    expect(message.textContent).toContain("foo");
    expect(message.textContent).toContain("bar");
  });

  it("uses 'Unknown error' for an Error with empty message", () => {
    const el = ErrorDisplay({ error: new Error(""), alwaysShowDetails: true });
    const message = el.querySelector(".sibu-err-message") as HTMLElement;
    expect(message.textContent).toBe("Unknown error");
  });

  it("respects a title override for the headline", () => {
    const el = ErrorDisplay({ error: new Error("real message"), title: "Friendly Title" });
    const titleEl = el.querySelector(".sibu-err-title") as HTMLElement;
    expect(titleEl.textContent).toBe("Friendly Title");
  });

  it("renders warning and info severities via data-severity", () => {
    const warn = ErrorDisplay({ error: new Error("w"), severity: "warning" });
    expect(warn.getAttribute("data-severity")).toBe("warning");
    const info = ErrorDisplay({ error: new Error("i"), severity: "info" });
    expect(info.getAttribute("data-severity")).toBe("info");
    const def = ErrorDisplay({ error: new Error("d") });
    expect(def.getAttribute("data-severity")).toBe("error");
  });

  it("renders parsed stack frames when details shown", () => {
    const err = new Error("with stack");
    err.stack = [
      "Error: with stack",
      "    at myFunc (file.js:10:5)",
      "    at file.js:20:3",
      "anonFn@http://x/app.js:5:1",
    ].join("\n");
    const el = ErrorDisplay({ error: err, alwaysShowDetails: true });
    const frames = el.querySelectorAll(".sibu-err-frame");
    expect(frames.length).toBeGreaterThan(0);
    const fns = Array.from(el.querySelectorAll(".sibu-err-fn")).map((f) => f.textContent);
    expect(fns).toContain("myFunc");
    // Bare "at file.js:20:3" -> anonymous function label
    expect(fns).toContain("(anonymous)");
    // Firefox-style frame parsed
    expect(fns).toContain("anonFn");
  });

  it("walks and renders the error cause chain", () => {
    const root = new Error("root cause");
    root.stack = "Error: root cause\n    at deep (deep.js:1:1)";
    const middle = new Error("middle", { cause: root });
    const top = new Error("top", { cause: middle }) as Error;
    top.stack = "Error: top\n    at top (top.js:1:1)";

    const el = ErrorDisplay({ error: top, alwaysShowDetails: true });
    const causeLabels = el.querySelectorAll(".sibu-err-cause-label");
    // Two nested causes -> two "Caused by" labels.
    expect(causeLabels.length).toBe(2);
    expect(el.textContent).toContain("middle");
    expect(el.textContent).toContain("root cause");
  });

  it("renders '(no stack)' for a cause without a stack", () => {
    const causeNoStack = new Error("stackless cause");
    causeNoStack.stack = "";
    const top = new Error("top", { cause: causeNoStack });
    const el = ErrorDisplay({ error: top, alwaysShowDetails: true });
    expect(el.textContent).toContain("(no stack)");
  });

  it("renders metadata key/value pairs with null handling", () => {
    const el = ErrorDisplay({
      error: new Error("meta"),
      alwaysShowDetails: true,
      metadata: { requestId: "abc123", attempt: 2, ok: true, missing: null },
    });
    const dl = el.querySelector(".sibu-err-meta") as HTMLElement;
    expect(dl).not.toBeNull();
    const dts = Array.from(dl.querySelectorAll("dt")).map((d) => d.textContent);
    const dds = Array.from(dl.querySelectorAll("dd")).map((d) => d.textContent);
    expect(dts).toEqual(["requestId", "attempt", "ok", "missing"]);
    expect(dds).toEqual(["abc123", "2", "true", "(null)"]);
  });

  it("hides stack and metadata in production gating (alwaysShowDetails false)", () => {
    const err = new Error("prod error");
    err.stack = "Error: prod error\n    at fn (a.js:1:1)";
    const el = ErrorDisplay({
      error: err,
      alwaysShowDetails: false,
      metadata: { secret: "hidden" },
    });
    // Headline message still shown.
    const message = el.querySelector(".sibu-err-message") as HTMLElement;
    expect(message.textContent).toBe("prod error");
    // But no stack frames or metadata leaked.
    expect(el.querySelector(".sibu-err-frame")).toBeNull();
    expect(el.querySelector(".sibu-err-meta")).toBeNull();
    expect(el.textContent).not.toContain("hidden");
  });

  it("renders a retry button that invokes onRetry", () => {
    const onRetry = vi.fn();
    const el = ErrorDisplay({ error: new Error("x"), onRetry, retryLabel: "Try Again" });
    const retryBtn = el.querySelector(".sibu-err-btn-retry") as HTMLButtonElement;
    expect(retryBtn).not.toBeNull();
    expect(retryBtn.textContent).toBe("Try Again");
    retryBtn.click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("uses default 'Retry' label and renders reload button", () => {
    const onRetry = vi.fn();
    const el = ErrorDisplay({ error: new Error("x"), onRetry });
    const retryBtn = el.querySelector(".sibu-err-btn-retry") as HTMLButtonElement;
    expect(retryBtn.textContent).toBe("Retry");
    const reloadBtn = el.querySelector(".sibu-err-btn-reload") as HTMLButtonElement;
    expect(reloadBtn).not.toBeNull();
  });

  it("hides the reload button when hideReload is true", () => {
    const el = ErrorDisplay({ error: new Error("x"), hideReload: true });
    expect(el.querySelector(".sibu-err-btn-reload")).toBeNull();
    // With no retry and no reload, the actions row is absent.
    expect(el.querySelector(".sibu-err-actions")).toBeNull();
  });

  it("copies full error text to clipboard and toggles label", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    const err = new Error("copyable") as Error & { code?: string };
    err.code = "E_COPY";
    err.stack = "Error: copyable\n    at f (f.js:1:1)";
    const root = new Error("root", { cause: err });
    const el = ErrorDisplay({
      error: root,
      alwaysShowDetails: true,
      metadata: { id: "42" },
    });
    const copyBtn = el.querySelector(".sibu-err-copy-btn") as HTMLButtonElement;
    expect(copyBtn.textContent).toBe("Copy");

    copyBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledTimes(1);
    const text = writeText.mock.calls[0][0] as string;
    expect(text).toContain("Caused by:");
    expect(text).toContain("[E_COPY] copyable");
    expect(text).toContain("Metadata:");
    expect(text).toContain("id: 42");
    expect(text).toContain("Environment:");
    expect(text).toContain("Timestamp:");

    expect(copyBtn.textContent).toBe("Copied!");
    vi.advanceTimersByTime(1500);
    expect(copyBtn.textContent).toBe("Copy");
  });

  it("shows 'Copy failed' when clipboard write rejects", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    const el = ErrorDisplay({ error: new Error("nope") });
    const copyBtn = el.querySelector(".sibu-err-copy-btn") as HTMLButtonElement;
    copyBtn.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(copyBtn.textContent).toBe("Copy failed");
    vi.advanceTimersByTime(1500);
    expect(copyBtn.textContent).toBe("Copy");
  });
});
