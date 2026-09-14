import { afterEach, describe, expect, it } from "vitest";
import { derived } from "../src/core/signals/derived";
import { signal } from "../src/core/signals/signal";
import { getActiveDevTools, initDevTools } from "../src/devtools/devtools";

type Hook = { nodes: Map<number, { type: string; ref: unknown }> };

const getHook = (): Hook => (globalThis as unknown as Record<string, Hook>).__SIBU_DEVTOOLS_GLOBAL_HOOK__;
const computedCount = (): number => [...getHook().nodes.values()].filter((n) => n.type === "computed").length;

afterEach(() => {
  getActiveDevTools()?.destroy();
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.__SIBU_DEVTOOLS_GLOBAL_HOOK__;
  delete g.__SIBU__;
  delete (window as unknown as Record<string, unknown>).__SIBU_DEVTOOLS__;
});

describe("derived().dispose() with DevTools attached", () => {
  it("removes disposed deriveds from the node inventory", () => {
    initDevTools();
    const [n] = signal(1);
    const flags = Array.from({ length: 50 }, (_, i) => derived(() => n() > i));
    expect(computedCount()).toBe(50);

    for (const flag of flags) flag.dispose();
    expect(computedCount()).toBe(0);

    // Idempotent disposal emits nothing that could remove an unrelated node.
    const survivor = derived(() => n() * 2);
    flags[0].dispose();
    expect(computedCount()).toBe(1);
    expect(
      [...getHook().nodes.values()].some((node) => node.ref === (survivor as never as { __signal: unknown }).__signal),
    ).toBe(true);
  });

  it("reports disposal to a hook attached after the derived was created", () => {
    const [n] = signal(1);
    const early = derived(() => n() + 1);
    initDevTools();
    const late = derived(() => n() + 2);
    expect(computedCount()).toBe(1);

    early.dispose();
    late.dispose();
    expect(computedCount()).toBe(0);
  });
});
