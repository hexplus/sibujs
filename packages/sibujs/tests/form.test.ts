import { describe, expect, it } from "vitest";
import { custom, email, form, matchesPattern, max, maxLength, min, minLength, required } from "../src/ui/form";

describe("form", () => {
  it("should initialize with field values", () => {
    const { fields, values } = form({
      name: { initial: "John" },
      age: { initial: 25 },
    });

    expect(fields.name.value()).toBe("John");
    expect(fields.age.value()).toBe(25);
    expect(values()).toEqual({ name: "John", age: 25 });
  });

  it("should validate required fields", () => {
    const { fields, isValid } = form({
      name: { initial: "", validators: [required()] },
    });

    expect(fields.name.error()).toBe("This field is required");
    expect(isValid()).toBe(false);

    fields.name.set("John");
    expect(fields.name.error()).toBeNull();
    expect(isValid()).toBe(true);
  });

  it("should validate minLength and maxLength", () => {
    const { fields } = form({
      password: { initial: "ab", validators: [minLength(3), maxLength(10)] },
    });

    expect(fields.password.error()).toBe("Must be at least 3 characters");
    fields.password.set("abc");
    expect(fields.password.error()).toBeNull();
    fields.password.set("a".repeat(11));
    expect(fields.password.error()).toBe("Must be at most 10 characters");
  });

  it("should validate email", () => {
    const { fields } = form({
      email: { initial: "bad", validators: [email()] },
    });

    expect(fields.email.error()).toBe("Invalid email address");
    fields.email.set("test@example.com");
    expect(fields.email.error()).toBeNull();
  });

  it("should track dirty state", () => {
    const { isDirty, fields } = form({
      name: { initial: "John" },
    });

    expect(isDirty()).toBe(false);
    fields.name.set("Jane");
    expect(isDirty()).toBe(true);
  });

  it("should track touched state", () => {
    const { fields } = form({
      name: { initial: "" },
    });

    expect(fields.name.touched()).toBe(false);
    fields.name.touch();
    expect(fields.name.touched()).toBe(true);
  });

  it("should reset form", () => {
    const { fields, reset } = form({
      name: { initial: "John" },
    });

    fields.name.set("Jane");
    expect(fields.name.value()).toBe("Jane");
    reset();
    expect(fields.name.value()).toBe("John");
  });

  it("should handle submit with validation", () => {
    let submitted = false;
    const { handleSubmit } = form({
      name: { initial: "John", validators: [required()] },
    });

    const onSubmit = handleSubmit((_values) => {
      submitted = true;
    });

    onSubmit();
    expect(submitted).toBe(true);
  });

  it("should validate min and max for numbers", () => {
    const { fields } = form({
      age: { initial: 5, validators: [min(10), max(100)] },
    });

    expect(fields.age.error()).toBe("Must be at least 10");
    fields.age.set(50);
    expect(fields.age.error()).toBeNull();
    fields.age.set(150);
    expect(fields.age.error()).toBe("Must be at most 100");
  });

  it("should validate with matchesPattern", () => {
    const { fields } = form({
      code: { initial: "abc", validators: [matchesPattern(/^\d+$/, "Digits only")] },
    });

    expect(fields.code.error()).toBe("Digits only");
    fields.code.set("123");
    expect(fields.code.error()).toBeNull();
  });

  it("should validate with custom validator", () => {
    const { fields } = form({
      name: { initial: "x", validators: [custom<string>((v) => v.length > 1, "Too short")] },
    });

    expect(fields.name.error()).toBe("Too short");
    fields.name.set("ok");
    expect(fields.name.error()).toBeNull();
  });
});
