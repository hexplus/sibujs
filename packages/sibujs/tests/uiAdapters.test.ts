import { describe, expect, it } from "vitest";
import { antdAdapter } from "../src/ecosystem/ui/antd";
import { chakraAdapter } from "../src/ecosystem/ui/chakra";
import { materialAdapter } from "../src/ecosystem/ui/material";

describe("materialAdapter", () => {
  it("should have correct name", () => {
    expect(materialAdapter.name).toBe("material");
  });

  it("should have expected components", () => {
    expect(materialAdapter.components.Button).toBeTypeOf("function");
    expect(materialAdapter.components.Input).toBeTypeOf("function");
    expect(materialAdapter.components.Card).toBeTypeOf("function");
    expect(materialAdapter.components.Modal).toBeTypeOf("function");
    expect(materialAdapter.components.Chip).toBeTypeOf("function");
    expect(materialAdapter.components.List).toBeTypeOf("function");
    expect(materialAdapter.components.ListItem).toBeTypeOf("function");
  });

  it("should render Button with raised variant", () => {
    const el = materialAdapter.components.Button({ variant: "raised" });
    expect(el.tagName).toBe("BUTTON");
    expect(el.className).toBe("mdc-button mdc-button--raised");
  });

  it("should render Card with outlined variant", () => {
    const el = materialAdapter.components.Card({ variant: "outlined" });
    expect(el.tagName).toBe("DIV");
    expect(el.className).toBe("mdc-card mdc-card--outlined");
  });

  it("should render List as ul element", () => {
    const el = materialAdapter.components.List();
    expect(el.tagName).toBe("UL");
    expect(el.className).toBe("mdc-list");
  });
});

describe("antdAdapter", () => {
  it("should have correct name", () => {
    expect(antdAdapter.name).toBe("antd");
  });

  it("should have expected components", () => {
    expect(antdAdapter.components.Button).toBeTypeOf("function");
    expect(antdAdapter.components.Input).toBeTypeOf("function");
    expect(antdAdapter.components.Card).toBeTypeOf("function");
    expect(antdAdapter.components.Modal).toBeTypeOf("function");
    expect(antdAdapter.components.Tag).toBeTypeOf("function");
    expect(antdAdapter.components.Badge).toBeTypeOf("function");
    expect(antdAdapter.components.Avatar).toBeTypeOf("function");
  });

  it("should render Button with primary variant", () => {
    const el = antdAdapter.components.Button({ variant: "primary" });
    expect(el.tagName).toBe("BUTTON");
    expect(el.className).toBe("ant-btn ant-btn-primary");
  });

  it("should render Button with size", () => {
    const el = antdAdapter.components.Button({ size: "lg" });
    expect(el.className).toBe("ant-btn ant-btn-lg");
  });

  it("should render Tag with success variant", () => {
    const el = antdAdapter.components.Tag({ variant: "success" });
    expect(el.tagName).toBe("SPAN");
    expect(el.className).toBe("ant-tag ant-tag-success");
  });
});

describe("chakraAdapter", () => {
  it("should have correct name", () => {
    expect(chakraAdapter.name).toBe("chakra");
  });

  it("should have expected components", () => {
    expect(chakraAdapter.components.Button).toBeTypeOf("function");
    expect(chakraAdapter.components.Input).toBeTypeOf("function");
    expect(chakraAdapter.components.Card).toBeTypeOf("function");
    expect(chakraAdapter.components.Modal).toBeTypeOf("function");
    expect(chakraAdapter.components.Badge).toBeTypeOf("function");
    expect(chakraAdapter.components.Stack).toBeTypeOf("function");
  });

  it("should render Button with solid variant and size", () => {
    const el = chakraAdapter.components.Button({
      variant: "solid",
      size: "lg",
    });
    expect(el.tagName).toBe("BUTTON");
    expect(el.className).toBe("chakra-button chakra-button--solid chakra-button--lg");
  });

  it("should render Stack with horizontal variant", () => {
    const el = chakraAdapter.components.Stack({ variant: "horizontal" });
    expect(el.tagName).toBe("DIV");
    expect(el.className).toBe("chakra-stack chakra-stack--horizontal");
  });

  it("should render Input as input element", () => {
    const el = chakraAdapter.components.Input();
    expect(el.tagName).toBe("INPUT");
    expect(el.className).toBe("chakra-input");
  });
});
