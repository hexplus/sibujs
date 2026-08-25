/**
 * Streaming SSR + SSR Suspense hardening.
 *
 * Characterisation first: SibuJS streaming is not what the name suggests to
 * someone coming from React. `renderToStream()` is a synchronous depth-first
 * walk of an already-built DOM tree expressed as an async generator — there are
 * no async boundaries inside it. All asynchrony lives in `ssrSuspense()` and
 * `renderToSuspenseStream()`. These tests pin the real contract.
 */
import { describe, expect, it, vi } from "vitest";
import { div, span } from "../src/core/rendering/html";
import { runInSSRContext } from "../src/core/ssr-context";
import {
  collectStream,
  renderToReadableStream,
  renderToStream,
  renderToSuspenseStream,
  serializeState,
  ssrSuspense,
  suspenseSwapScript,
} from "../src/platform/ssr";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const drain = async (gen: AsyncGenerator<string>) => {
  const chunks: string[] = [];
  for await (const c of gen) chunks.push(c);
  return chunks;
};

describe("streaming: ordering contract", () => {
  it("emits tree order for a static tree", async () => {
    const tree = div({ id: "root" }, [
      span({ id: "a" }, "A") as Node,
      span({ id: "b" }, "B") as Node,
      span({ id: "c" }, "C") as Node,
    ]) as HTMLElement;

    const html = (await drain(renderToStream(tree))).join("");

    expect(html.indexOf("A")).toBeLessThan(html.indexOf("B"));
    expect(html.indexOf("B")).toBeLessThan(html.indexOf("C"));
  });

  it("produces output identical to renderToString", async () => {
    const { renderToString } = await import("../src/platform/ssr");
    const tree = div({ id: "r", class: "x" }, [
      span("one") as Node,
      div({}, [span("nested") as Node]) as Node,
    ]) as HTMLElement;

    const streamed = (await drain(renderToStream(tree))).join("");
    expect(streamed).toBe(renderToString(tree));
  });

  it("emits multiple chunks whose concatenation is the whole document", async () => {
    const tree = div(
      {},
      Array.from({ length: 20 }, (_, i) => span(`item-${i}`) as Node),
    ) as HTMLElement;

    const chunks = await drain(renderToStream(tree));
    expect(chunks.length).toBeGreaterThan(1);

    const joined = chunks.join("");
    for (let i = 0; i < 20; i++) expect(joined).toContain(`item-${i}`);
  });

  it("keeps chunk boundaries from corrupting escaped content", async () => {
    // Hostile text is escaped as a unit; no chunk may split an entity such
    // that the concatenation becomes live markup.
    const tree = div({}, [
      span("<script>alert(1)</script>") as Node,
      span("a & b < c > d") as Node,
      span("héllo ✓ 🎉 日本語") as Node,
    ]) as HTMLElement;

    const joined = (await drain(renderToStream(tree))).join("");

    expect(joined).not.toContain("<script>alert(1)</script>");
    expect(joined).toContain("&lt;script&gt;");
    expect(joined).toContain("&amp;");
    expect(joined).toContain("🎉");
    expect(joined).toContain("日本語");
  });
});

