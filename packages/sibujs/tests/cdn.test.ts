import { afterEach, describe, expect, it } from "vitest";
import { cdnUrls, generateImportMap, registerGlobal, umdWrapper } from "../src/build/cdn";

describe("registerGlobal", () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).Sibu;
  });

  it("should register window.Sibu", () => {
    registerGlobal();
    expect((window as unknown as Record<string, unknown>).Sibu).toBeDefined();
    expect(typeof (window as unknown as Record<string, unknown>).Sibu).toBe("object");
  });

  it("should expose framework exports on window.Sibu", () => {
    registerGlobal();
    const sibu = (window as unknown as Record<string, Record<string, unknown>>).Sibu;
    // At minimum, core exports like signal and mount should be present
    expect(typeof sibu.signal).toBe("function");
    expect(typeof sibu.mount).toBe("function");
  });
});

describe("umdWrapper", () => {
  it("should generate a valid UMD wrapper string", () => {
    const factory = () => ({ hello: "world" });
    const result = umdWrapper("TestLib", factory);

    expect(typeof result).toBe("string");
    expect(result).toContain("TestLib");
    expect(result).toContain("define");
    expect(result).toContain("module.exports");
  });

  it("should include the AMD branch", () => {
    const result = umdWrapper("MyLib", () => ({}));
    expect(result).toContain("define.amd");
    expect(result).toContain("define([], factory)");
  });

  it("should include the CommonJS branch", () => {
    const result = umdWrapper("MyLib", () => ({}));
    expect(result).toContain("module.exports = factory()");
  });

  it("should include the browser globals branch", () => {
    const result = umdWrapper("MyLib", () => ({}));
    expect(result).toContain("root.MyLib = factory()");
  });

  it("should embed the factory function", () => {
    const factory = () => ({ version: "1.0.0" });
    const result = umdWrapper("Pkg", factory);
    expect(result).toContain("version");
  });
});

describe("cdnUrls", () => {
  it("should return correct unpkg URL with default version", () => {
    const url = cdnUrls.unpkg();
    expect(url).toBe("https://unpkg.com/sibu@latest/dist/cdn.global.js");
  });

  it("should return correct unpkg URL with specific version", () => {
    const url = cdnUrls.unpkg("1.2.3");
    expect(url).toBe("https://unpkg.com/sibu@1.2.3/dist/cdn.global.js");
  });

  it("should return correct jsdelivr URL with default version", () => {
    const url = cdnUrls.jsdelivr();
    expect(url).toBe("https://cdn.jsdelivr.net/npm/sibu@latest/dist/cdn.global.js");
  });

  it("should return correct jsdelivr URL with specific version", () => {
    const url = cdnUrls.jsdelivr("2.0.0");
    expect(url).toBe("https://cdn.jsdelivr.net/npm/sibu@2.0.0/dist/cdn.global.js");
  });

  it("should return correct skypack URL with default version", () => {
    const url = cdnUrls.skypack();
    expect(url).toBe("https://cdn.skypack.dev/sibu@latest");
  });

  it("should return correct skypack URL with specific version", () => {
    const url = cdnUrls.skypack("3.0.0");
    expect(url).toBe("https://cdn.skypack.dev/sibu@3.0.0");
  });

  it("should generate a valid script tag for jsdelivr", () => {
    const tag = cdnUrls.scriptTag("jsdelivr", "1.0.0");
    expect(tag).toBe('<script src="https://cdn.jsdelivr.net/npm/sibu@1.0.0/dist/cdn.global.js"></script>');
  });

  it("should generate a valid script tag for unpkg", () => {
    const tag = cdnUrls.scriptTag("unpkg");
    expect(tag).toContain("<script src=");
    expect(tag).toContain("unpkg.com");
    expect(tag).toContain("</script>");
  });

  it("should generate a module script tag for skypack", () => {
    const tag = cdnUrls.scriptTag("skypack");
    expect(tag).toContain('type="module"');
    expect(tag).toContain("import * as Sibu");
    expect(tag).toContain("cdn.skypack.dev");
  });

  it("should default to jsdelivr when no provider is specified", () => {
    const tag = cdnUrls.scriptTag();
    expect(tag).toContain("cdn.jsdelivr.net");
  });
});

describe("generateImportMap", () => {
  it("should generate import map with correct entries", () => {
    const map = generateImportMap();

    expect(map.imports).toBeDefined();
    expect(map.imports["sibu"]).toContain("/dist/index.js");
    expect(map.imports["sibu/core"]).toContain("/dist/core/index.js");
    expect(map.imports["sibu/reactivity"]).toContain("/dist/reactivity/index.js");
    expect(map.imports["sibu/plugins"]).toContain("/dist/plugins/index.js");
    expect(map.imports["sibu/components"]).toContain("/dist/components/index.js");
    expect(map.imports["sibu/testing"]).toContain("/dist/testing/index.js");
    expect(map.imports["sibu/build"]).toContain("/dist/build/index.js");
  });

  it("should use jsDelivr base URL by default", () => {
    const map = generateImportMap();
    expect(map.imports["sibu"]).toContain("cdn.jsdelivr.net");
  });

  it("should accept a custom base URL", () => {
    const map = generateImportMap("https://my-cdn.example.com/sibu@1.0.0");
    expect(map.imports["sibu"]).toBe("https://my-cdn.example.com/sibu@1.0.0/dist/index.js");
  });

  it("should return valid JSON from toJSON", () => {
    const map = generateImportMap();
    const json = map.toJSON();

    expect(() => JSON.parse(json)).not.toThrow();

    const parsed = JSON.parse(json);
    expect(parsed.imports).toBeDefined();
    expect(parsed.imports["sibu"]).toBe(map.imports["sibu"]);
  });

  it("should return a script element from toScriptTag", () => {
    const map = generateImportMap();
    const tag = map.toScriptTag();

    expect(tag).toContain('<script type="importmap">');
    expect(tag).toContain("</script>");
    expect(tag).toContain('"sibu"');

    // The content between the tags should be valid JSON
    const jsonContent = tag.replace('<script type="importmap">\n', "").replace("\n</script>", "");
    expect(() => JSON.parse(jsonContent)).not.toThrow();
  });
});
