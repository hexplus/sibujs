import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// Real-browser coverage for the published CDN artifacts.
//
// These run the built IIFEs the way a no-build page does — a <script> tag in a
// real browser — rather than in a Node vm. The vm tests in
// `tests/dist-artifacts.test.ts` cover the same surface and are the faster
// guard; what they cannot show is that the bundle works in the environment it
// exists for, which is the only environment it will ever run in.
//
// The chess example cannot cover `cdn.full.global.js` yet: it loads
// `sibujs@latest` from unpkg, and the full bundle does not exist on the CDN
// until this release publishes. Once it does, the example is the better home
// for this and `machine` there can come from `Sibu` instead of a local copy.
// ---------------------------------------------------------------------------

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const script = (file: string) => readFileSync(resolve(DIST, file), "utf8");

test("cdn.full.global.js exposes patterns and drives core reactivity", async ({ page }) => {
  await page.goto("about:blank");
  await page.addScriptTag({ content: script("cdn.full.global.js") });

  const result = await page.evaluate(() => {
    const Sibu = (window as unknown as { Sibu: Record<string, never> }).Sibu;
    const machine = Sibu.machine as unknown as (c: unknown) => { matches(s: string): boolean; send(e: string): void };
    const signal = Sibu.signal as unknown as <T>(v: T) => [() => T, (v: T) => void];
    const effect = Sibu.effect as unknown as (fn: () => void) => void;

    const flow = machine({
      initial: "idle",
      states: { idle: { on: { GO: "busy" } }, busy: { on: { DONE: "idle" } } },
    });

    // The point of the test: `machine` comes from the patterns half of the
    // bundle and its signal must be seen by an effect from the core half. Two
    // runtimes in one file would render once and then never update.
    const seen: boolean[] = [];
    effect(() => seen.push(flow.matches("busy")));
    flow.send("GO");

    // An event the current state does not declare is ignored, not a crash.
    flow.send("GO");

    const [n, setN] = signal(0);
    const nums: number[] = [];
    effect(() => nums.push(n()));
    setN(1);

    return {
      machineType: typeof Sibu.machine,
      namespace: typeof (Sibu.patterns as Record<string, unknown>).machine,
      transitions: seen,
      coreReactivity: nums,
      state: flow.matches("busy"),
    };
  });

  expect(result.machineType).toBe("function");
  expect(result.namespace).toBe("function");
  // Ran once at registration (idle), then again on the transition.
  expect(result.transitions).toEqual([false, true]);
  expect(result.coreReactivity).toEqual([0, 1]);
  expect(result.state).toBe(true);
});

test("cdn.global.js is the core bundle and carries no patterns", async ({ page }) => {
  // The other half of the split, asserted in a browser: the default artifact
  // every no-build page downloads must not have grown the patterns surface.
  await page.goto("about:blank");
  await page.addScriptTag({ content: script("cdn.global.js") });

  const surface = await page.evaluate(() => {
    const Sibu = (window as unknown as { Sibu: Record<string, unknown> }).Sibu;
    return {
      signal: typeof Sibu.signal,
      machine: typeof Sibu.machine,
      patterns: typeof Sibu.patterns,
    };
  });

  expect(surface.signal).toBe("function");
  expect(surface.machine).toBe("undefined");
  expect(surface.patterns).toBe("undefined");
});

test("neither production bundle validates props or asserts contracts", async ({ page }) => {
  // The diagnostics gate on a bare `__SIBU_DEV__` so a define folds them out
  // entirely. Verified here as BEHAVIOUR in a browser, because the artifact
  // tests' marker list is hand-maintained and missed this once already.
  await page.goto("about:blank");
  await page.addScriptTag({ content: script("cdn.full.global.js") });

  const warnings: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "warning") warnings.push(m.text());
  });

  const outcome = await page.evaluate(() => {
    const Sibu = (window as unknown as { Sibu: Record<string, never> }).Sibu;
    const validators = Sibu.validators as unknown as Record<string, unknown>;

    // A spy rather than a real validator: this proves the validation branch was
    // never entered, where "it did not warn" would also pass if it had run and
    // stayed quiet.
    let calls = 0;
    const spy = () => {
      calls += 1;
      return "always invalid";
    };
    (Sibu.validateProps as unknown as (p: object, s: object) => unknown)({ n: 1 }, { n: { type: spy, required: true } });

    const out = (Sibu.validateProps as unknown as (p: object, s: object) => Record<string, unknown>)(
      { n: "not a number" },
      { n: { type: validators.number, required: true } },
    );
    let threw = false;
    try {
      (Sibu.assertType as unknown as (v: unknown, val: unknown, l?: string) => void)("nope", validators.number, "n");
    } catch {
      threw = true;
    }
    return { value: out.n, threw, calls };
  });

  // Defaults still applied and the value untouched: only the checking is gone.
  expect(outcome.calls, "a validator ran in the production bundle").toBe(0);
  expect(outcome.value).toBe("not a number");
  expect(outcome.threw).toBe(false);
  expect(warnings).toEqual([]);
});
