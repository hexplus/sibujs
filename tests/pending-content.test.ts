import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as publicApi from "../index";
import { when } from "../src/core/rendering/directives";
import { dispose } from "../src/core/rendering/dispose";
import { Fragment } from "../src/core/rendering/fragment";
import { div, li, span, ul } from "../src/core/rendering/html";
import { type PendingContent, pendingContent } from "../src/core/rendering/pendingContent";
import { pendingCount } from "../src/core/rendering/range";
import { asyncDerived } from "../src/core/signals/asyncDerived";
import { type LifecycleScope, lifecycleScope } from "../src/core/signals/lifecycleScope";
import { signal } from "../src/core/signals/signal";
import { withSSR } from "../src/core/ssr-context";
import { structuralBinding } from "../src/reactivity/track";

// ---------------------------------------------------------------------------
// `pendingContent()`: explicit readiness for application content.
// ---------------------------------------------------------------------------

let host: HTMLElement;

beforeAll(() => {
  const sheet = document.createElement("style");
  sheet.textContent = ".in { animation-name: rise; animation-duration: 0.2s; }";
  document.head.appendChild(sheet);
});

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  dispose(host);
  host.remove();
  vi.restoreAllMocks();
});

const flush = async (turns = 4) => {
  for (let i = 0; i < turns; i++) await new Promise<void>((r) => setTimeout(r, 0));
};
const end = (el: Element | null | undefined) => el?.dispatchEvent(new Event("animationend"));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const q = (selector: string) => host.querySelector(selector);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** `when(on, () => Fragment([heading, region()]))` with a custom enter. */
function mountCustom(region: () => Node, waitForContent = 1000) {
  const [on, setOn] = signal(false);
  const enter = vi.fn();
  const anchor = when(on, () => Fragment([span({ class: "heading" }, "h"), region()]), {
    transition: { enter, waitForContent },
  });
  host.appendChild(anchor);
  return { setOn, enter, anchor };
}

