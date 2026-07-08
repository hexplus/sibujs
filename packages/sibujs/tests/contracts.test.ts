import { describe, expect, it, vi } from "vitest";
import type { PropSchema } from "../src/patterns/contracts";
import { assertType, createGuard, defineStrictComponent, validateProps, validators } from "../src/patterns/contracts";

// ===========================================================================
// validators (built-in)
// ===========================================================================

describe("validators", () => {
  describe("string", () => {
    it("should return true for string values", () => {
      expect(validators.string("hello", "name")).toBe(true);
      expect(validators.string("", "name")).toBe(true);
    });

    it("should return error message for non-string values", () => {
      expect(validators.string(42, "name")).toBe("name must be a string, got number");
      expect(validators.string(null, "name")).toBe("name must be a string, got object");
    });
  });

  describe("number", () => {
    it("should return true for number values", () => {
      expect(validators.number(42, "age")).toBe(true);
      expect(validators.number(0, "age")).toBe(true);
      expect(validators.number(-1.5, "age")).toBe(true);
    });

    it("should return error message for non-number values", () => {
      expect(validators.number("42", "age")).toBe("age must be a number, got string");
    });
  });

  describe("boolean", () => {
    it("should return true for boolean values", () => {
      expect(validators.boolean(true, "active")).toBe(true);
      expect(validators.boolean(false, "active")).toBe(true);
    });

    it("should return error message for non-boolean values", () => {
      expect(validators.boolean(1, "active")).toBe("active must be a boolean, got number");
    });
  });

  describe("required", () => {
    it("should return true for non-null/undefined values", () => {
      expect(validators.required("hello", "name")).toBe(true);
      expect(validators.required(0, "count")).toBe(true);
      expect(validators.required(false, "flag")).toBe(true);
      expect(validators.required("", "text")).toBe(true);
    });

    it("should return error message for null or undefined", () => {
      expect(validators.required(null, "name")).toBe("name is required");
      expect(validators.required(undefined, "name")).toBe("name is required");
    });
  });

  describe("oneOf", () => {
    it("should return true when value is in the allowed set", () => {
      const v = validators.oneOf("small", "medium", "large");
      expect(v("small", "size")).toBe(true);
      expect(v("large", "size")).toBe(true);
    });

    it("should return error message when value is not in the set", () => {
      const v = validators.oneOf("small", "medium", "large");
      const result = v("xl" as unknown as "small" | "medium" | "large", "size");
      expect(result).toContain("must be one of");
      expect(result).toContain("small");
    });
  });

  describe("arrayOf", () => {
    it("should return true for valid typed arrays", () => {
      const v = validators.arrayOf(validators.number);
      expect(v([1, 2, 3], "scores")).toBe(true);
    });

    it("should return true for empty arrays", () => {
      const v = validators.arrayOf(validators.string);
      expect(v([], "tags")).toBe(true);
    });

    it("should return error when value is not an array", () => {
      const v = validators.arrayOf(validators.number);
      expect(v("not-array" as unknown as number[], "items")).toBe("items must be an array");
    });

    it("should return error for invalid array items with index", () => {
      const v = validators.arrayOf(validators.number);
      const result = v([1, "two", 3] as unknown as number[], "scores");
      expect(result).toContain("scores[1]");
      expect(result).toContain("number");
    });
  });

  describe("shape", () => {
    it("should return true for valid objects matching schema", () => {
      const v = validators.shape({
        name: validators.string,
        age: validators.number,
      });
      expect(v({ name: "Alice", age: 30 }, "user")).toBe(true);
    });

    it("should return error when value is not an object", () => {
      const v = validators.shape({ name: validators.string });
      expect(v(null as unknown as Record<string, unknown>, "user")).toBe("user must be an object");
      expect(v("string" as unknown as Record<string, unknown>, "user")).toBe("user must be an object");
    });

    it("should return nested error for invalid fields", () => {
      const v = validators.shape({
        name: validators.string,
        age: validators.number,
      });
      const result = v({ name: "Alice", age: "thirty" }, "user");
      expect(result).toContain("user.age");
      expect(result).toContain("number");
    });
  });

  describe("optional", () => {
    it("should return true for null or undefined values", () => {
      const v = validators.optional(validators.number);
      expect(v(null, "count")).toBe(true);
      expect(v(undefined, "count")).toBe(true);
    });

    it("should delegate to inner validator for non-null values", () => {
      const v = validators.optional(validators.number);
      expect(v(42, "count")).toBe(true);
      expect(v("not-number" as unknown as number, "count")).toContain("number");
    });
  });

  describe("range", () => {
    it("should return true for values within range", () => {
      const v = validators.range(1, 10);
      expect(v(1, "score")).toBe(true);
      expect(v(5, "score")).toBe(true);
      expect(v(10, "score")).toBe(true);
    });

    it("should return error for values outside range", () => {
      const v = validators.range(1, 10);
      const result = v(0, "score");
      expect(result).toContain("between 1 and 10");
    });

    it("should return error for non-number values", () => {
      const v = validators.range(0, 100);
      expect(v("50" as unknown as number, "score")).toContain("must be a number");
    });
  });

  describe("pattern", () => {
    it("should return true for strings matching the pattern", () => {
      const v = validators.pattern(/^[a-z]+$/);
      expect(v("hello", "slug")).toBe(true);
    });

    it("should return error for strings not matching the pattern", () => {
      const v = validators.pattern(/^[a-z]+$/);
      const result = v("Hello123", "slug");
      expect(result).toContain("must match pattern");
    });

    it("should return error for non-string values", () => {
      const v = validators.pattern(/^[0-9]+$/);
      expect(v(123 as unknown as string, "code")).toContain("must be a string");
    });
  });
});

