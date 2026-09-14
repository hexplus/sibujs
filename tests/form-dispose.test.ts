import { afterEach, describe, expect, it } from "vitest";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";
import { getActiveDevTools, initDevTools } from "../src/devtools/devtools";
import { getSubscriberCount } from "../src/devtools/introspect";
import { form, required } from "../src/ui/form";

// ---------------------------------------------------------------------------
// form().dispose() releases the form's derived graph.
//
// A form creates one derived `error` per field plus five aggregates (`errors`,
// `isValid`, `isDirty`, `touched`, `values`). Before `dispose()` existed none of
// them could be released: a validator reading a caller-owned signal kept its
// subscription for as long as that signal lived, and DevTools kept every node.
// ---------------------------------------------------------------------------

type Hook = {
  nodes: Map<number, { type: string; ref: unknown }>;
  on: (event: string, fn: (payload: unknown) => void) => () => void;
};

const getHook = (): Hook => (globalThis as unknown as Record<string, Hook>).__SIBU_DEVTOOLS_GLOBAL_HOOK__;
const computedCount = (): number => [...getHook().nodes.values()].filter((n) => n.type === "computed").length;

afterEach(() => {
  getActiveDevTools()?.destroy();
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.__SIBU_DEVTOOLS_GLOBAL_HOOK__;
  delete g.__SIBU__;
  delete (window as unknown as Record<string, unknown>).__SIBU_DEVTOOLS__;
});

function buildForm(minAge: () => number) {
  return form({
    name: { initial: "", validators: [required()] },
    age: { initial: 20, validators: [(v: number) => (v < minAge() ? `Must be at least ${minAge()}` : null)] },
    tags: { initial: [] as string[] },
  });
}

function readAll(f: ReturnType<typeof buildForm>) {
  return {
    nameError: f.fields.name.error(),
    ageError: f.fields.age.error(),
    tagsError: f.fields.tags.error(),
    errors: f.errors(),
    isValid: f.isValid(),
    isDirty: f.isDirty(),
    touched: f.touched(),
    values: f.values(),
  };
}

describe("form().dispose()", () => {
  it("releases subscriptions on external signals read by validators", () => {
    const [minAge, setMinAge] = signal(18);
    const f = buildForm(minAge);
    readAll(f);
    expect(getSubscriberCount(minAge)).toBeGreaterThan(0);

    f.dispose();

    expect(getSubscriberCount(minAge)).toBe(0);
    setMinAge(30);
    expect(getSubscriberCount(minAge)).toBe(0);
  });

  it("releases the field value signals from every derived", () => {
    const f = buildForm(() => 18);
    readAll(f);
    expect(getSubscriberCount(f.fields.name.value)).toBeGreaterThan(0);

    f.dispose();

    expect(getSubscriberCount(f.fields.name.value)).toBe(0);
    expect(getSubscriberCount(f.fields.age.value)).toBe(0);
    expect(getSubscriberCount(f.fields.tags.value)).toBe(0);
  });

  it("emits computed:destroy for every field error and aggregate", () => {
    initDevTools();
    const destroyed: unknown[] = [];
    getHook().on("computed:destroy", (payload) => destroyed.push(payload));

    const f = buildForm(() => 18);
    // 3 field errors + 5 aggregates.
    expect(computedCount()).toBe(8);

    f.dispose();

    expect(destroyed).toHaveLength(8);
    expect(computedCount()).toBe(0);
  });

  it("is idempotent", () => {
    initDevTools();
    const destroyed: unknown[] = [];
    getHook().on("computed:destroy", (payload) => destroyed.push(payload));
    const f = buildForm(() => 18);

    f.dispose();
    expect(() => f.dispose()).not.toThrow();

    expect(destroyed).toHaveLength(8);
  });

  it("leaves accessors returning their last settled values without resubscribing", () => {
    const [minAge, setMinAge] = signal(18);
    const f = buildForm(minAge);
    f.fields.name.set("Ada");
    f.fields.name.touch();
    const before = readAll(f);
    expect(before.isValid).toBe(true);
    expect(before.isDirty).toBe(true);

    f.dispose();

    // Inputs keep changing, but the derived state stays frozen.
    setMinAge(99);
    f.fields.name.set("");
    f.fields.age.set(1);
    expect(readAll(f)).toEqual(before);
    expect(getSubscriberCount(minAge)).toBe(0);
    expect(getSubscriberCount(f.fields.name.value)).toBe(0);
    expect(getSubscriberCount(f.fields.age.value)).toBe(0);
  });

  it("does not wake effects that read disposed form state", () => {
    const f = buildForm(() => 18);
    const seen: boolean[] = [];
    const stop = effect(() => {
      seen.push(f.isValid());
    });
    expect(seen).toEqual([false]);

    f.dispose();
    f.fields.name.set("Ada");

    expect(seen).toEqual([false]);
    stop();
  });
});
