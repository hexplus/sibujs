import { div, signal } from "@sibujs/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearQueryCache, query } from "../src/data/query";

const tick = () => new Promise((r) => setTimeout(r, 0));

// BUG 3 — query data must reach a reactive consumer that reads q.data()
// only on a NON-FIRST run (status-branching: loading → error → data). This is
// the per-run dependency-tracking bug (BUG 1) observed through `query`: on the
// first render only q.loading() is read, so q.data() must be subscribed when
// it is first read on the later, not-loading run.

describe("BUG 3 — query → DOM through a status-branching consumer", () => {
  let parent: HTMLElement;

  beforeEach(() => {
    clearQueryCache();
    parent = document.createElement("div");
    document.body.appendChild(parent);
  });

  afterEach(() => {
    parent.remove();
  });

  it("renders fetched data after the loading branch resolves", async () => {
    const q = query("bug3:list", async () => ["a", "b", "c"]);

    const el = div(() => {
      if (q.loading()) return "loading";
      if (q.error()) return `error: ${q.error()?.message}`;
      const items = q.data() ?? [];
      return items.join(",");
    });
    parent.appendChild(el);

    // First render: loading → only q.loading() read.
    expect(el.textContent).toBe("loading");

    await tick();

    // Fetch resolved → consumer must re-render with the data.
    expect(el.textContent).toBe("a,b,c");
    q.dispose();
  });

  it("propagates a later data update (setQueryData / refetch) to the consumer", async () => {
    const [n, setN] = signal(1);
    const q = query(
      () => `bug3:k:${n()}`,
      async ({ key }) => `data-for-${key}`,
    );

    const el = div(() => {
      if (q.loading()) return "loading";
      if (q.error()) return "error";
      return q.data() ?? "empty";
    });
    parent.appendChild(el);

    expect(el.textContent).toBe("loading");
    await tick();
    expect(el.textContent).toBe("data-for-bug3:k:1");

    // Changing the key re-fetches; consumer must follow.
    setN(2);
    await tick();
    expect(el.textContent).toBe("data-for-bug3:k:2");
    q.dispose();
  });

  it("renders the error branch when the fetch rejects", async () => {
    const q = query(
      "bug3:err",
      async () => {
        throw new Error("boom");
      },
      { retry: { maxRetries: 0 } },
    );

    const el = div(() => {
      if (q.loading()) return "loading";
      if (q.error()) return `error: ${q.error()?.message}`;
      return "data";
    });
    parent.appendChild(el);

    expect(el.textContent).toBe("loading");
    await tick();
    expect(el.textContent).toBe("error: boom");
    q.dispose();
  });
});
