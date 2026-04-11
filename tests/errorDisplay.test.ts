import { describe, expect, it } from "vitest";
import { ErrorDisplay } from "../src/components/ErrorDisplay";

describe("ErrorDisplay", () => {
  it("renders a message and a code badge", () => {
    const err = new TypeError("bad thing");
    const el = ErrorDisplay({ error: err }) as HTMLElement;
    expect(el.querySelector(".sibu-err-title")?.textContent).toContain("bad thing");
    expect(el.querySelector(".sibu-err-icon")?.textContent).toBe("TypeError");
  });

  it("uses custom severity class", () => {
    const el = ErrorDisplay({ error: new Error("w"), severity: "warning" }) as HTMLElement;
    expect(el.getAttribute("data-severity")).toBe("warning");
  });

  it("reads `error.code` when present", () => {
    class CodedError extends Error {
      code = "E42";
    }
    const el = ErrorDisplay({ error: new CodedError("broken") }) as HTMLElement;
    expect(el.querySelector(".sibu-err-icon")?.textContent).toBe("E42");
  });

  it("walks the `Error.cause` chain in dev builds", () => {
    const root = new Error("root cause");
    const wrap = new Error("outer", { cause: root });
    const el = ErrorDisplay({ error: wrap, alwaysShowDetails: true }) as HTMLElement;
    expect(el.textContent).toContain("outer");
    expect(el.textContent).toContain("root cause");
  });

  it("renders the retry button when onRetry is supplied", () => {
    let retried = false;
    const el = ErrorDisplay({
      error: new Error("x"),
      onRetry: () => {
        retried = true;
      },
    }) as HTMLElement;
    const btn = el.querySelector(".sibu-err-btn-retry") as HTMLButtonElement;
    expect(btn).not.toBeNull();
    btn.click();
    expect(retried).toBe(true);
  });

  it("renders a metadata section when alwaysShowDetails is true", () => {
    const el = ErrorDisplay({
      error: new Error("x"),
      alwaysShowDetails: true,
      metadata: { userId: "42", requestId: "abc-123" },
    }) as HTMLElement;
    expect(el.textContent).toContain("userId");
    expect(el.textContent).toContain("abc-123");
  });

  it("accepts non-Error values", () => {
    const el = ErrorDisplay({ error: "just a string" }) as HTMLElement;
    expect(el.textContent).toContain("just a string");
  });
});