describe("registration located at a node", () => {
  it("a custom enter waits until the content is committed", async () => {
    let pending!: PendingContent;
    const list = ul({ class: "list" }, li("Loading…"));
    const { setOn, enter } = mountCustom(() => {
      pending = pendingContent(list);
      return list;
    });
    await flush();
    setOn(true);
    await flush();
    expect(enter).not.toHaveBeenCalled();
    list.replaceChildren(li("one"), li("two"));
    pending.done();
    expect(pending.settled).toBe(true);
    await flush();
    expect(enter).toHaveBeenCalledTimes(1);
  });

  it("a class-based enter: the committed children join once the element's own animation ended", async () => {
    let pending!: PendingContent;
    const [on, setOn] = signal(false);
    host.appendChild(
      when(
        on,
        () => {
          const list = ul({ class: "list" });
          pending = pendingContent(list);
          return Fragment([span({ class: "heading" }, "h"), list]);
        },
        { transition: { enterClass: "in", waitForContent: 1000 } },
      ),
    );
    await flush();
    setOn(true);
    end(q(".heading"));
    end(q(".list"));
    expect(q(".heading")?.classList.contains("in")).toBe(true);
    (q(".list") as HTMLElement).replaceChildren(li({ class: "row" }, "one"));
    pending.done();
    await flush();
    expect(q(".row")?.classList.contains("in")).toBe(true);
    end(q(".row"));
    expect(host.querySelectorAll(".in").length).toBe(0);
  });

  it("done(nodes) names what joins", async () => {
    let pending!: PendingContent;
    const [on, setOn] = signal(false);
    const region = div({ class: "region" });
    host.appendChild(
      when(
        on,
        () => {
          pending = pendingContent(region);
          return Fragment([span({ class: "heading" }, "h"), region]);
        },
        { transition: { enterClass: "in", waitForContent: 1000 } },
      ),
    );
    await flush();
    setOn(true);
    end(q(".heading"));
    end(region);
    const a = span({ class: "a" }, "a");
    const b = span({ class: "b" }, "b");
    region.append(a, b);
    pending.done([b]);
    await flush();
    expect(a.classList.contains("in")).toBe(false);
    expect(b.classList.contains("in")).toBe(true);
  });

  it("several registrations at one location stay pending independently; completion is idempotent", async () => {
    const region = div({ class: "region" });
    let first!: PendingContent;
    let second!: PendingContent;
    const { setOn, enter } = mountCustom(() => {
      first = pendingContent(region);
      second = pendingContent(region);
      return region;
    });
    await flush();
    setOn(true);
    await flush();
    first.done();
    first.done();
    first.cancel();
    await flush();
    expect(second.settled).toBe(false);
    expect(enter).not.toHaveBeenCalled();
    second.cancel();
    await flush();
    expect(enter).toHaveBeenCalledTimes(1);
  });

  it("a stale completion never settles the operation that superseded it", async () => {
    const region = div({ class: "region" });
    let current: PendingContent | null = null;
    const start = () => {
      const previous = current;
      current = pendingContent(region);
      previous?.cancel(); // superseded, after the new one began
      return current;
    };
    let stale!: PendingContent;
    const { setOn, enter } = mountCustom(() => {
      stale = start();
      return region;
    });
    await flush();
    setOn(true);
    await flush();
    const fresh = start();
    stale.done(); // the old request returns late
    await flush();
    expect(fresh.settled).toBe(false);
    expect(enter).not.toHaveBeenCalled();
    fresh.done();
    await flush();
    expect(enter).toHaveBeenCalledTimes(1);
  });

  it("disposing the node releases the registration", async () => {
    const before = pendingCount();
    const region = div();
    const pending = pendingContent(region);
    expect(pendingCount()).toBe(before + 1);
    dispose(region);
    expect(pending.settled).toBe(true);
    expect(pendingCount()).toBe(before);
    pending.done();
    expect(pendingCount()).toBe(before);
  });

  it("a branch switched away cancels the wait; the registration is released with its node", async () => {
    const before = pendingCount();
    let pending!: PendingContent;
    const { setOn, enter } = mountCustom(() => {
      const region = div();
      pending = pendingContent(region);
      return region;
    });
    await flush();
    setOn(true);
    await flush();
    setOn(false);
    await flush();
    expect(pending.settled).toBe(true);
    expect(pendingCount()).toBe(before);
    expect(enter).not.toHaveBeenCalled();
  });

  it("never settled: the enter runs at its deadline", async () => {
    const { setOn, enter } = mountCustom(() => {
      const region = div();
      pendingContent(region);
      return region;
    }, 60);
    await flush();
    setOn(true);
    await sleep(200);
    expect(enter).toHaveBeenCalledTimes(1);
  });

  it("a registration made while the enter waits joins its dependencies, under the same deadline", async () => {
    const region = div();
    let first!: PendingContent;
    const { setOn, enter } = mountCustom(() => {
      first = pendingContent(region);
      return region;
    });
    await flush();
    setOn(true);
    await flush();
    const late = pendingContent(region);
    first.done();
    await flush();
    expect(enter).not.toHaveBeenCalled();
    late.done();
    await flush();
    expect(enter).toHaveBeenCalledTimes(1);
  });

  it("a registration made while a class-based enter is open keeps it open", async () => {
    let first!: PendingContent;
    const [on, setOn] = signal(false);
    const region = div({ class: "region" });
    host.appendChild(
      when(
        on,
        () => {
          first = pendingContent(region);
          return Fragment([span({ class: "heading" }, "h"), region]);
        },
        { transition: { enterClass: "in", waitForContent: 1000 } },
      ),
    );
    await flush();
    setOn(true);
    end(q(".heading"));
    end(region);
    const late = pendingContent(region);
    first.done();
    await flush();
    expect(q(".heading")?.classList.contains("in")).toBe(true);
    region.append(span({ class: "row" }, "r"));
    late.done();
    await flush();
    end(q(".row"));
    expect(host.querySelectorAll(".in").length).toBe(0);
  });
});

