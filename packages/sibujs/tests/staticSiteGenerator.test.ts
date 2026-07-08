import { describe, expect, it, vi } from "vitest";
import { generateStaticSite } from "../src/platform/staticSiteGenerator";

describe("staticSiteGenerator", () => {
  it("renders all routes and returns pages", async () => {
    const renderFn = vi.fn().mockImplementation(async (path: string) => {
      return `<html><body>${path}</body></html>`;
    });

    const result = await generateStaticSite({
      routes: ["/", "/about", "/contact"],
      renderFn,
    });

    expect(result.pages).toHaveLength(3);
    expect(result.errors).toHaveLength(0);
    expect(result.pages[0]).toEqual({ path: "/", html: "<html><body>/</body></html>" });
    expect(result.pages[1]).toEqual({ path: "/about", html: "<html><body>/about</body></html>" });
    expect(renderFn).toHaveBeenCalledTimes(3);
  });

  it("collects errors for routes that fail to render", async () => {
    const renderFn = vi.fn().mockImplementation(async (path: string) => {
      if (path === "/broken") {
        throw new Error("Render failed");
      }
      return `<html>${path}</html>`;
    });

    const result = await generateStaticSite({
      routes: ["/", "/broken", "/ok"],
      renderFn,
    });

    expect(result.pages).toHaveLength(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].path).toBe("/broken");
    expect(result.errors[0].error.message).toBe("Render failed");
  });

  it("handles empty routes array", async () => {
    const renderFn = vi.fn();

    const result = await generateStaticSite({
      routes: [],
      renderFn,
    });

    expect(result.pages).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(renderFn).not.toHaveBeenCalled();
  });

  it("wraps non-Error throws into Error objects", async () => {
    const renderFn = vi.fn().mockImplementation(async () => {
      throw "string error";
    });

    const result = await generateStaticSite({
      routes: ["/fail"],
      renderFn,
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toBeInstanceOf(Error);
    expect(result.errors[0].error.message).toBe("string error");
  });

  it("calls renderFn with the correct path for each route", async () => {
    const renderFn = vi.fn().mockResolvedValue("<html></html>");

    await generateStaticSite({
      routes: ["/users", "/users/123", "/api/data"],
      renderFn,
    });

    expect(renderFn).toHaveBeenCalledWith("/users");
    expect(renderFn).toHaveBeenCalledWith("/users/123");
    expect(renderFn).toHaveBeenCalledWith("/api/data");
  });
});
