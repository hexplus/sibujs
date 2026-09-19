import { it } from "vitest";
import { each } from "../../src/core/rendering/each";
import { div } from "../../src/core/rendering/html";
import { signal } from "../../src/core/signals/signal";
it("bench each 10k rows", async () => {
  const times: number[] = [];
  for (let round = 0; round < 7; round++) {
    const rows = Array.from({ length: 10_000 }, (_, i) => i);
    const [list] = signal(rows);
    const host = document.body.appendChild(document.createElement("div"));
    const t0 = performance.now();
    host.appendChild(each(() => list(), (item) => div({ class: () => `r${item()}` }, "x"), { key: (x) => x }));
    await Promise.resolve(); await Promise.resolve();
    times.push(performance.now() - t0);
    host.remove();
  }
  times.sort((a, b) => a - b);
  console.log("MEDIAN_MS", times[3].toFixed(1));
});
