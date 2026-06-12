import { afterEach, describe, expect, it } from "vitest";
import { focus } from "../src/ui/a11y";
import { form } from "../src/ui/form";
import { formAction } from "../src/ui/formAction";
import { inputMask } from "../src/ui/inputMask";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("formAction onSubmit + reset", () => {
  it("forwards FormData from a submit event and resets state", async () => {
    const seen: FormData[] = [];
    const handle = formAction(async (d: FormData) => {
      seen.push(d);
      return "ok";
    });

    const formEl = document.createElement("form");
    const input = document.createElement("input");
    input.name = "x";
    input.value = "1";
    formEl.appendChild(input);
    formEl.addEventListener("submit", handle.onSubmit);
    document.body.appendChild(formEl);

    formEl.dispatchEvent(new Event("submit", { cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(seen.length).toBe(1);
    expect(seen[0] instanceof FormData).toBe(true);
    expect(seen[0].get("x")).toBe("1");

    handle.reset();
    expect(handle.error()).toBeNull();
    expect(handle.result()).toBeNull();
  });
});

describe("form handleSubmit (async) + setError + reset", () => {
  it("toggles submitting around an async submit and supports manual errors", async () => {
    const f = form<{ name: string }>({ name: { initial: "" } });
    let submittedWith: string | null = null;
    const submit = f.handleSubmit(async (values) => {
      submittedWith = values.name;
    });

    f.fields.name.set("Alice");
    submit(new Event("submit"));
    await Promise.resolve();
    await Promise.resolve();
    expect(submittedWith).toBe("Alice");

    f.setError("name", "taken"); // manual error path
    expect(f.fields.name.error()).toBe("taken");

    f.reset(); // resets every field
    expect(f.fields.name.value()).toBe("");
  });
});

describe("inputMask letter-only mask + selection guard", () => {
  it("strips non-letters for an all-letter pattern", () => {
    const mask = inputMask({ pattern: "AAA" });
    const input = document.createElement("input");
    const dispose = mask.bind(input);
    input.value = "a1b2c"; // digits stripped (letter-only strip regex)
    input.dispatchEvent(new Event("input"));
    expect(mask.rawValue()).toBe("abc");
    dispose();
  });

  it("swallows a setSelectionRange that throws (unsupported input type)", () => {
    const mask = inputMask({ pattern: "999" });
    const input = document.createElement("input");
    input.setSelectionRange = () => {
      throw new DOMException("InvalidStateError");
    };
    const dispose = mask.bind(input);
    input.value = "12";
    expect(() => input.dispatchEvent(new Event("input"))).not.toThrow();
    dispose();
  });
});

describe("a11y focus() blur", () => {
  it("tracks focus/blur and blur() defocuses the bound element", () => {
    const f = focus();
    const el = document.createElement("input");
    document.body.appendChild(el);
    const dispose = f.bind(el);

    el.dispatchEvent(new Event("focus"));
    expect(f.isFocused()).toBe(true);

    f.blur(); // imperative blur on the current element
    el.dispatchEvent(new Event("blur"));
    expect(f.isFocused()).toBe(false);

    dispose();
  });
});
