import { describe, expect, it } from "vitest";
import { ErrorDisplay } from "../src/components/ErrorDisplay";
import { Loading } from "../src/components/Loading";

describe("Loading component", () => {
  it("renders a default spinner with the sibu-loading class", () => {
    const el = Loading();
    expect(el).toBeInstanceOf(HTMLElement);
    expect(el.classList.contains("sibu-loading")).toBe(true);
    expect(el.querySelector(".sibu-loading-spinner")).not.toBeNull();
  });

  it("does not render text when no text prop is given", () => {
    const el = Loading();
    expect(el.querySelector(".sibu-loading-text")).toBeNull();
  });

  it("renders the provided text", () => {
    const el = Loading({ text: "Loading data..." });
    const textEl = el.querySelector(".sibu-loading-text");
    expect(textEl).not.toBeNull();
    expect(textEl!.textContent).toBe("Loading data...");
  });

  it("renders the dots variant with three dots", () => {
    const el = Loading({ variant: "dots" });
    expect(el.querySelector(".sibu-loading-dots")).not.toBeNull();
    expect(el.querySelectorAll(".sibu-loading-dot").length).toBe(3);
    // dots variant should not contain a spinner
    expect(el.querySelector(".sibu-loading-spinner")).toBeNull();
  });

  it("renders text alongside the dots variant", () => {
    const el = Loading({ variant: "dots", text: "Please wait" });
    expect(el.querySelectorAll(".sibu-loading-dot").length).toBe(3);
    expect(el.querySelector(".sibu-loading-text")!.textContent).toBe("Please wait");
  });

  it("applies the size modifier class for non-default sizes", () => {
    const lg = Loading({ size: "lg" });
    expect(lg.classList.contains("sibu-loading-lg")).toBe(true);

    const sm = Loading({ size: "sm" });
    expect(sm.classList.contains("sibu-loading-sm")).toBe(true);
  });

  it("does NOT add a size modifier class for the default md size", () => {
    const el = Loading({ size: "md" });
    expect(el.classList.contains("sibu-loading-md")).toBe(false);
    expect(el.className.trim()).toBe("sibu-loading");
  });

  it("injects the keyframe styles into document.head once", () => {
    Loading();
    Loading();
    const styleTags = Array.from(document.head.querySelectorAll("style")).filter((s) =>
      (s.textContent ?? "").includes("sibu-spin"),
    );
    // Styles are injected at most once (module-level guard).
    expect(styleTags.length).toBe(1);
  });
});