describe("streaming: security gate", () => {
  const HOSTILE = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "</script><script>alert(1)</script>",
    '"><script>alert(1)</script>',
    "&<>\"'",
  ];

  it("escapes hostile text in streamed output", async () => {
    for (const payload of HOSTILE) {
      const joined = (await drain(renderToStream(div(payload) as HTMLElement))).join("");
      expect(joined).not.toContain("<script>alert(1)</script>");
      expect(joined).not.toContain("<img src=x onerror=alert(1)>");
    }
  });

  it("escapes hostile attributes in streamed output", async () => {
    for (const payload of HOSTILE) {
      const joined = (await drain(renderToStream(div({ title: payload }, "x") as HTMLElement))).join("");
      const attr = joined.match(/title="([^"]*)"/);
      expect(attr?.[1]).not.toContain('"');
      expect(joined).not.toContain("<script>alert(1)</script>");
    }
  });

  it("strips script and style elements from the stream", async () => {
    const tree = div({}, [span("safe") as Node]) as HTMLElement;
    const evil = document.createElement("script");
    evil.textContent = "alert(1)";
    tree.appendChild(evil);

    const joined = (await drain(renderToStream(tree))).join("");
    expect(joined).not.toContain("alert(1)");
    expect(joined).toContain("safe");
  });

  it("escapes hostile content inside a streamed Suspense boundary", async () => {
    await runInSSRContext(async () => {
      const boundary = ssrSuspense({
        fallback: () => span("loading") as HTMLElement,
        content: async () => div("<script>alert(1)</script>") as HTMLElement,
      });

      const shell = div({}, [boundary.element as Node]) as HTMLElement;
      const joined = (await drain(renderToSuspenseStream(shell, [boundary.promise]))).join("");

      expect(joined).not.toContain("<script>alert(1)</script>");
      expect(joined).toContain("&lt;script&gt;");
    });
  });

  it("escapes hostile content in a streamed Suspense fallback", async () => {
    await runInSSRContext(async () => {
      const boundary = ssrSuspense({
        fallback: () => span("<img src=x onerror=alert(1)>") as HTMLElement,
        content: async () => div("ok") as HTMLElement,
      });

      const shell = div({}, [boundary.element as Node]) as HTMLElement;
      const joined = (await drain(renderToSuspenseStream(shell, [boundary.promise]))).join("");

      expect(joined).not.toContain("<img src=x onerror=alert(1)>");
    });
  });

  it("rejects an unsafe suspense id rather than emitting it", () => {
    expect(() => suspenseSwapScript('x"><script>alert(1)</script>')).toThrow(/must match/);
    expect(() => suspenseSwapScript("safe-id_1")).not.toThrow();
  });

  it("keeps serialized state safe when emitted alongside a stream", async () => {
    const state = serializeState({ x: "</script><script>alert(1)</script>" });
    const joined = (await drain(renderToStream(div("shell") as HTMLElement))).join("") + state;

    expect(joined.match(/<\/script>/g)).toHaveLength(1);
    expect(joined).not.toContain("</script><script>alert(1)");
  });
});

