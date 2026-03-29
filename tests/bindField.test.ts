import { describe, expect, it } from "vitest";
import { bindField, form, required } from "../src/ui/form";

describe("bindField", () => {
  it("should return value getter from the field", () => {
    const f = form({ name: { initial: "Alice" } });
    const props = bindField(f.fields.name);

    expect(props.value()).toBe("Alice");
    f.fields.name.set("Bob");
    expect(props.value()).toBe("Bob");
  });

  it("should update field on input event (text input)", () => {
    const f = form({ name: { initial: "" } });
    const props = bindField(f.fields.name);

    const event = new Event("input");
    Object.defineProperty(event, "target", {
      value: { type: "text", value: "typed" },
    });
    props.on.input(event);

    expect(f.fields.name.value()).toBe("typed");
  });

  it("should update field on input event (checkbox)", () => {
    const f = form({ agree: { initial: false } });
    const props = bindField(f.fields.agree);

    const event = new Event("input");
    Object.defineProperty(event, "target", {
      value: { type: "checkbox", checked: true, value: "on" },
    });
    props.on.input(event);

    expect(f.fields.agree.value()).toBe(true);
  });

  it("should update field on change event (select)", () => {
    const f = form({ color: { initial: "red" } });
    const props = bindField(f.fields.color);

    const event = new Event("change");
    Object.defineProperty(event, "target", {
      value: { value: "blue" },
    });
    props.on.change(event);

    expect(f.fields.color.value()).toBe("blue");
  });

  it("should update field on change event (checkbox)", () => {
    const f = form({ agree: { initial: false } });
    const props = bindField(f.fields.agree);

    const event = new Event("change");
    Object.defineProperty(event, "target", {
      value: { type: "checkbox", checked: true },
    });
    props.on.change(event);

    expect(f.fields.agree.value()).toBe(true);
  });

  it("should touch field on blur", () => {
    const f = form({ name: { initial: "", validators: [required()] } });
    const props = bindField(f.fields.name);

    expect(f.fields.name.touched()).toBe(false);
    props.on.blur();
    expect(f.fields.name.touched()).toBe(true);
  });

  it("should merge extras into returned props", () => {
    const f = form({ email: { initial: "" } });
    const props = bindField(f.fields.email, {
      type: "email",
      placeholder: "Enter email",
    });

    expect((props as Record<string, unknown>).type).toBe("email");
    expect((props as Record<string, unknown>).placeholder).toBe("Enter email");
  });

  it("should not let extras.value override field value", () => {
    const f = form({ name: { initial: "real" } });
    const props = bindField(f.fields.name, { value: "fake" });

    // The field value getter should win
    expect(props.value()).toBe("real");
  });

  it("should merge extras.on with field handlers", () => {
    const f = form({ name: { initial: "" } });
    let clickCalled = false;
    const props = bindField(f.fields.name, {
      on: {
        click: () => {
          clickCalled = true;
        },
      },
    });

    // Field handlers should still work
    const inputEvent = new Event("input");
    Object.defineProperty(inputEvent, "target", {
      value: { type: "text", value: "test" },
    });
    props.on.input(inputEvent);
    expect(f.fields.name.value()).toBe("test");

    // Extra handler should also be present
    const merged = props.on as Record<string, (e: Event) => void>;
    merged.click(new Event("click"));
    expect(clickCalled).toBe(true);
  });
});
