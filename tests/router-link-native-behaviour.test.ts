/**
 * RouterLink click ownership.
 *
 * Invariant under test: RouterLink intercepts a click ONLY when the intended
 * browser behaviour is a same-context, same-origin navigation it can actually
 * perform. Everything else must reach the browser untouched — RouterLink does
 * not own every anchor click.
 *
 *   RouterLink  !=  ownership of every <a> click
 *
 * Regression origin: the click guard checked modifier keys, non-primary
 * buttons, `target`, `defaultPrevented` and external URLs, but not `download`.
 * A `<a href="/report.pdf" download>` was therefore preventDefault()ed and fed
 * into SPA routing: the file never downloaded, and a history entry appeared for
 * a URL that was never meant to become a view.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRouter, destroyRouter, RouterLink, setRoutes } from "../src/plugins/router";

const stub = (label: string) => () => {
  const d = document.createElement("div");
  d.textContent = label;
  return d;
};

/** A real left-click, cancelable exactly like the browser's. */
function leftClick(el: HTMLElement): MouseEvent {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  el.dispatchEvent(event);
  return event;
}

describe("RouterLink leaves native behaviour alone for downloads", () => {
  let pushSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    createRouter({ mode: "history", base: "" });
    setRoutes([
      { path: "/", component: stub("home") },
      { path: "/files/report.pdf", component: stub("pdf") },
      { path: "/internal", component: stub("internal") },
    ]);
    pushSpy = vi.spyOn(window.history, "pushState");
  });

  afterEach(() => {
    destroyRouter();
    vi.restoreAllMocks();
  });

  it("does not intercept an anchor carrying a bare download attribute", () => {
    const link = RouterLink({ to: "/files/report.pdf", download: true }, "Report");
    document.body.appendChild(link);

    const event = leftClick(link);

    expect(link.hasAttribute("download")).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(pushSpy).not.toHaveBeenCalled();
    link.remove();
  });

  it("honours download='' — presence, not truthiness", () => {
    // The empty-string form is the common one and is fully valid HTML.
    const link = RouterLink({ to: "/files/report.pdf", download: "" }, "Report");
    document.body.appendChild(link);

    expect(link.hasAttribute("download")).toBe(true);
    expect(link.getAttribute("download")).toBe("");

    const event = leftClick(link);
    expect(event.defaultPrevented).toBe(false);
    expect(pushSpy).not.toHaveBeenCalled();
    link.remove();
  });

  it("honours download='filename.pdf' and preserves the filename", () => {
    const link = RouterLink({ to: "/files/report.pdf", download: "quarterly.pdf" }, "Report");
    document.body.appendChild(link);

    expect(link.getAttribute("download")).toBe("quarterly.pdf");

    const event = leftClick(link);
    expect(event.defaultPrevented).toBe(false);
    expect(pushSpy).not.toHaveBeenCalled();
    link.remove();
  });

  it("preserves href, rel and aria attributes on a download link", () => {
    const link = RouterLink(
      { to: "/files/report.pdf", download: true, rel: "noopener", "aria-label": "Download report" },
      "Report",
    );
    expect(link.getAttribute("href")).toBe("/files/report.pdf");
    expect(link.getAttribute("rel")).toBe("noopener");
    expect(link.getAttribute("aria-label")).toBe("Download report");
  });

  it("still intercepts an ordinary internal link without download", () => {
    // The guard must be narrow: normal SPA links keep routing.
    const link = RouterLink({ to: "/internal" }, "Internal");
    document.body.appendChild(link);

    const event = leftClick(link);

    expect(link.hasAttribute("download")).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    link.remove();
  });
});

describe("RouterLink native-behaviour guard — existing cases still hold", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    createRouter({ mode: "history", base: "" });
    setRoutes([
      { path: "/", component: stub("home") },
      { path: "/internal", component: stub("internal") },
    ]);
  });

  afterEach(() => {
    destroyRouter();
    vi.restoreAllMocks();
  });

  it("ignores modified clicks", () => {
    const link = RouterLink({ to: "/internal" }, "Internal");
    document.body.appendChild(link);

    for (const modifier of ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const) {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, [modifier]: true });
      link.dispatchEvent(event);
      expect(event.defaultPrevented, `${modifier} click`).toBe(false);
    }
    link.remove();
  });

  it("ignores non-primary buttons", () => {
    const link = RouterLink({ to: "/internal" }, "Internal");
    document.body.appendChild(link);

    for (const button of [1, 2]) {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, button });
      link.dispatchEvent(event);
      expect(event.defaultPrevented, `button ${button}`).toBe(false);
    }
    link.remove();
  });

  it("ignores a click already cancelled by application code", () => {
    const link = RouterLink({ to: "/internal" }, "Internal");
    document.body.appendChild(link);
    link.addEventListener("click", (e) => e.preventDefault(), { capture: true });

    const event = leftClick(link);
    // Cancelled by the app, not adopted by the router.
    expect(event.defaultPrevented).toBe(true);
    link.remove();
  });

  it("ignores an anchor with an explicit target", () => {
    const link = RouterLink({ to: "/internal", target: "_blank" }, "Internal");
    document.body.appendChild(link);

    const event = leftClick(link);
    expect(event.defaultPrevented).toBe(false);
    link.remove();
  });

  it("ignores an external absolute URL", () => {
    const link = RouterLink({ to: "https://example.com/page" }, "External");
    document.body.appendChild(link);

    const event = leftClick(link);
    expect(event.defaultPrevented).toBe(false);
    link.remove();
  });
});