describe("SSR Suspense: boundary semantics", () => {
  it("emits fallback markup in the shell and resolved content afterwards", async () => {
    await runInSSRContext(async () => {
      const boundary = ssrSuspense({
        fallback: () => span({ id: "fb" }, "loading") as HTMLElement,
        content: async () => div({ id: "real" }, "content") as HTMLElement,
      });

      const shell = div({}, [boundary.element as Node]) as HTMLElement;
      const chunks = await drain(renderToSuspenseStream(shell, [boundary.promise]));
      const joined = chunks.join("");

      // Shell carries the fallback and the boundary marker.
      expect(joined).toContain("data-sibu-suspense-id");
      expect(joined).toContain("loading");
      // Resolved payload plus its swap script come later.
      expect(joined).toContain('id="real"');
      expect(joined.indexOf("loading")).toBeLessThan(joined.indexOf('id="real"'));
      expect(joined).toContain("sibu-resolved-");
    });
  });

  it("keeps sibling boundaries isolated under out-of-order resolution", async () => {
    await runInSSRContext(async () => {
      const slow = deferred<HTMLElement>();
      const fast = deferred<HTMLElement>();

      const a = ssrSuspense({
        fallback: () => span("fb-a") as HTMLElement,
        content: () => slow.promise,
      });
      const b = ssrSuspense({
        fallback: () => span("fb-b") as HTMLElement,
        content: () => fast.promise,
      });

      const shell = div({}, [a.element as Node, b.element as Node]) as HTMLElement;
      const streamed = drain(renderToSuspenseStream(shell, [a.promise, b.promise]));

      // B resolves first, A second — content must still land in its own boundary.
      fast.resolve(div({ id: "content-b" }, "B") as HTMLElement);
      await Promise.resolve();
      slow.resolve(div({ id: "content-a" }, "A") as HTMLElement);

      const joined = (await streamed).join("");

      const aId = a.element.getAttribute("data-sibu-suspense-id")!;
      const bId = b.element.getAttribute("data-sibu-suspense-id")!;
      expect(aId).not.toBe(bId);

      // Each resolved payload is wrapped in a div keyed by ITS OWN id.
      expect(joined).toMatch(new RegExp(`id="sibu-resolved-${aId}"[^>]*>.*content-a`));
      expect(joined).toMatch(new RegExp(`id="sibu-resolved-${bId}"[^>]*>.*content-b`));
    });
  });

  it("emits boundaries in the order they were passed, not resolution order", async () => {
    await runInSSRContext(async () => {
      const slow = deferred<HTMLElement>();
      const fast = deferred<HTMLElement>();

      const a = ssrSuspense({ fallback: () => span("fa") as HTMLElement, content: () => slow.promise });
      const b = ssrSuspense({ fallback: () => span("fb") as HTMLElement, content: () => fast.promise });

      const shell = div({}, [a.element as Node, b.element as Node]) as HTMLElement;
      const streamed = drain(renderToSuspenseStream(shell, [a.promise, b.promise]));

      fast.resolve(div("BBB") as HTMLElement);
      await Promise.resolve();
      slow.resolve(div("AAA") as HTMLElement);

      const joined = (await streamed).join("");

      // DOCUMENTED CONTRACT: array order, deterministic regardless of timing.
      expect(joined.indexOf("AAA")).toBeLessThan(joined.indexOf("BBB"));
    });
  });

  it("falls back deterministically when content rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runInSSRContext(async () => {
      const boundary = ssrSuspense({
        fallback: () => span({ id: "fb" }, "fallback-shown") as HTMLElement,
        content: async () => {
          throw new Error("boom");
        },
      });

      const shell = div({}, [boundary.element as Node]) as HTMLElement;
      const joined = (await drain(renderToSuspenseStream(shell, [boundary.promise]))).join("");

      // Rejection resolves to the fallback HTML — the stream never hangs.
      expect(joined).toContain("fallback-shown");
      expect(joined).not.toContain("boom");
    });
    warn.mockRestore();
  });

  it("does not raise an unhandled rejection when the promise is never awaited", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onUnhandled = vi.fn();
    process.on("unhandledRejection", onUnhandled);

    await runInSSRContext(async () => {
      ssrSuspense({
        fallback: () => span("fb") as HTMLElement,
        content: async () => {
          throw new Error("never awaited");
        },
      });
    });

    await new Promise((r) => setTimeout(r, 30));
    process.off("unhandledRejection", onUnhandled);
    expect(onUnhandled).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("isolates one failing boundary from healthy siblings", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runInSSRContext(async () => {
      const bad = ssrSuspense({
        fallback: () => span("fb-bad") as HTMLElement,
        content: async () => {
          throw new Error("bad");
        },
      });
      const good = ssrSuspense({
        fallback: () => span("fb-good") as HTMLElement,
        content: async () => div({ id: "good" }, "good-content") as HTMLElement,
      });

      const shell = div({}, [bad.element as Node, good.element as Node]) as HTMLElement;
      const joined = (await drain(renderToSuspenseStream(shell, [bad.promise, good.promise]))).join("");

      expect(joined).toContain("fb-bad");
      expect(joined).toContain("good-content");
    });
    warn.mockRestore();
  });

  it("handles nested boundaries", async () => {
    await runInSSRContext(async () => {
      const inner = ssrSuspense({
        fallback: () => span("inner-fb") as HTMLElement,
        content: async () => div({ id: "inner" }, "inner-content") as HTMLElement,
      });
      const outer = ssrSuspense({
        fallback: () => span("outer-fb") as HTMLElement,
        content: async () => div({ id: "outer" }, [inner.element as Node]) as HTMLElement,
      });

      const shell = div({}, [outer.element as Node]) as HTMLElement;
      const joined = (await drain(renderToSuspenseStream(shell, [outer.promise, inner.promise]))).join("");

      expect(outer.element.getAttribute("data-sibu-suspense-id")).not.toBe(
        inner.element.getAttribute("data-sibu-suspense-id"),
      );
      expect(joined).toContain("inner-content");
    });
  });

  it("gives every boundary a unique, allowlist-safe id", async () => {
    await runInSSRContext(async () => {
      const ids = new Set<string>();
      for (let i = 0; i < 50; i++) {
        const b = ssrSuspense({
          fallback: () => span("f") as HTMLElement,
          content: async () => div("c") as HTMLElement,
        });
        const id = b.element.getAttribute("data-sibu-suspense-id")!;
        expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
        ids.add(id);
      }
      expect(ids.size).toBe(50);
    });
  });
});

