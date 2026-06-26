import { afterEach, describe, expect, it } from "vitest";
import { option, select } from "../src/core/rendering/html";
import { signal } from "../src/core/signals/signal";
import { initDevTools } from "../src/devtools/devtools";
import { captureSignalGraph } from "../src/devtools/signalGraph";
import { type NormalizedSchema, normalize } from "../src/performance/normalize";
import { createAction } from "../src/platform/routeActions";
import { lazyModule } from "../src/plugins/modular";
import { createRouter, destroyRouter, navigate, route } from "../src/plugins/router";
import { bindField, form } from "../src/ui/form";
import { inputMask } from "../src/ui/inputMask";
import { pagination } from "../src/ui/pagination";

// Regression tests for the non-core audit follow-ups (TODO.md theme D).

describe("pagination — reactive clamp when totalItems shrinks (D9)", () => {
  it("clamps the current page and indices when the dataset shrinks", () => {
    const [total, setTotal] = signal(100);
    const p = pagination({ totalItems: () => total(), pageSize: 10 });

    p.goTo(8);
    expect(p.page()).toBe(8);
    expect(p.startIndex()).toBe(70);

    // Dataset shrinks to 2 pages while we're on page 8.
    setTotal(20);
    expect(p.totalPages()).toBe(2);
    expect(p.page()).toBe(2); // clamped, not stuck at 8
    expect(p.startIndex()).toBe(10); // points at valid data, not past the end
  });
});

describe("form — isDirty does not false-positive on array/object initials (D3)", () => {
  it("treats an unchanged multi-select array as not dirty", () => {
    const f = form({ tags: { initial: ["a", "b"] as string[] } });
    expect(f.isDirty()).toBe(false); // fresh array !== initial under Object.is

    f.fields.tags.set(["a", "c"]);
    expect(f.isDirty()).toBe(true);

    f.fields.tags.set(["a", "b"]); // structurally equal to the initial again
    expect(f.isDirty()).toBe(false);
  });
});

describe("inputMask — caret restoration for '*' masks with literals (D8)", () => {
  it("keeps the caret before the edited slot instead of jumping past the literal", () => {
    const mask = inputMask({ pattern: "**-**" });
    const input = document.createElement("input");
    document.body.appendChild(input);
    const dispose = mask.bind(input);

    input.value = "ab-cd";
    input.setSelectionRange(4, 4); // caret before "d" — 3 raw chars ("abc") precede it
    input.dispatchEvent(new Event("input"));

    expect(input.value).toBe("ab-cd");
    // The old algorithm counted the literal "-" as a raw char (rawCharTest was
    // `() => true` for "*" masks) and pushed the caret to 5 (end); it must stay at 4.
    expect(input.selectionStart).toBe(4);

    dispose();
    document.body.removeChild(input);
  });
});

describe("bindField — <select multiple> reactive write-back (D1)", () => {
  it("reflects the field's array onto option.selected, initially and on change", () => {
    const f = form({ tags: { initial: ["a", "c"] as string[] } });
    const el = select(bindField(f.fields.tags, { multiple: true }), [
      option({ value: "a" }, "A"),
      option({ value: "b" }, "B"),
      option({ value: "c" }, "C"),
    ]) as HTMLSelectElement;

    expect(el.multiple).toBe(true);
    // Initial render reflects the array initial onto the options.
    expect(Array.from(el.selectedOptions, (o) => o.value).sort()).toEqual(["a", "c"]);

    // Reactive write-back: updating the field re-selects the matching options.
    f.fields.tags.set(["b"]);
    expect(Array.from(el.selectedOptions, (o) => o.value)).toEqual(["b"]);

    f.fields.tags.set([]);
    expect(el.selectedOptions.length).toBe(0);
  });
});

describe("lazyModule — caches a loader that resolves to undefined/falsy (D11)", () => {
  it("invokes the loader only once even when it resolves to undefined", async () => {
    let calls = 0;
    const m = lazyModule(async () => {
      calls++;
      return undefined;
    });
    await m.get();
    await m.get();
    await m.get();
    expect(calls).toBe(1);
    expect(m.loaded).toBe(true);
  });
});

