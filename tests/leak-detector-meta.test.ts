/**
 * Meta-tests for the leak detector itself.
 *
 * The memory suite in `hardening-memory.test.ts` asserts that the live-binding
 * count returns to its baseline after mount/destroy cycles. That assertion is
 * only meaningful if the counter actually moves — if `checkLeaks()` were
 * inert (for example compiled out in a production build) every one of those
 * tests would pass while detecting nothing.
 *
 * These two tests keep the detector honest: one proves the counter increments
 * when a binding is registered, the other proves a deliberately leaked `each()`
 * range is reported as growth. If either fails, treat the memory suite's green
 * result as meaningless until the instrumentation is fixed.
 */
import { describe, expect, it } from "vitest";
import { checkLeaks, registerDisposer } from "../src/core/rendering/dispose";
import { each } from "../src/core/rendering/each";
import { div } from "../src/core/rendering/html";
import { signal } from "../src/core/signals/signal";

const tick = () => new Promise<void>((r) => queueMicrotask(() => r()));

describe("leak detector: instrumentation is live", () => {
  it("counts a newly registered binding", () => {
    const before = checkLeaks();
    const el = document.createElement("div");
    registerDisposer(el, () => {});
    expect(checkLeaks()).toBe(before + 1);
  });

  it("reports a deliberately leaked each() range as growth", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const before = checkLeaks();

    for (let i = 0; i < 10; i++) {
      const [items] = signal([{ id: 1 }, { id: 2 }]);
      const anchor = each(items, (item) => div(() => `${item().id}`) as Node, { key: (r) => r.id });
      host.appendChild(anchor);
      await tick();
      // Detach WITHOUT dispose() — the exact shape of the bug this pass fixed.
      anchor.remove();
      host.replaceChildren();
    }

    expect(checkLeaks()).toBeGreaterThan(before);
  });
});