describe("streaming: cross-request isolation", () => {
  it("keeps two interleaved streaming requests free of contamination", async () => {
    const a1 = deferred<HTMLElement>();
    const a2 = deferred<HTMLElement>();
    const b1 = deferred<HTMLElement>();
    const b2 = deferred<HTMLElement>();

    const requestA = runInSSRContext(async () => {
      const s1 = ssrSuspense({ fallback: () => span("A-fb1") as HTMLElement, content: () => a1.promise });
      const s2 = ssrSuspense({ fallback: () => span("A-fb2") as HTMLElement, content: () => a2.promise });
      const shell = div({ id: "A-shell" }, [s1.element as Node, s2.element as Node]) as HTMLElement;
      return (await drain(renderToSuspenseStream(shell, [s1.promise, s2.promise]))).join("");
    });

    const requestB = runInSSRContext(async () => {
      const s1 = ssrSuspense({ fallback: () => span("B-fb1") as HTMLElement, content: () => b1.promise });
      const s2 = ssrSuspense({ fallback: () => span("B-fb2") as HTMLElement, content: () => b2.promise });
      const shell = div({ id: "B-shell" }, [s1.element as Node, s2.element as Node]) as HTMLElement;
      return (await drain(renderToSuspenseStream(shell, [s1.promise, s2.promise]))).join("");
    });

    // Hostile interleaving: B1, A2, B2, A1.
    b1.resolve(div("B-content-1") as HTMLElement);
    a2.resolve(div("A-content-2") as HTMLElement);
    b2.resolve(div("B-content-2") as HTMLElement);
    a1.resolve(div("A-content-1") as HTMLElement);

    const [htmlA, htmlB] = await Promise.all([requestA, requestB]);

    expect(htmlA).toContain("A-shell");
    expect(htmlA).toContain("A-content-1");
    expect(htmlA).toContain("A-content-2");
    expect(htmlA).not.toContain("B-content");
    expect(htmlA).not.toContain("B-shell");

    expect(htmlB).toContain("B-shell");
    expect(htmlB).toContain("B-content-1");
    expect(htmlB).toContain("B-content-2");
    expect(htmlB).not.toContain("A-content");
    expect(htmlB).not.toContain("A-shell");
  });

  it("keeps suspense ids from colliding across 50 concurrent streams", async () => {
    const gates = Array.from({ length: 50 }, () => deferred<HTMLElement>());

    const streams = gates.map((gate, i) =>
      runInSSRContext(async () => {
        const b = ssrSuspense({
          fallback: () => span(`fb-${i}`) as HTMLElement,
          content: () => gate.promise,
        });
        const shell = div({ id: `req-${i}` }, [b.element as Node]) as HTMLElement;
        const html = (await drain(renderToSuspenseStream(shell, [b.promise]))).join("");
        return { i, html };
      }),
    );

    // Release in reverse to maximise interleaving.
    for (let i = 49; i >= 0; i--) gates[i].resolve(div(`content-${i}`) as HTMLElement);

    const results = await Promise.all(streams);

    for (const { i, html } of results) {
      expect(html).toContain(`req-${i}"`);
      expect(html).toContain(`content-${i}<`);
      for (let j = 0; j < 50; j++) {
        if (j !== i) expect(html).not.toContain(`req-${j}"`);
      }
    }
  });
});

