/**
 * SSR must never serialize `srcdoc`.
 *
 * Escaping is the wrong layer: `escapeAttr()` correctly produces
 * `srcdoc="&lt;script&gt;…"`, and the browser then decodes that value and
 * parses it as a nested document — yielding `<script>…` again. So the fix is
 * omission, not escaping, and it has to hold identically across every
 * serializer: `renderToString`, the `renderToStream` generator, and the
 * attribute builder feeding `renderToDocument`.
 *
 * The string and streaming renderers are asserted against each other as well as
 * against the payload, because a divergence between them is its own bug class —
 * someone streams in production and snapshots with `renderToString` in tests.
 */

import { describe, expect, it } from "vitest";
import { html } from "../src/core/rendering/htm";
import { div } from "../src/core/rendering/html";
import { renderToReadableStream, renderToStream, renderToString } from "../src/platform/ssr";
import { setSafeAttribute } from "../src/utils/setSafeAttribute";

const PAYLOADS: Array<{ label: string; value: string }> = [
  { label: "script tag", value: "<script>window.__XSS = true</script>" },
  { label: "img onerror", value: '<img src=x onerror="window.__XSS=1">' },
  { label: "quotes and entity boundaries", value: `<a href="x" title='y'>&lt;&amp;&quot;</a>` },
  { label: "nested iframe", value: '<iframe srcdoc="<script>1</script>"></iframe>' },
  { label: "svg script", value: "<svg><script>1</script></svg>" },
];

async function drain(stream: AsyncGenerator<string>): Promise<string> {
  const out: string[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out.join("");
}

async function readAll(stream: ReadableStream<string>): Promise<string> {
  const reader = stream.getReader();
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += value;
  }
  return out;
}

/** Every construction path that can attach a srcdoc-bearing element. */
const BUILDERS: Array<{ name: string; build: (payload: string) => HTMLElement }> = [
  {
    name: "native setAttribute (server markup)",
    build: (payload) => {
      const frame = document.createElement("iframe");
      frame.setAttribute("srcdoc", payload);
      return frame;
    },
  },
  {
    name: "native setAttribute, uppercase name",
    build: (payload) => {
      const frame = document.createElement("iframe");
      // HTML lower-cases attribute names on set, so this lands as `srcdoc`.
      frame.setAttribute("SRCDOC", payload);
      return frame;
    },
  },
  {
    name: "wrapped in a parent tree",
    build: (payload) => {
      const frame = document.createElement("iframe");
      frame.setAttribute("srcdoc", payload);
      const wrapper = div({ id: "wrap" }) as HTMLElement;
      wrapper.appendChild(frame);
      return wrapper;
    },
  },
  {
    name: "tagFactory props",
    build: (payload) => div({ srcdoc: payload, id: "kept" }) as HTMLElement,
  },
  {
    name: "html dynamic expression",
    build: (payload) => html`<iframe srcdoc=${payload}></iframe>` as HTMLElement,
  },
  {
    name: "html mixed expression",
    build: (payload) => html`<iframe srcdoc="<p>a</p>${payload}"></iframe>` as HTMLElement,
  },
  {
    name: "setSafeAttribute onto existing markup",
    build: (payload) => {
      const frame = document.createElement("iframe");
      frame.setAttribute("srcdoc", "<p>existing</p>");
      setSafeAttribute(frame, "srcdoc", payload);
      return frame;
    },
  },
];

describe("SSR omits srcdoc across every renderer", () => {
  for (const builder of BUILDERS) {
    for (const payload of PAYLOADS) {
      it(`${builder.name} · ${payload.label}`, async () => {
        const stringOut = renderToString(builder.build(payload.value));
        const streamOut = await drain(renderToStream(builder.build(payload.value)));
        const readableOut = await readAll(renderToReadableStream(builder.build(payload.value)));

        for (const [name, out] of [
          ["renderToString", stringOut],
          ["renderToStream", streamOut],
          ["renderToReadableStream", readableOut],
        ] as const) {
          // The attribute must be gone entirely — not escaped, not renamed.
          expect(out.toLowerCase(), `${name} emitted a srcdoc attribute`).not.toContain("srcdoc");
          // …and the payload must not survive by another route.
          expect(out, `${name} emitted the raw payload`).not.toContain("<script>window.__XSS");
          expect(out, `${name} emitted an onerror handler`).not.toContain("onerror");
        }

        // The two documented render paths must agree.
        expect(streamOut).toBe(stringOut);
        expect(readableOut).toBe(stringOut);
      });
    }
  }

  it("does not emit an entity-escaped srcdoc", async () => {
    const frame = document.createElement("iframe");
    frame.setAttribute("srcdoc", "<script>alert(1)</script>");

    const out = renderToString(frame);
    expect(out).not.toContain("&lt;script&gt;");
    expect(out.toLowerCase()).not.toContain("srcdoc");
  });

  it("keeps sibling attributes on the same element", () => {
    const frame = document.createElement("iframe");
    frame.setAttribute("srcdoc", "<script>1</script>");
    frame.setAttribute("title", "kept");
    frame.setAttribute("width", "300");

    const out = renderToString(frame);
    expect(out.toLowerCase()).not.toContain("srcdoc");
    expect(out).toContain('title="kept"');
    expect(out).toContain('width="300"');
  });

  it("does not substitute another nested-document mechanism", () => {
    const frame = document.createElement("iframe");
    frame.setAttribute("srcdoc", "<script>1</script>");

    const out = renderToString(frame).toLowerCase();
    expect(out).not.toContain("srcdoc");
    // The renderer must not "helpfully" convert it into a data: document.
    expect(out).not.toContain("data:text/html");
  });

  it("still emits ordinary attributes and existing policies", () => {
    const el = div({ id: "x", title: "t" }) as HTMLElement;
    el.setAttribute("style", "color: red");
    const out = renderToString(el);
    expect(out).toContain('id="x"');
    expect(out).toContain('title="t"');
    expect(out).toContain("color");
  });

  it("still drops javascript: URLs and on* handlers", () => {
    const a = document.createElement("a");
    a.setAttribute("href", "javascript:alert(1)");
    a.setAttribute("onclick", "alert(1)");
    const out = renderToString(a);
    expect(out).not.toContain("javascript:");
    expect(out.toLowerCase()).not.toContain("onclick");
  });
});