describe("normalize — child relations default to id, not the parent idKey (D12)", () => {
  it("normalizes a child with the default id key when the parent has a custom one", () => {
    const schema: NormalizedSchema = {
      name: "post",
      idKey: "postId",
      relations: { author: "user" },
    };
    const data = { postId: "p1", title: "Hello", author: { id: "u1", name: "Alice" } };

    const { entities } = normalize(data, schema);

    expect((entities.user as Record<string, unknown>).u1).toMatchObject({ id: "u1", name: "Alice" });
    // Before the fix the child reused the parent idKey ("postId") → String(undefined).
    expect((entities.user as Record<string, unknown>).undefined).toBeUndefined();
  });
});

describe("createAction — a slow older submit cannot clobber a newer one (D7)", () => {
  it("keeps the latest run's result even when an earlier run resolves later", async () => {
    let resolveFirst!: (v: string) => void;
    let resolveSecond!: (v: string) => void;

    const action = createAction<string>((input) => {
      const id = (input as { id: number }).id;
      return new Promise<string>((resolve) => {
        if (id === 1) resolveFirst = resolve;
        else resolveSecond = resolve;
      });
    });

    const p1 = action.submit({ id: 1 });
    const p2 = action.submit({ id: 2 });

    // The newer (second) submit resolves first.
    resolveSecond("second");
    await p2;
    expect(action.data()).toBe("second");
    expect(action.loading()).toBe(false);

    // The older (first) submit resolves late — it must NOT overwrite state.
    resolveFirst("first");
    await p1;
    expect(action.data()).toBe("second");
  });
});

describe("router — a broad param route does not shadow a more specific one (D16)", () => {
  afterEach(() => {
    try {
      destroyRouter();
    } catch {}
    window.history.replaceState({}, "", "/");
  });

  it("matches the more specific route even when the broad one is registered first", async () => {
    createRouter([
      // Broad two-param route registered FIRST — registration order used to win.
      { path: "/:section/:item", component: () => document.createElement("div") },
      // More specific (one static segment) route registered second.
      { path: "/users/:id", component: () => document.createElement("div") },
    ]);

    await navigate("/users/42");

    // Specificity wins: params come from "/users/:id", not "/:section/:item".
    expect(route().params).toEqual({ id: "42" });
  });
});

describe("captureSignalGraph — the real devtools hook exposes the node inventory (D4)", () => {
  afterEach(() => {
    delete (globalThis as unknown as Record<string, unknown>).__SIBU_DEVTOOLS_GLOBAL_HOOK__;
  });

  it("reports id/name/kind/value for tracked nodes (was always-empty before wiring)", () => {
    initDevTools();
    const hook = (
      globalThis as unknown as {
        __SIBU_DEVTOOLS_GLOBAL_HOOK__: { nodes: Map<number, unknown> };
      }
    ).__SIBU_DEVTOOLS_GLOBAL_HOOK__;

    hook.nodes.set(1, { id: 1, type: "signal", name: "count", ref: { value: 42, __sc: 1 }, createdAt: 0 });
    hook.nodes.set(2, { id: 2, type: "computed", name: "doubled", ref: { _v: 84, __sc: 0 }, createdAt: 0 });
    hook.nodes.set(3, { id: 3, type: "effect", name: "logger", ref: {}, createdAt: 0 });

    const snap = captureSignalGraph();
    const byId = Object.fromEntries(snap.nodes.map((n) => [n.id, n]));

    expect(byId["1"]).toMatchObject({ name: "count", kind: "signal", value: "42" });
    expect(byId["2"]).toMatchObject({ name: "doubled", kind: "derived", value: "84" }); // computed -> "derived"
    expect(byId["3"]).toMatchObject({ name: "logger", kind: "effect", value: "undefined" });

    // Edge identities aren't tracked by the lightweight registry → 0 edges.
    expect(snap.edgeCount).toBe(0);
  });
});