// ===========================================================================
// validateProps
// ===========================================================================

describe("validateProps", () => {
  it("should pass through valid props unchanged", () => {
    const schema: PropSchema<{ name: string; age: number }> = {
      name: { type: validators.string },
      age: { type: validators.number },
    };
    const result = validateProps({ name: "Alice", age: 30 }, schema);
    expect(result).toEqual({ name: "Alice", age: 30 });
  });

  it("should apply default values for missing props", () => {
    const schema: PropSchema<{ name: string; color: string }> = {
      name: { type: validators.string },
      color: { type: validators.string, default: "blue" },
    };
    const result = validateProps({ name: "Alice" }, schema);
    expect(result.name).toBe("Alice");
    expect(result.color).toBe("blue");
  });

  it("should apply function defaults", () => {
    const schema: PropSchema<{ items: string[] }> = {
      items: { type: validators.array, default: () => ["a", "b"] },
    };
    const result = validateProps({}, schema);
    expect(result.items).toEqual(["a", "b"]);
  });

  it("should not overwrite provided props with defaults", () => {
    const schema: PropSchema<{ color: string }> = {
      color: { type: validators.string, default: "blue" },
    };
    const result = validateProps({ color: "red" }, schema);
    expect(result.color).toBe("red");
  });

  it("should warn on type validation errors in dev mode", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const schema: PropSchema<{ age: number }> = {
      age: { type: validators.number },
    };
    validateProps({ age: "not-a-number" as unknown as number }, schema);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain("Prop validation errors");
    expect(warnSpy.mock.calls[0][0]).toContain("number");
    warnSpy.mockRestore();
  });

  it("should warn on required prop missing", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const schema: PropSchema<{ name: string }> = {
      name: { type: validators.string, required: true },
    };
    validateProps({}, schema);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain("required");
    warnSpy.mockRestore();
  });

  it("should run custom validator", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const schema: PropSchema<{ age: number }> = {
      age: {
        type: validators.number,
        validator: validators.range(0, 150),
      },
    };
    validateProps({ age: 200 }, schema);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain("between 0 and 150");
    warnSpy.mockRestore();
  });

  it("should accept a bare validator function as shorthand", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const schema: PropSchema<{ name: string }> = {
      name: validators.string,
    };
    // Valid value -- no warning
    validateProps({ name: "Alice" }, schema);
    expect(warnSpy).not.toHaveBeenCalled();

    // Invalid value -- warning
    validateProps({ name: 123 as unknown as string }, schema);
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it("should not warn when props are valid", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const schema: PropSchema<{ count: number }> = {
      count: { type: validators.number, required: true },
    };
    validateProps({ count: 5 }, schema);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ===========================================================================
// defineStrictComponent
// ===========================================================================

describe("defineStrictComponent", () => {
  it("should create a component function that validates props", () => {
    const MyComponent = defineStrictComponent({
      name: "MyComponent",
      props: {
        label: { type: validators.string, required: true },
        count: { type: validators.number, default: 0 },
      },
      setup(props) {
        const el = document.createElement("div");
        el.textContent = `${props.label}: ${props.count}`;
        return el;
      },
    });

    expect(typeof MyComponent).toBe("function");
  });

  it("should return an HTMLElement from setup", () => {
    const MyComponent = defineStrictComponent({
      name: "MyComponent",
      props: {
        text: { type: validators.string, default: "default" },
      },
      setup(props) {
        const el = document.createElement("p");
        el.textContent = props.text;
        return el;
      },
    });

    const el = MyComponent({});
    expect(el).toBeInstanceOf(HTMLElement);
    expect(el.textContent).toBe("default");
  });

  it("should apply defaults to missing props", () => {
    const MyComponent = defineStrictComponent({
      name: "Counter",
      props: {
        initial: { type: validators.number, default: 10 },
      },
      setup(props) {
        const el = document.createElement("span");
        el.textContent = String(props.initial);
        return el;
      },
    });

    const el = MyComponent({});
    expect(el.textContent).toBe("10");
  });

  it("should use provided props over defaults", () => {
    const MyComponent = defineStrictComponent({
      name: "Counter",
      props: {
        initial: { type: validators.number, default: 10 },
      },
      setup(props) {
        const el = document.createElement("span");
        el.textContent = String(props.initial);
        return el;
      },
    });

    const el = MyComponent({ initial: 42 });
    expect(el.textContent).toBe("42");
  });

  it("should warn on invalid props", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const MyComponent = defineStrictComponent({
      name: "Greeter",
      props: {
        name: { type: validators.string, required: true },
      },
      setup(props) {
        const el = document.createElement("div");
        el.textContent = `Hello, ${props.name}`;
        return el;
      },
    });

    MyComponent({});
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain("required");
    warnSpy.mockRestore();
  });
});

// ===========================================================================
// assertType
// ===========================================================================

describe("assertType", () => {
  it("should not throw for valid values", () => {
    expect(() => assertType("hello", validators.string, "name")).not.toThrow();
    expect(() => assertType(42, validators.number, "age")).not.toThrow();
    expect(() => assertType(true, validators.boolean, "flag")).not.toThrow();
  });

  it("should throw TypeError for invalid values", () => {
    expect(() => assertType(42, validators.string, "name")).toThrow(TypeError);
    expect(() => assertType(42, validators.string, "name")).toThrow("[SibuJS Contract]");
  });

  it("should include the label in the error message", () => {
    expect(() => assertType(42, validators.string, "username")).toThrow("username");
  });

  it("should use default label 'value' when no label given", () => {
    expect(() => assertType(42, validators.string)).toThrow("value");
  });

  it("should work with composite validators", () => {
    const v = validators.oneOf("red", "green", "blue");
    expect(() => assertType("red", v, "color")).not.toThrow();
    expect(() => assertType("purple", v, "color")).toThrow("must be one of");
  });
});

// ===========================================================================
// createGuard
// ===========================================================================

describe("createGuard", () => {
  it("should return true for valid values", () => {
    const isString = createGuard(validators.string);
    expect(isString("hello")).toBe(true);
    expect(isString("")).toBe(true);
  });

  it("should return false for invalid values", () => {
    const isString = createGuard(validators.string);
    expect(isString(42)).toBe(false);
    expect(isString(null)).toBe(false);
    expect(isString(undefined)).toBe(false);
  });

  it("should work with number validator", () => {
    const isNumber = createGuard(validators.number);
    expect(isNumber(42)).toBe(true);
    expect(isNumber(0)).toBe(true);
    expect(isNumber("42")).toBe(false);
  });

  it("should work with composite validators", () => {
    const isSize = createGuard(validators.oneOf("small", "medium", "large"));
    expect(isSize("small")).toBe(true);
    expect(isSize("medium")).toBe(true);
    expect(isSize("xl")).toBe(false);
  });

  it("should work with shape validator", () => {
    const isUser = createGuard(
      validators.shape({
        name: validators.string,
        age: validators.number,
      }),
    );
    expect(isUser({ name: "Alice", age: 30 })).toBe(true);
    expect(isUser({ name: "Alice", age: "thirty" })).toBe(false);
    expect(isUser(null)).toBe(false);
    expect(isUser("not-object")).toBe(false);
  });
});
