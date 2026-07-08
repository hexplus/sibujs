import { describe, expect, it } from "vitest";
import { Loading } from "../src/components/Loading";

describe("Loading", () => {
  it("should render spinner variant by default", () => {
    const el = Loading();
    expect(el.querySelector(".sibu-loading-spinner")).not.toBeNull();
  });

  it("should render dots variant", () => {
    const el = Loading({ variant: "dots" });
    expect(el.querySelector(".sibu-loading-dots")).not.toBeNull();
    expect(el.querySelectorAll(".sibu-loading-dot").length).toBe(3);
  });

  it("should show text when provided", () => {
    const el = Loading({ text: "Please wait..." });
    expect(el.textContent).toContain("Please wait...");
  });

  it("should apply size class", () => {
    const el = Loading({ size: "lg" });
    expect(el.classList.contains("sibu-loading-lg")).toBe(true);
  });
});
