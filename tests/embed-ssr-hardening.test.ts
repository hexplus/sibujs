/**
 * `embed()` frames under SSR, after the DOM was changed behind the framework's
 * back, and across concurrent requests.
 *
 * The SSR serializer re-judges a frame `embed()` built against what `embed()`
 * itself wrote, so no mutation can make the served frame wider than the one
 * `embed()` produced:
 *
 *   - only the attributes `embed()` writes (plus `id`, `class`, `style`,
 *     `width`, `height`, `data-*`, `aria-*`) are serialized — `srcdoc`,
 *     `allowpaymentrequest`, `allowusermedia`, `csp`-free variants and any other
 *     capability attribute added later are dropped;
 *   - `src` is re-checked against the policy the frame was built under;
 *   - `sandbox` and `allow` are the intersection of the current value and the
 *     one `embed()` wrote; a missing `sandbox` / `referrerpolicy` is restored;
 *   - `allowfullscreen` is emitted only when the effective `allow` grants
 *     `fullscreen`;
 *   - a frame without a non-blank `title` is not emitted;
 *   - string and stream renderers agree.
 *
 * `allow` narrowing keeps a feature only when every declaration of it grants
 * the frame's own origin; a restriction (`'none'`, `'self'`, another origin)
 * is never turned into a grant.
 *
 * `setEmbedPolicy()` inside `runInSSRContext()` configures that request only,
 * and a frame is judged by the policy in force when it was built.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { div } from "../src/core/rendering/html";
import { signal } from "../src/core/signals/signal";
import { runInSSRContext } from "../src/core/ssr-context";
import { collectStream, renderToStream, renderToString } from "../src/platform/ssr";
import { embed, setEmbedPolicy } from "../src/ui/embed";
import { narrowEmbedAllow } from "../src/utils/embedPolicy";

const YT = "https://www.youtube-nocookie.com";
const VIMEO = "https://player.vimeo.com";

afterEach(() => {
  setEmbedPolicy({ allowedOrigins: [] });
  vi.restoreAllMocks();
});

async function serialize(node: Node): Promise<string> {
  const string = renderToString(node);
  expect(await collectStream(renderToStream(node))).toBe(string);
  return string;
}

function parsedFrame(markup: string): HTMLIFrameElement | null {
  return new DOMParser().parseFromString(`<body>${markup}`, "text/html").querySelector("iframe");
}

function tokens(value: string | null): string[] {
  return (value ?? "").split(/\s+/).filter(Boolean).sort();
}

function frame(extra: Record<string, unknown> = {}): HTMLIFrameElement {
  setEmbedPolicy({ allowedOrigins: [`${YT}/embed/`] });
  return embed({ src: `${YT}/embed/abc`, title: "Test video", ...extra });
}

describe("embed() frames mutated after construction (SSR)", () => {
  it("never serializes srcdoc", async () => {
    const f = frame();
    f.setAttribute("srcdoc", "<script>alert(1)</script>");
    f.setAttribute("SRCDOC", "<script>alert(2)</script>");
    const out = await serialize(f);
    expect(out).not.toMatch(/srcdoc/i);
    expect(out).not.toContain("alert");
  });

  it("drops capability attributes embed() never writes", async () => {
    const f = frame({ allow: "encrypted-media" });
    for (const name of ["allowpaymentrequest", "allowusermedia", "browsingtopics", "adauctionheaders", "name"]) {
      f.setAttribute(name, "");
    }
    const out = await serialize(f);
    for (const name of ["allowpaymentrequest", "allowusermedia", "browsingtopics", "adauctionheaders", "name="]) {
      expect(out, name).not.toContain(name);
    }
  });

  it("emits allowfullscreen only when the effective allow grants fullscreen", async () => {
    const without = frame({ allow: "encrypted-media" });
    without.setAttribute("allowfullscreen", "");
    expect(parsedFrame(await serialize(without))?.hasAttribute("allowfullscreen")).toBe(false);

    const withFs = frame({ allow: "fullscreen" });
    expect(parsedFrame(await serialize(withFs))?.hasAttribute("allowfullscreen")).toBe(true);

    // `allow` widened by mutation: fullscreen was never granted by embed().
    const widened = frame({ allow: "encrypted-media" });
    widened.setAttribute("allow", "encrypted-media; fullscreen");
    widened.setAttribute("allowfullscreen", "");
    const parsed = parsedFrame(await serialize(widened)) as HTMLIFrameElement;
    expect(parsed.getAttribute("allow")).toBe("encrypted-media");
    expect(parsed.hasAttribute("allowfullscreen")).toBe(false);
  });

  it("keeps the sandbox and allow embed() wrote, or narrower", async () => {
    const f = frame({ sandbox: "allow-scripts", allow: "encrypted-media" });
    f.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-top-navigation");
    f.setAttribute("allow", "encrypted-media; picture-in-picture; camera");
    let parsed = parsedFrame(await serialize(f)) as HTMLIFrameElement;
    expect(tokens(parsed.getAttribute("sandbox"))).toEqual(["allow-scripts"]);
    expect(parsed.getAttribute("allow")).toBe("encrypted-media");

    // A narrower mutation is kept.
    f.setAttribute("sandbox", "");
    f.removeAttribute("allow");
    parsed = parsedFrame(await serialize(f)) as HTMLIFrameElement;
    expect(parsed.getAttribute("sandbox")).toBe("");
    expect(parsed.hasAttribute("allow")).toBe(false);

    // A removed sandbox is restored to what embed() wrote.
    f.removeAttribute("sandbox");
    parsed = parsedFrame(await serialize(f)) as HTMLIFrameElement;
    expect(tokens(parsed.getAttribute("sandbox"))).toEqual(["allow-scripts"]);
  });

  it("restores the referrer policy embed() wrote unless the mutation is no-referrer", async () => {
    const f = frame({ referrerpolicy: "same-origin" });
    f.setAttribute("referrerpolicy", "unsafe-url");
    expect(parsedFrame(await serialize(f))?.getAttribute("referrerpolicy")).toBe("same-origin");
    f.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
    expect(parsedFrame(await serialize(f))?.getAttribute("referrerpolicy")).toBe("same-origin");
    f.setAttribute("referrerpolicy", "no-referrer");
    expect(parsedFrame(await serialize(f))?.getAttribute("referrerpolicy")).toBe("no-referrer");
    f.removeAttribute("referrerpolicy");
    expect(parsedFrame(await serialize(f))?.getAttribute("referrerpolicy")).toBe("same-origin");
  });

  it("re-checks a mutated src and keeps loading to its two values", async () => {
    const f = frame();
    f.setAttribute("src", "https://evil.example/x");
    f.setAttribute("loading", "whatever");
    const parsed = parsedFrame(await serialize(f)) as HTMLIFrameElement;
    expect(parsed.hasAttribute("src")).toBe(false);
    expect(parsed.getAttribute("loading")).toBe("lazy");
  });

  it("keeps id, class, style, width, height, data-* and aria-*", async () => {
    const f = frame({ id: "v", class: "player", aspectRatio: "16 / 9" });
    f.setAttribute("width", "640");
    f.setAttribute("data-video", "abc");
    f.setAttribute("aria-describedby", "caption");
    const parsed = parsedFrame(await serialize(f)) as HTMLIFrameElement;
    expect(parsed.id).toBe("v");
    expect(parsed.className).toBe("player");
    expect(parsed.getAttribute("style")).toContain("aspect-ratio");
    expect(parsed.getAttribute("width")).toBe("640");
    expect(parsed.getAttribute("data-video")).toBe("abc");
    expect(parsed.getAttribute("aria-describedby")).toBe("caption");
  });

  it("does not emit a frame whose title was removed or blanked", async () => {
    const removed = frame();
    removed.removeAttribute("title");
    expect(parsedFrame(await serialize(div([removed])))).toBeNull();
    const blank = frame();
    blank.setAttribute("title", "   ");
    expect(parsedFrame(await serialize(div([blank])))).toBeNull();
  });

  it("keeps the last non-blank title from a getter", () => {
    setEmbedPolicy({ allowedOrigins: [YT] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const [title, setTitle] = signal("First");
    const f = embed({ src: `${YT}/embed/x`, title });
    expect(f.getAttribute("title")).toBe("First");
    setTitle("  ");
    expect(f.getAttribute("title")).toBe("First");
    setTitle("Second");
    expect(f.getAttribute("title")).toBe("Second");
  });

  it("leaves a raw iframe to the generic serializer rules", async () => {
    const raw = document.createElement("iframe");
    raw.setAttribute("src", "https://elsewhere.example/x");
    raw.setAttribute("srcdoc", "<script>alert(1)</script>");
    raw.setAttribute("allowfullscreen", "");
    const out = await serialize(raw);
    expect(out).toContain('src="https://elsewhere.example/x"');
    expect(out).toContain("allowfullscreen");
    expect(out).not.toContain("srcdoc");
  });
});

describe("narrowEmbedAllow never turns a restriction into a grant", () => {
  it.each([
    ["fullscreen 'none'", ""],
    ["autoplay 'none'", ""],
    ["fullscreen https://other.example", ""],
    ["fullscreen 'self'", ""],
    ["fullscreen *", "fullscreen"],
    ["fullscreen 'src'", "fullscreen"],
    ["fullscreen 'src' https://other.example", "fullscreen"],
    ["fullscreen", "fullscreen"],
    ["camera; fullscreen", "fullscreen"],
    ["fullscreen 'none'; fullscreen", ""],
    ["fullscreen; fullscreen 'none'", ""],
    // Feature names are case-sensitive in the browser: `FullScreen` grants nothing.
    ["FullScreen; Autoplay *", ""],
    ["FULLSCREEN *; fullscreen", "fullscreen"],
    // Allowlist keywords are not: `'SRC'` grants and `'NONE'` denies.
    ["fullscreen 'SRC'", "fullscreen"],
    ["fullscreen 'NONE'", ""],
    ["fullscreen\t'src'", "fullscreen"],
    ["fullscreen,autoplay", ""],
    ["fullscreen 'src' 'none'", ""],
    ["", ""],
  ])("%j → %j", (input, expected) => {
    expect(narrowEmbedAllow(input)).toBe(expected);
  });

  it("does not add allowfullscreen when fullscreen was restricted", () => {
    setEmbedPolicy({ allowedOrigins: [YT] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = embed({ src: `${YT}/embed/x`, title: "t", allow: "fullscreen 'none'; encrypted-media" });
    expect(f.getAttribute("allow")).toBe("encrypted-media");
    expect(f.hasAttribute("allowfullscreen")).toBe(false);
  });
});

describe("embed policy isolation across concurrent SSR requests", () => {
  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

  function request(origin: string, other: string, before: number, after: number): Promise<string> {
    return runInSSRContext(async () => {
      setEmbedPolicy({ allowedOrigins: [origin] });
      await tick(before);
      const tree = div([
        embed({ src: `${origin}/video/1`, title: "own" }),
        embed({ src: `${other}/video/1`, title: "other" }),
      ]);
      await tick(after);
      return renderToString(tree);
    });
  }

  it("each request serializes only its own allowlisted origin", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // A configures, B configures, A builds, B builds, A serializes, B serializes.
    const [a, b] = await Promise.all([request(YT, VIMEO, 10, 20), request(VIMEO, YT, 15, 1)]);
    const srcs = (markup: string) =>
      Array.from(new DOMParser().parseFromString(`<body>${markup}`, "text/html").querySelectorAll("iframe")).map((f) =>
        f.getAttribute("src"),
      );
    expect(srcs(a)).toEqual([`${YT}/video/1`, null]);
    expect(srcs(b)).toEqual([`${VIMEO}/video/1`, null]);
  });

  it("a request-scoped policy does not change the process-wide one", async () => {
    setEmbedPolicy({ allowedOrigins: [YT] });
    await runInSSRContext(async () => {
      setEmbedPolicy({ allowedOrigins: [VIMEO] });
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(embed({ src: `${YT}/video/1`, title: "t" }).getAttribute("src")).toBe(`${YT}/video/1`);
    expect(embed({ src: `${VIMEO}/video/1`, title: "t" }).hasAttribute("src")).toBe(false);
  });

  it("a frame keeps the policy it was built under", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setEmbedPolicy({ allowedOrigins: [YT] });
    const [src, setSrc] = signal(`${YT}/video/1`);
    const f = embed({ src, title: "t" });
    setEmbedPolicy({ allowedOrigins: [VIMEO] });
    // Serialization and later getter runs judge by the policy at construction.
    expect(parsedFrame(renderToString(f))?.getAttribute("src")).toBe(`${YT}/video/1`);
    setSrc(`${VIMEO}/video/2`);
    expect(f.hasAttribute("src")).toBe(false);
    setSrc(`${YT}/video/2`);
    expect(f.getAttribute("src")).toBe(`${YT}/video/2`);
  });
});
