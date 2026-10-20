/**
 * `embed()` — the one runtime door to a third-party `<iframe>` (sibujs/ui).
 *
 * The tag factories, `svgElement()` and `DOMPool` refuse `iframe` because a
 * runtime-chosen frame is a foreign document waiting for a URL. `embed()` opens
 * exactly one narrow, opt-in path for players (YouTube, Vimeo):
 *
 *   - `src` must be absolute `https:` and match an origin (plus optional path
 *     prefix) the application allowlisted with `setEmbedPolicy()`; anything
 *     else — a getter's value included — is omitted with a dev warning;
 *   - `title` is required; `srcdoc` never written;
 *   - safe defaults: `loading="lazy"`, `referrerpolicy`
 *     `strict-origin-when-cross-origin`, a restrictive `sandbox` that callers
 *     may only narrow, and a permissions list limited to player features;
 *   - SSR serializes it under the same policy.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { when } from "../src/core/rendering/directives";
import { button, div, img } from "../src/core/rendering/html";
import { tagFactory } from "../src/core/rendering/tagFactory";
import { signal } from "../src/core/signals/signal";
import { DOMPool } from "../src/performance/domRecycler";
import { svgElement } from "../src/platform/customElement";
import { renderToString } from "../src/platform/ssr";
import { DEFAULT_EMBED_SANDBOX, embed, setEmbedPolicy } from "../src/ui/embed";

const YT = "https://www.youtube-nocookie.com";

afterEach(() => {
  setEmbedPolicy({ allowedOrigins: [] });
  vi.restoreAllMocks();
});

function sandboxTokens(el: Element): string[] {
  return (el.getAttribute("sandbox") ?? "").split(/\s+/).filter(Boolean).sort();
}

describe("plain iframe stays refused", () => {
  it("is refused by the tag factories, svgElement() and DOMPool", () => {
    expect(() => tagFactory("iframe")()).toThrow(/blocked/);
    expect(() => svgElement("iframe")).toThrow(/blocked/);
    expect(() => new DOMPool().acquire("iframe")).toThrow(/blocked/);
  });
});

describe("embed()", () => {
  it("builds a player frame with safe defaults", () => {
    setEmbedPolicy({ allowedOrigins: [`${YT}/embed/`] });
    const el = embed({
      src: `${YT}/embed/abc123`,
      title: "Product tour",
      allow: "accelerometer; encrypted-media; picture-in-picture",
      aspectRatio: "16 / 9",
    });
    expect(el.localName).toBe("iframe");
    expect(el.getAttribute("src")).toBe(`${YT}/embed/abc123`);
    expect(el.getAttribute("title")).toBe("Product tour");
    expect(el.getAttribute("loading")).toBe("lazy");
    expect(el.getAttribute("referrerpolicy")).toBe("strict-origin-when-cross-origin");
    expect(sandboxTokens(el)).toEqual([...DEFAULT_EMBED_SANDBOX].sort());
    expect(el.getAttribute("allow")).toBe("accelerometer; encrypted-media; picture-in-picture");
    expect(el.style.getPropertyValue("aspect-ratio")).toBe("16 / 9");
    expect(el.hasAttribute("srcdoc")).toBe(false);
  });

  it("writes the sandbox before the src", () => {
    // Sandbox flags are read when the frame navigates; a sandbox written after
    // `src` would not apply to the first document. Attribute order in
    // `el.attributes` is insertion order.
    setEmbedPolicy({ allowedOrigins: [YT] });
    const el = embed({ src: `${YT}/embed/x`, title: "t" });
    const names = Array.from(el.attributes).map((a) => a.name);
    expect(names.indexOf("sandbox")).toBeGreaterThanOrEqual(0);
    expect(names.indexOf("sandbox")).toBeLessThan(names.indexOf("src"));
  });

  it("omits a src outside the allowlist and warns", () => {
    setEmbedPolicy({ allowedOrigins: [`${YT}/embed/`] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const src of [
      "https://evil.example/embed/x",
      `${YT}/watch?v=x`,
      `${YT}/embed/../watch`,
      "http://www.youtube-nocookie.com/embed/x",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "blob:https://www.youtube-nocookie.com/123",
      "/embed/relative",
      "https://user:pw@www.youtube-nocookie.com/embed/x",
      "https://www.youtube-nocookie.com.evil.example/embed/x",
    ]) {
      const el = embed({ src, title: "t" });
      expect(el.hasAttribute("src"), src).toBe(false);
    }
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toMatch(/embed/);
  });

  it("refuses everything until a policy allows an origin", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(embed({ src: `${YT}/embed/x`, title: "t" }).hasAttribute("src")).toBe(false);
  });

  it("re-checks a getter src on every change", () => {
    setEmbedPolicy({ allowedOrigins: [`${YT}/embed/`, "https://player.vimeo.com/video/"] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const [src, setSrc] = signal<string | null>(`${YT}/embed/a`);
    const el = embed({ src, title: "t" });
    expect(el.getAttribute("src")).toBe(`${YT}/embed/a`);
    setSrc("https://player.vimeo.com/video/42");
    expect(el.getAttribute("src")).toBe("https://player.vimeo.com/video/42");
    setSrc("javascript:alert(1)");
    expect(el.hasAttribute("src")).toBe(false);
    setSrc(null);
    expect(el.hasAttribute("src")).toBe(false);
    setSrc(`${YT}/embed/b`);
    expect(el.getAttribute("src")).toBe(`${YT}/embed/b`);
  });

  it("requires a title", () => {
    setEmbedPolicy({ allowedOrigins: [YT] });
    // @ts-expect-error — title is required
    expect(() => embed({ src: `${YT}/embed/x` })).toThrow(/title/);
    expect(() => embed({ src: `${YT}/embed/x`, title: "  " })).toThrow(/title/);
  });

  it("never writes srcdoc", () => {
    setEmbedPolicy({ allowedOrigins: [YT] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const el = embed({ src: `${YT}/embed/x`, title: "t", srcdoc: "<script>alert(1)</script>" } as never);
    expect(el.hasAttribute("srcdoc")).toBe(false);
  });

  it("lets sandbox, referrerpolicy and allow only narrow", () => {
    setEmbedPolicy({ allowedOrigins: [YT] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const narrowed = embed({
      src: `${YT}/embed/x`,
      title: "t",
      sandbox: "allow-scripts allow-same-origin allow-top-navigation allow-forms",
      referrerpolicy: "no-referrer",
      allow: "fullscreen; camera; microphone *; geolocation",
    });
    expect(sandboxTokens(narrowed)).toEqual(["allow-same-origin", "allow-scripts"]);
    expect(narrowed.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(narrowed.getAttribute("allow")).toBe("fullscreen");
    expect(warn).toHaveBeenCalled();

    const strictest = embed({ src: `${YT}/embed/x`, title: "t", sandbox: "" });
    expect(strictest.getAttribute("sandbox")).toBe("");

    const widened = embed({ src: `${YT}/embed/x`, title: "t", referrerpolicy: "unsafe-url" as never });
    expect(widened.getAttribute("referrerpolicy")).toBe("strict-origin-when-cross-origin");
  });

  it("ignores an aspect ratio that is not a ratio", () => {
    setEmbedPolicy({ allowedOrigins: [YT] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const el = embed({ src: `${YT}/embed/x`, title: "t", aspectRatio: "1; background: url(x)" });
    expect(el.getAttribute("style") ?? "").not.toContain("url(");
  });

  it("rejects a non-https or malformed policy entry", () => {
    expect(() => setEmbedPolicy({ allowedOrigins: ["http://www.youtube.com"] })).toThrow(/https/);
    expect(() => setEmbedPolicy({ allowedOrigins: ["youtube.com"] })).toThrow();
    expect(() => setEmbedPolicy({ allowedOrigins: ["https://x.example/embed?x=1"] })).toThrow();
  });

  it("refuses a src on the page's own origin (the sandbox could be lifted)", () => {
    // jsdom serves the page from http://localhost; stand in an https page.
    vi.stubGlobal("location", { origin: "https://site.example" });
    try {
      setEmbedPolicy({ allowedOrigins: ["https://site.example"] });
      vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(embed({ src: "https://site.example/x", title: "t" }).hasAttribute("src")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("embed() under SSR", () => {
  it("serializes the frame with its policy attributes", () => {
    setEmbedPolicy({ allowedOrigins: [`${YT}/embed/`] });
    const out = renderToString(div([embed({ src: `${YT}/embed/abc`, title: "Tour", aspectRatio: "16 / 9" })]));
    const doc = new DOMParser().parseFromString(`<body>${out}`, "text/html");
    const frame = doc.querySelector("iframe") as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe(`${YT}/embed/abc`);
    expect(frame.getAttribute("title")).toBe("Tour");
    expect(sandboxTokens(frame)).toEqual([...DEFAULT_EMBED_SANDBOX].sort());
    expect(frame.getAttribute("loading")).toBe("lazy");
  });

  it("re-applies the policy to an embed frame changed behind its back", () => {
    setEmbedPolicy({ allowedOrigins: [`${YT}/embed/`] });
    const frame = embed({ src: `${YT}/embed/abc`, title: "Tour" });
    frame.setAttribute("src", "https://evil.example/x");
    frame.setAttribute("sandbox", "allow-scripts allow-top-navigation");
    frame.removeAttribute("referrerpolicy");
    const out = renderToString(frame);
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("allow-top-navigation");
    const parsed = new DOMParser().parseFromString(`<body>${out}`, "text/html").querySelector("iframe") as Element;
    expect(parsed.hasAttribute("src")).toBe(false);
    expect(sandboxTokens(parsed)).toEqual(["allow-scripts"]);
    expect(parsed.getAttribute("referrerpolicy")).toBe("strict-origin-when-cross-origin");
  });
});

describe("the AGENTS.md click-to-load recipe", () => {
  function LiteYouTube(id: string, title: string) {
    const [playing, setPlaying] = signal(false);
    const safeId = encodeURIComponent(id);
    return when(
      () => playing(),
      () =>
        embed({
          src: `https://www.youtube-nocookie.com/embed/${safeId}?autoplay=1`,
          title,
          allow: "autoplay; encrypted-media; picture-in-picture",
          aspectRatio: "16 / 9",
          loading: "eager",
        }),
      () =>
        button({ class: "lite-yt", "aria-label": `Play: ${title}`, on: { click: () => setPlaying(true) } }, [
          img({ src: `https://i.ytimg.com/vi/${safeId}/hqdefault.jpg`, alt: "", loading: "lazy" }),
        ]),
    );
  }

  it("shows the thumbnail, then the player on click", async () => {
    setEmbedPolicy({ allowedOrigins: [`${YT}/embed/`] });
    const root = div([LiteYouTube("abc", "Tour")]);
    document.body.appendChild(root);
    try {
      await Promise.resolve();
      expect(root.querySelector("iframe")).toBeNull();
      expect(renderToString(root)).toContain("https://i.ytimg.com/vi/abc/hqdefault.jpg");
      (root.querySelector("button") as HTMLButtonElement).click();
      const frame = root.querySelector("iframe") as HTMLIFrameElement;
      expect(frame.getAttribute("src")).toBe(`${YT}/embed/abc?autoplay=1`);
      expect(frame.getAttribute("allow")).toBe("autoplay; encrypted-media; picture-in-picture");
      expect(frame.getAttribute("loading")).toBe("eager");
      expect(root.querySelector("button")).toBeNull();
    } finally {
      root.remove();
    }
  });
});
