import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { when } from "../src/core/rendering/directives";
import { dispose } from "../src/core/rendering/dispose";
import { Fragment } from "../src/core/rendering/fragment";
import { div, span } from "../src/core/rendering/html";
import { type PendingContent, pendingContent } from "../src/core/rendering/pendingContent";
import { pendingCount } from "../src/core/rendering/range";
import { type LifecycleScope, lifecycleScope } from "../src/core/signals/lifecycleScope";
import { signal } from "../src/core/signals/signal";

// ---------------------------------------------------------------------------
// A cancelled readiness registration releases the enter WITHOUT enrolling
// content. Settling "done" without naming content infers it from the
// location (the children of an element); a cancellation must not, or the
// loading placeholder the location still shows is animated as if it were
// the committed content — and the enter then waits for its animation.
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
const q = (selector: string) => host.querySelector(selector);
const entering = () => host.querySelectorAll(".in").length;

/**
 * `when(on, () => Fragment([heading, region]))` with a class enter waiting for
 * content; `build(region)` registers what it needs. The heading's and the
 * region's own animations are finished at once, so the phase stays open only
 * for readiness.
 */
async function openPhase(build: (region: HTMLElement) => void) {
  const [on, setOn] = signal(false);
  host.appendChild(
    when(
      on,
      () => {
        const region = div({ class: "region" }, span({ class: "placeholder" }, "Loading…"));
        build(region);
        return Fragment([span({ class: "heading" }, "h"), region]);
      },
      { transition: { enterClass: "in", waitForContent: 2000 } },
    ),
  );
  await flush();
  setOn(true);
  end(q(".heading"));
  end(q(".region"));
  expect(entering()).toBe(2);
  return { setOn };
}

describe("cancel() releases readiness without enrolling content", () => {
  it("the placeholder a cancelled region still shows does not join, and the enter ends", async () => {
    let pending!: PendingContent;
    await openPhase((region) => {
      pending = pendingContent(region);
    });
    pending.cancel();
    await flush();
    expect(q(".placeholder")?.classList.contains("in")).toBe(false);
    // Nothing is left to wait for: the phase closed, and its classes are gone.
    expect(entering()).toBe(0);
    expect(pendingCount()).toBe(0);
  });

  it("done() without content still infers it from the location", async () => {
    let pending!: PendingContent;
    await openPhase((region) => {
      pending = pendingContent(region);
    });
    (q(".region") as HTMLElement).replaceChildren(span({ class: "row" }, "row"));
    pending.done();
    await flush();
    expect(q(".row")?.classList.contains("in")).toBe(true);
    end(q(".row"));
    expect(entering()).toBe(0);
  });

  it("a done(nodes) after cancel() does nothing: the first settlement wins", async () => {
    let pending!: PendingContent;
    await openPhase((region) => {
      pending = pendingContent(region);
    });
    const late = span({ class: "late" }, "late");
    (q(".region") as HTMLElement).append(late);
    pending.cancel();
    pending.done([late]);
    await flush();
    expect(late.classList.contains("in")).toBe(false);
    expect(pending.settled).toBe(true);
    expect(entering()).toBe(0);
  });

  it("done(nodes) names exactly what joins; a cancel() afterwards changes nothing", async () => {
    let pending!: PendingContent;
    await openPhase((region) => {
      pending = pendingContent(region);
    });
    const named = span({ class: "named" }, "n");
    (q(".region") as HTMLElement).append(named);
    pending.done([named]);
    pending.cancel();
    await flush();
    expect(named.classList.contains("in")).toBe(true);
    expect(q(".placeholder")?.classList.contains("in")).toBe(false);
  });

  it("with several registrations, a cancelled one enrolls nothing and the others still hold the enter", async () => {
    let first!: PendingContent;
    let second!: PendingContent;
    await openPhase((region) => {
      first = pendingContent(region);
      second = pendingContent(region);
    });
    first.cancel();
    await flush();
    expect(q(".placeholder")?.classList.contains("in")).toBe(false);
    // `second` still holds the phase open.
    expect(entering()).toBe(2);
    (q(".region") as HTMLElement).replaceChildren(span({ class: "row" }, "row"));
    second.done();
    await flush();
    expect(q(".row")?.classList.contains("in")).toBe(true);
    end(q(".row"));
    expect(entering()).toBe(0);
  });

  it("disposing the location cancels the same way: its placeholder does not join", async () => {
    let pending!: PendingContent;
    let slot!: HTMLElement;
    await openPhase((region) => {
      slot = div({ class: "slot" }, span({ class: "slot-placeholder" }, "…"));
      region.append(slot);
      pending = pendingContent(slot);
    });
    dispose(slot);
    expect(pending.settled).toBe(true);
    // A late completion of the disposed operation is stale.
    pending.done();
    await flush();
    expect(q(".slot-placeholder")?.classList.contains("in")).toBe(false);
    expect(entering()).toBe(0);
    expect(pendingCount()).toBe(0);
  });

  it("the end of the lifecycle a scope registration belongs to cancels it, and the enter ends", async () => {
    let pending!: PendingContent;
    let keepOpen!: PendingContent;
    let scope!: LifecycleScope;
    const [inner, setInner] = signal(true);
    await openPhase((region) => {
      // Holds the window open until the inner branch has rendered (a
      // microtask later) and registered on its scope.
      keepOpen = pendingContent(region);
      region.append(
        when(inner, () => {
          scope = lifecycleScope();
          pending = pendingContent(scope);
          return span({ class: "inner" }, "inner");
        }),
      );
    });
    await flush();
    keepOpen.cancel();
    await flush();
    // The scope registration (inside the branch) still holds it.
    expect(entering()).toBe(2);
    setInner(false);
    expect(scope.state()).toBe("ended");
    expect(pending.settled).toBe(true);
    await flush();
    expect(q(".placeholder")?.classList.contains("in")).toBe(false);
    expect(entering()).toBe(0);
    expect(pendingCount()).toBe(0);
  });
});