describe("registration located at a captured lifecycle", () => {
  it("counts for the branch it was captured in; ending the lifecycle releases it", async () => {
    let scope!: LifecycleScope;
    let pending!: PendingContent;
    const { setOn, enter } = mountCustom(() => {
      scope = lifecycleScope();
      pending = pendingContent(scope);
      return div();
    });
    await flush();
    setOn(true);
    await flush();
    expect(enter).not.toHaveBeenCalled();
    pending.done();
    await flush();
    expect(enter).toHaveBeenCalledTimes(1);
    setOn(false);
    expect(scope.state()).toBe("ended");
    expect(pendingContent(scope).settled).toBe(true);
  });

  it("the lifecycle ending settles it", () => {
    const owner = structuralBinding(() => {});
    const scope = owner.run(() => lifecycleScope());
    const before = pendingCount();
    const pending = pendingContent(scope);
    expect(pendingCount()).toBe(before + 1);
    owner.stop();
    expect(pending.settled).toBe(true);
    expect(pendingCount()).toBe(before);
  });

  it("a lifecycle outside the entering branch does not hold its enter", async () => {
    const owner = structuralBinding(() => {});
    const elsewhere = owner.run(() => lifecycleScope());
    const pending = pendingContent(elsewhere);
    const { setOn, enter } = mountCustom(() => div());
    await flush();
    setOn(true);
    await flush();
    expect(enter).toHaveBeenCalledTimes(1);
    pending.cancel();
    owner.stop();
  });
});

describe("examples", () => {
  it("a fetch-driven region settles after committing its rows, or its error view", async () => {
    for (const fail of [false, true]) {
      const response = deferred<string[]>();
      function Results() {
        const list = ul({ class: "results" }, li("Loading…"));
        const pending = pendingContent(list);
        response.promise
          .then((rows) => {
            list.replaceChildren(...rows.map((row) => li(row)));
            pending.done();
          })
          .catch((err) => {
            list.replaceChildren(li({ class: "error" }, String(err)));
            pending.done();
          });
        return list;
      }
      const { setOn, enter, anchor } = mountCustom(Results);
      await flush();
      setOn(true);
      await flush();
      expect(enter).not.toHaveBeenCalled();
      if (fail) response.reject(new Error("offline"));
      else response.resolve(["a", "b"]);
      await flush();
      expect(enter).toHaveBeenCalledTimes(1);
      dispose(anchor);
      anchor.remove();
    }
  });

  it("asyncDerived-backed content settles once its value is rendered", async () => {
    const answer = deferred<string>();
    function Profile() {
      const scope = lifecycleScope();
      const user = asyncDerived(() => answer.promise, "");
      const card = div({ class: "card" }, () => user.value() || "Loading…");
      const pending = pendingContent(card);
      scope.watch(
        () => user.loading(),
        (loading) => {
          if (!loading) pending.done();
        },
      );
      scope.own(() => user.dispose);
      return card;
    }
    const { setOn, enter } = mountCustom(Profile);
    await flush();
    setOn(true);
    await flush();
    expect(enter).not.toHaveBeenCalled();
    answer.resolve("Ada");
    await flush();
    expect(enter).toHaveBeenCalledTimes(1);
    expect(q(".card")?.textContent).toBe("Ada");
  });
});

describe("server renders and the public entry", () => {
  it("on the server it registers nothing and returns an inert handle", () => {
    const before = pendingCount();
    const pending = withSSR(() => pendingContent(div()));
    expect(pending.settled).toBe(true);
    expect(pendingCount()).toBe(before);
    pending.done();
    pending.cancel();
  });

  it("is exported from the main entry", () => {
    expect(publicApi.pendingContent).toBe(pendingContent);
    const typed: (at: Node | LifecycleScope) => publicApi.PendingContent = publicApi.pendingContent;
    expect(typeof typed).toBe("function");
  });
});
