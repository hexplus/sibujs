import { describe, expect, it } from "vitest";
import { type AdapterConfig, componentAdapter, createTheme } from "../src/ecosystem/ui/componentAdapter";

const testConfig: AdapterConfig = {
  name: "test-ui",
  prefix: "tui",
  components: {
    Button: {
      tag: "button",
      baseClass: "tui-button",
      variants: {
        primary: "tui-button--primary",
        outlined: "tui-button--outlined",
      },
      sizes: {
        sm: "tui-button--sm",
        lg: "tui-button--lg",
      },
      defaultProps: {
        type: "button",
      },
    },
    Card: {
      tag: "div",
      baseClass: "tui-card",
      variants: {
        elevated: "tui-card--elevated",
      },
    },
    Badge: {
      baseClass: "tui-badge",
    },
  },
};

describe("componentAdapter", () => {
  it("should return adapter with name and components", () => {
    const adapter = componentAdapter(testConfig);
    expect(adapter.name).toBe("test-ui");
    expect(adapter.components.Button).toBeTypeOf("function");
    expect(adapter.components.Card).toBeTypeOf("function");
    expect(adapter.components.Badge).toBeTypeOf("function");
  });

  it("should render Button with correct tag and base class", () => {
    const adapter = componentAdapter(testConfig);
    const el = adapter.components.Button();
    expect(el.tagName).toBe("BUTTON");
    expect(el.className).toBe("tui-button");
  });

  it("should apply variant class", () => {
    const adapter = componentAdapter(testConfig);
    const el = adapter.components.Button({ variant: "primary" });
    expect(el.className).toBe("tui-button tui-button--primary");
  });

  it("should apply size class", () => {
    const adapter = componentAdapter(testConfig);
    const el = adapter.components.Button({ size: "sm" });
    expect(el.className).toBe("tui-button tui-button--sm");
  });

  it("should apply both variant and size", () => {
    const adapter = componentAdapter(testConfig);
    const el = adapter.components.Button({ variant: "outlined", size: "lg" });
    expect(el.className).toBe("tui-button tui-button--outlined tui-button--lg");
  });

  it("should merge user class string", () => {
    const adapter = componentAdapter(testConfig);
    const el = adapter.components.Button({ class: "custom" });
    expect(el.className).toBe("tui-button custom");
  });

  it("should apply defaultProps", () => {
    const adapter = componentAdapter(testConfig);
    const el = adapter.components.Button() as HTMLButtonElement;
    expect(el.getAttribute("type")).toBe("button");
  });

  it("should render nodes", () => {
    const adapter = componentAdapter(testConfig);
    const el = adapter.components.Button({ nodes: "Click me" });
    expect(el.textContent).toBe("Click me");
  });

  it("should use div as default tag", () => {
    const adapter = componentAdapter(testConfig);
    const el = adapter.components.Badge();
    expect(el.tagName).toBe("DIV");
    expect(el.className).toBe("tui-badge");
  });

  it("should ignore unknown variant gracefully", () => {
    const adapter = componentAdapter(testConfig);
    const el = adapter.components.Button({ variant: "nonexistent" });
    expect(el.className).toBe("tui-button");
  });
});

describe("createTheme", () => {
  it("should resolve class with prefix", () => {
    const theme = createTheme({ prefix: "mdc" });
    expect(theme.resolveClass("button")).toBe("mdc-button");
  });

  it("should resolve class with variant", () => {
    const theme = createTheme({ prefix: "mdc" });
    expect(theme.resolveClass("button", "raised")).toBe("mdc-button mdc-button--raised");
  });

  it("should use classOverrides when available", () => {
    const theme = createTheme({
      prefix: "mdc",
      classOverrides: { "button-raised": "my-custom-raised" },
    });
    expect(theme.resolveClass("button", "raised")).toBe("my-custom-raised");
  });

  it("should update theme reactively", () => {
    const theme = createTheme({ prefix: "mdc" });
    expect(theme.config().prefix).toBe("mdc");
    theme.setTheme({ prefix: "ant" });
    expect(theme.config().prefix).toBe("ant");
  });
});