describe("ErrorDisplay component", () => {
  it("renders a panel with the sibu-error-display class", () => {
    const el = ErrorDisplay({ error: new Error("Something broke") });
    expect(el).toBeInstanceOf(HTMLElement);
    expect((el as HTMLElement).classList.contains("sibu-error-display")).toBe(true);
  });

  it("renders the error message text in the body", () => {
    const el = ErrorDisplay({ error: new Error("Network timeout") }) as HTMLElement;
    const msg = el.querySelector(".sibu-err-message");
    expect(msg).not.toBeNull();
    expect(msg!.textContent).toBe("Network timeout");
  });

  it("uses error.name (or code) as the icon/code badge", () => {
    const err = new TypeError("bad type");
    const el = ErrorDisplay({ error: err }) as HTMLElement;
    const icon = el.querySelector(".sibu-err-icon");
    expect(icon!.textContent).toBe("TypeError");
  });

  it("prefers an explicit error.code over the name", () => {
    const err = Object.assign(new Error("boom"), { code: "E_CONN" });
    const el = ErrorDisplay({ error: err }) as HTMLElement;
    expect(el.querySelector(".sibu-err-icon")!.textContent).toBe("E_CONN");
  });

  it("uses the title prop as the headline when provided", () => {
    const el = ErrorDisplay({ error: new Error("raw message"), title: "Friendly headline" }) as HTMLElement;
    const titleEl = el.querySelector(".sibu-err-title");
    expect(titleEl!.textContent).toBe("Friendly headline");
  });

  it("applies the data-severity attribute", () => {
    const el = ErrorDisplay({ error: new Error("warn"), severity: "warning" }) as HTMLElement;
    expect(el.getAttribute("data-severity")).toBe("warning");
  });

  it("defaults severity to 'error'", () => {
    const el = ErrorDisplay({ error: new Error("x") }) as HTMLElement;
    expect(el.getAttribute("data-severity")).toBe("error");
  });

  it("handles non-Error values by stringifying them", () => {
    const el = ErrorDisplay({ error: "plain string failure" }) as HTMLElement;
    expect(el.querySelector(".sibu-err-message")!.textContent).toBe("plain string failure");
    expect(el.querySelector(".sibu-err-icon")!.textContent).toBe("NON_ERROR");
  });

  it("renders a retry button only when onRetry is supplied", () => {
    const without = ErrorDisplay({ error: new Error("x") }) as HTMLElement;
    expect(without.querySelector(".sibu-err-btn-retry")).toBeNull();

    const withRetry = ErrorDisplay({ error: new Error("x"), onRetry: () => {} }) as HTMLElement;
    const retryBtn = withRetry.querySelector(".sibu-err-btn-retry");
    expect(retryBtn).not.toBeNull();
    expect(retryBtn!.textContent).toBe("Retry");
  });

  it("invokes onRetry when the retry button is clicked", () => {
    let clicked = 0;
    const el = ErrorDisplay({ error: new Error("x"), onRetry: () => (clicked += 1) }) as HTMLElement;
    (el.querySelector(".sibu-err-btn-retry") as HTMLButtonElement).click();
    expect(clicked).toBe(1);
  });

  it("uses a custom retryLabel", () => {
    const el = ErrorDisplay({ error: new Error("x"), onRetry: () => {}, retryLabel: "Try again" }) as HTMLElement;
    expect(el.querySelector(".sibu-err-btn-retry")!.textContent).toBe("Try again");
  });

  it("hides the reload button when hideReload is true", () => {
    const el = ErrorDisplay({ error: new Error("x"), hideReload: true }) as HTMLElement;
    expect(el.querySelector(".sibu-err-btn-reload")).toBeNull();
  });

  it("renders metadata when alwaysShowDetails is true", () => {
    const el = ErrorDisplay({
      error: new Error("x"),
      alwaysShowDetails: true,
      metadata: { requestId: "abc-123", retries: 2 },
    }) as HTMLElement;
    const meta = el.querySelector(".sibu-err-meta");
    expect(meta).not.toBeNull();
    expect(meta!.textContent).toContain("requestId");
    expect(meta!.textContent).toContain("abc-123");
    expect(meta!.textContent).toContain("retries");
    expect(meta!.textContent).toContain("2");
  });

  // ── Security: error text must never be parsed as HTML ────────────────────

  it("does NOT parse markup in the error message as HTML (XSS safe)", () => {
    const malicious = '<img src=x onerror="window.__xss=1"> <b>bold</b>';
    const el = ErrorDisplay({ error: new Error(malicious) }) as HTMLElement;
    const msg = el.querySelector(".sibu-err-message")!;

    // The literal markup is present as TEXT, not as parsed child elements.
    expect(msg.textContent).toBe(malicious);
    expect(msg.querySelector("img")).toBeNull();
    expect(msg.querySelector("b")).toBeNull();
    // No injected element anywhere in the panel.
    expect(el.querySelector("img")).toBeNull();
  });

  it("does NOT parse markup in a string (non-Error) value as HTML", () => {
    const payload = "<script>alert(1)</script>";
    const el = ErrorDisplay({ error: payload }) as HTMLElement;
    const msg = el.querySelector(".sibu-err-message")!;
    expect(msg.textContent).toBe(payload);
    expect(el.querySelector("script")).toBeNull();
  });

  it("does NOT parse markup in the headline/title as HTML", () => {
    const el = ErrorDisplay({ error: new Error("x"), title: "<i>oops</i>" }) as HTMLElement;
    const titleEl = el.querySelector(".sibu-err-title")!;
    expect(titleEl.textContent).toBe("<i>oops</i>");
    expect(titleEl.querySelector("i")).toBeNull();
  });
});