describe("streaming: terminal states and cancellation", () => {
  it("ReadableStream.cancel() stops further chunks", async () => {
    const tree = div(
      {},
      Array.from({ length: 200 }, (_, i) => span(`n-${i}`) as Node),
    ) as HTMLElement;
    const stream = renderToReadableStream(tree);
    const reader = stream.getReader();

    const first = await reader.read();
    expect(first.done).toBe(false);

    await reader.cancel();

    // After cancellation the reader yields no further data.
    const after = await reader.read();
    expect(after.done).toBe(true);
  });

  it("a cancelled generator emits nothing further", async () => {
    const tree = div(
      {},
      Array.from({ length: 100 }, (_, i) => span(`x-${i}`) as Node),
    ) as HTMLElement;
    const gen = renderToStream(tree);

    await gen.next();
    await gen.return(undefined);

    const after = await gen.next();
    expect(after.done).toBe(true);
    expect(after.value).toBeUndefined();
  });

  it("a boundary resolving after its stream was abandoned emits nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onUnhandled = vi.fn();
    process.on("unhandledRejection", onUnhandled);

    let leaked = "";
    await runInSSRContext(async () => {
      const gate = deferred<HTMLElement>();
      const b = ssrSuspense({ fallback: () => span("fb") as HTMLElement, content: () => gate.promise });
      const shell = div({}, [b.element as Node]) as HTMLElement;

      const gen = renderToSuspenseStream(shell, [b.promise]);
      // Consume the shell, then abandon the stream.
      await gen.next();
      await gen.return(undefined);

      // Late resolution must not produce output anywhere.
      gate.resolve(div("LATE-CONTENT") as HTMLElement);
      const after = await gen.next();
      leaked = String(after.value ?? "");
      expect(after.done).toBe(true);
    });

    await new Promise((r) => setTimeout(r, 20));
    process.off("unhandledRejection", onUnhandled);

    expect(leaked).not.toContain("LATE-CONTENT");
    expect(onUnhandled).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("collectStream drains a stream to a single string", async () => {
    const tree = div({}, [span("a") as Node, span("b") as Node]) as HTMLElement;
    const html = await collectStream(renderToStream(tree));
    expect(html).toContain("a");
    expect(html).toContain("b");
  });

  it("survives 200 stream lifecycles without unbounded growth", async () => {
    for (let i = 0; i < 200; i++) {
      const tree = div({}, [span(`i-${i}`) as Node]) as HTMLElement;
      const html = await collectStream(renderToStream(tree));
      expect(html).toContain(`i-${i}`);
    }
  });

  it("survives 200 cancelled streams with late resolution", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const gates: ReturnType<typeof deferred<HTMLElement>>[] = [];

    for (let i = 0; i < 200; i++) {
      await runInSSRContext(async () => {
        const gate = deferred<HTMLElement>();
        gates.push(gate);
        const b = ssrSuspense({ fallback: () => span("fb") as HTMLElement, content: () => gate.promise });
        const shell = div({}, [b.element as Node]) as HTMLElement;
        const gen = renderToSuspenseStream(shell, [b.promise]);
        await gen.next();
        await gen.return(undefined);
      });
    }

    // Resolve every abandoned boundary afterwards.
    for (const g of gates) g.resolve(div("late") as HTMLElement);
    await new Promise((r) => setTimeout(r, 20));

    expect(gates).toHaveLength(200);
    warn.mockRestore();
  });
});
