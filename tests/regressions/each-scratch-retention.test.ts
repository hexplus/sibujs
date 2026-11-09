// @vitest-environment jsdom
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { setRuntimeErrorHandler } from "../../src/core/errors";
import { dispose } from "../../src/core/rendering/dispose";
import { each } from "../../src/core/rendering/each";
import { li } from "../../src/core/rendering/html";
import { signal } from "../../src/core/signals/signal";

// Binding counters cannot see this: a row in `each()`'s scratch storage is fully
// disposed and detached, and only a real collection shows it is still reachable.

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

const turn = () => new Promise<void>((done) => setTimeout(done, 0));

async function collect(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await turn();
    gc();
  }
}

const alive = (refs: WeakRef<Node>[]) => refs.filter((ref) => ref.deref() !== undefined).length;

afterEach(() => {
  document.body.replaceChildren();
  setRuntimeErrorHandler(null);
});

interface List {
  refs: Map<number, WeakRef<Node>>;
  host: HTMLElement;
  anchor: Comment;
  set: (ids: number[]) => void;
  text: () => string;
}

function list(initial: number[], onRender?: (id: number, anchor: () => Comment) => void): List {
  const refs = new Map<number, WeakRef<Node>>();
  const [ids, setIds] = signal(initial);
  const host = document.createElement("ul");
  document.body.appendChild(host);
  const anchor: Comment = each(
    ids,
    (id) => {
      const row = li(() => String(id()));
      refs.set(id.peek(), new WeakRef(row));
      onRender?.(id.peek(), () => anchor);
      return row;
    },
    { key: (id) => id },
  );
  host.appendChild(anchor);
  return { refs, host, anchor, set: setIds, text: () => host.textContent ?? "" };
}

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);
const refsOf = (l: List, ids: number[]) => ids.map((id) => l.refs.get(id) as WeakRef<Node>);

describe("each() releases removed rows", () => {
  it("after the list is cleared while it stays live", async () => {
    const l = list(range(0, 200));
    await turn();
    const rows = refsOf(l, range(0, 200));

    l.set([]);
    await collect();

    expect(alive(rows)).toBe(0);
    expect(l.anchor.parentNode).toBe(l.host);
  });

  it("after a shrink, keeping exactly the surviving rows", async () => {
    const l = list(range(0, 200));
    await turn();
    const removed = refsOf(l, range(10, 200));
    const kept = refsOf(l, range(0, 10));

    l.set(range(0, 10));
    await collect();

    expect(alive(removed)).toBe(0);
    expect(alive(kept)).toBe(10);
    expect(l.host.children).toHaveLength(10);
  });

  it("after being replaced by a single new row", async () => {
    const l = list(range(0, 200));
    await turn();
    const rows = refsOf(l, range(0, 200));

    l.set([999]);
    await collect();

    expect(alive(rows)).toBe(0);
    expect(l.text()).toBe("999");
  });

  it("after an equal-length replacement", async () => {
    const l = list(range(0, 200));
    await turn();
    const rows = refsOf(l, range(0, 200));

    l.set(range(1000, 1200));
    await collect();

    expect(alive(rows)).toBe(0);
    expect(l.host.children).toHaveLength(200);
  });

  it("after the list is disposed while its root stays referenced", async () => {
    const l = list(range(0, 200));
    await turn();
    const rows = refsOf(l, range(0, 200));

    dispose(l.anchor);
    await collect();

    expect(alive(rows)).toBe(0);
    expect(l.anchor.nodeType).toBe(8);
  });

  it("after a render disposes the list partway through a pass", async () => {
    const l = list([], (id, anchor) => {
      if (id === 5) dispose(anchor());
    });
    await turn();

    l.set(range(0, 10));
    await turn();
    const built = refsOf(l, range(0, 6));
    await collect();

    expect(alive(built)).toBe(0);
  });

  it("after a pass interrupted during placement, once a shorter pass runs", async () => {
    setRuntimeErrorHandler(() => {});
    const l = list(range(0, 200));
    await turn();
    const rows = refsOf(l, range(0, 200));

    const realInsert = l.host.insertBefore;
    l.host.insertBefore = () => {
      throw new Error("placement failed");
    };
    l.set(range(0, 200).reverse());
    await turn();
    l.host.insertBefore = realInsert;

    l.set([]);
    await collect();

    expect(alive(rows)).toBe(0);
    expect(l.host.children).toHaveLength(0);
  });
});

describe("each() still reconciles after releasing its scratch references", () => {
  it("reuses rows across clear, grow, reorder and shrink", async () => {
    const l = list([1, 2, 3]);
    await turn();
    const two = l.host.children[1];

    l.set([3, 2, 1]);
    expect(l.text()).toBe("321");
    expect(l.host.children[1]).toBe(two);

    l.set([]);
    expect(l.text()).toBe("");

    l.set([4, 5]);
    expect(l.text()).toBe("45");

    l.set([5]);
    expect(l.text()).toBe("5");
  });
});
