import { describe, expect, it } from "vitest";
import { generateEslintConfig, lintRules, lintSource } from "../src/build/linting";

// ─── no-signals-in-conditionals ────────────────────────────────────────────────

describe("lintRules: no-signals-in-conditionals", () => {
  const rule = lintRules["no-signals-in-conditionals"];

  it("detects signal inside an if block", () => {
    const source = `
function MyComponent() {
  if (someCondition) {
    const [val, setVal] = signal(0);
  }
}`;
    const violations = rule.check(source);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].rule).toBe("no-signals-in-conditionals");
    expect(violations[0].message).toContain("signal");
    expect(violations[0].severity).toBe("error");
  });

  it("detects effect in a for loop", () => {
    const source = `
function MyComponent() {
  for (let i = 0; i < 5; i++) {
    effect(() => {});
  }
}`;
    const violations = rule.check(source);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.message.includes("effect"))).toBe(true);
  });

  it("detects signal function inside while loop", () => {
    const source = `
function MyComponent() {
  while (running) {
    const [x, setX] = signal(0);
  }
}`;
    const violations = rule.check(source);
    expect(violations.length).toBeGreaterThan(0);
  });

  it("passes for clean top-level signal usage", () => {
    const source = `
function MyComponent() {
  const [count, setCount] = signal(0);
  effect(() => {
    console.log(count());
  });
}`;
    const violations = rule.check(source);
    expect(violations).toHaveLength(0);
  });

  it("ignores signals in import statements", () => {
    const source = `import { signal } from 'sibujs';`;
    const violations = rule.check(source);
    expect(violations).toHaveLength(0);
  });

  it("detects inline conditional signal call on same line", () => {
    const source = `
function MyComponent() {
  if (cond) { signal(0); }
}`;
    const violations = rule.check(source);
    expect(violations.length).toBeGreaterThan(0);
  });
});

// ─── effect-cleanup ──────────────────────────────────────────────────────────

describe("lintRules: effect-cleanup", () => {
  const rule = lintRules["effect-cleanup"];

  it("warns when effect uses addEventListener without cleanup", () => {
    const source = `
effect(() => {
  window.addEventListener('resize', handler);
});`;
    const violations = rule.check(source);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].rule).toBe("effect-cleanup");
    expect(violations[0].severity).toBe("warning");
    expect(violations[0].message).toContain("addEventListener");
  });

  it("warns when effect uses setInterval without cleanup", () => {
    const source = `
effect(() => {
  setInterval(() => tick(), 1000);
});`;
    const violations = rule.check(source);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].message).toContain("setInterval");
  });

  it("passes when effect includes removeEventListener cleanup", () => {
    const source = `
effect(() => {
  window.addEventListener('resize', handler);
  return () => window.removeEventListener('resize', handler);
});`;
    const violations = rule.check(source);
    expect(violations).toHaveLength(0);
  });

  it("passes when effect includes clearInterval cleanup", () => {
    const source = `
effect(() => {
  const id = setInterval(() => tick(), 1000);
  return () => clearInterval(id);
});`;
    const violations = rule.check(source);
    expect(violations).toHaveLength(0);
  });

  it("passes for effect with no subscriptions", () => {
    const source = `
effect(() => {
  console.log('hello');
});`;
    const violations = rule.check(source);
    expect(violations).toHaveLength(0);
  });

  it("includes line and column information", () => {
    const source = `const x = 1;
effect(() => {
  window.addEventListener('click', handler);
});`;
    const violations = rule.check(source);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].line).toBeDefined();
    expect(typeof violations[0].line).toBe("number");
  });
});

// ─── no-direct-dom-mutation ──────────────────────────────────────────────────

describe("lintRules: no-direct-dom-mutation", () => {
  const rule = lintRules["no-direct-dom-mutation"];

  it("detects innerHTML assignment", () => {
    const source = `el.innerHTML = '<p>Hello</p>';`;
    const violations = rule.check(source);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].rule).toBe("no-direct-dom-mutation");
    expect(violations[0].message).toContain("innerHTML");
    expect(violations[0].severity).toBe("warning");
  });

  it("detects document.write", () => {
    const source = `document.write('<h1>Title</h1>');`;
    const violations = rule.check(source);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].message).toContain("document.write()");
  });

  it("detects outerHTML assignment", () => {
    const source = `el.outerHTML = '<div>replaced</div>';`;
    const violations = rule.check(source);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].message).toContain("outerHTML");
  });

  it("detects insertAdjacentHTML", () => {
    const source = `el.insertAdjacentHTML('beforeend', '<span>hi</span>');`;
    const violations = rule.check(source);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].message).toContain("insertAdjacentHTML");
  });

  it("passes for clean code without DOM mutations", () => {
    const source = `
const [name, setName] = signal('SibuJS');
const el = div({ nodes: () => name() });`;
    const violations = rule.check(source);
    expect(violations).toHaveLength(0);
  });

  it("skips comments", () => {
    const source = `// el.innerHTML = 'comment';`;
    const violations = rule.check(source);
    expect(violations).toHaveLength(0);
  });
});

// ─── each-requires-key ───────────────────────────────────────────────────────

describe("lintRules: each-requires-key", () => {
  const rule = lintRules["each-requires-key"];

  it("warns when each() has no key", () => {
    const source = `
each(
  () => items(),
  (item) => div({ nodes: item.name })
);`;
    const violations = rule.check(source);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].rule).toBe("each-requires-key");
    expect(violations[0].severity).toBe("warning");
    expect(violations[0].message).toContain("key");
  });

  it("passes when each() has a key option", () => {
    const source = `
each(
  () => items(),
  (item) => div({ nodes: item.name }),
  { key: (item) => item.id }
);`;
    const violations = rule.check(source);
    expect(violations).toHaveLength(0);
  });

  it("does not flag unrelated function calls", () => {
    const source = `
forEach(items, (item) => console.log(item));
someArray.forEach((x) => x);`;
    const violations = rule.check(source);
    expect(violations).toHaveLength(0);
  });
});

// ─── no-unused-state ─────────────────────────────────────────────────────────

describe("lintRules: no-unused-state", () => {
  const rule = lintRules["no-unused-state"];

  it("detects unused getter and setter", () => {
    const source = `
function MyComponent() {
  const [unused, setUnused] = signal(0);
  return div({ nodes: 'static' });
}`;
    const violations = rule.check(source);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].rule).toBe("no-unused-state");
    expect(violations[0].message).toContain("unused");
    expect(violations[0].message).toContain("setUnused");
    expect(violations[0].message).toContain("never used");
  });

  it("detects unused getter only (setter is used)", () => {
    const source = `
function MyComponent() {
  const [value, setValue] = signal(0);
  setValue(5);
  return div({ nodes: 'static' });
}`;
    const violations = rule.check(source);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].message).toContain("getter");
    expect(violations[0].message).toContain("never read");
  });

  it("detects unused setter only (getter is used)", () => {
    const source = `
function MyComponent() {
  const [count, setCount] = signal(0);
  return div({ nodes: () => String(count()) });
}`;
    const violations = rule.check(source);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0].message).toContain("setter");
    expect(violations[0].message).toContain("never called");
  });

  it("passes when both getter and setter are used", () => {
    const source = `
function MyComponent() {
  const [count, setCount] = signal(0);
  return div({
    nodes: () => String(count()),
    on: { click: () => setCount(count() + 1) }
  });
}`;
    const violations = rule.check(source);
    expect(violations).toHaveLength(0);
  });
});

// ─── lintSource ──────────────────────────────────────────────────────────────

describe("lintSource", () => {
  it("runs all rules by default", () => {
    const source = `
function Bad() {
  if (cond) {
    const [x, setX] = signal(0);
  }
  el.innerHTML = '<div></div>';
}`;
    const violations = lintSource(source);
    const ruleNames = new Set(violations.map((v) => v.rule));
    // Should have found violations from multiple rules
    expect(ruleNames.size).toBeGreaterThanOrEqual(2);
    expect(ruleNames.has("no-signals-in-conditionals")).toBe(true);
    expect(ruleNames.has("no-direct-dom-mutation")).toBe(true);
  });

  it("runs only selected rules when specified", () => {
    const source = `
el.innerHTML = '<div></div>';
if (cond) { signal(0); }`;
    const violations = lintSource(source, ["no-direct-dom-mutation"]);
    expect(violations.length).toBeGreaterThan(0);
    violations.forEach((v) => {
      expect(v.rule).toBe("no-direct-dom-mutation");
    });
  });

  it("returns violations sorted by line number", () => {
    const source = `el.innerHTML = 'line1';
document.write('line2');
el.outerHTML = 'line3';`;
    const violations = lintSource(source, ["no-direct-dom-mutation"]);
    expect(violations.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < violations.length; i++) {
      const prevLine = violations[i - 1].line ?? 0;
      const currLine = violations[i].line ?? 0;
      expect(currLine).toBeGreaterThanOrEqual(prevLine);
    }
  });

  it("returns empty array for clean source", () => {
    const source = `
function MyComponent() {
  const [count, setCount] = signal(0);
  effect(() => {
    console.log(count());
  });
  setCount(1);
  return div({ nodes: () => String(count()) });
}`;
    const violations = lintSource(source);
    expect(violations).toHaveLength(0);
  });
});

// ─── generateEslintConfig ────────────────────────────────────────────────────

describe("generateEslintConfig", () => {
  it("returns a config object with the sibujs plugin", () => {
    const config = generateEslintConfig();
    expect(config.plugins).toContain("sibujs");
  });

  it("includes rules with sibujs/ prefix", () => {
    const config = generateEslintConfig();
    const ruleKeys = Object.keys(config.rules);
    expect(ruleKeys.length).toBeGreaterThan(0);
    ruleKeys.forEach((key) => {
      expect(key.startsWith("sibujs/")).toBe(true);
    });
  });

  it("has all 5 lint rules configured", () => {
    const config = generateEslintConfig();
    const ruleKeys = Object.keys(config.rules);
    expect(ruleKeys).toContain("sibujs/no-signals-in-conditionals");
    expect(ruleKeys).toContain("sibujs/effect-cleanup");
    expect(ruleKeys).toContain("sibujs/no-direct-dom-mutation");
    expect(ruleKeys).toContain("sibujs/each-requires-key");
    expect(ruleKeys).toContain("sibujs/no-unused-state");
  });

  it("uses warning severity by default", () => {
    const config = generateEslintConfig();
    Object.values(config.rules).forEach((severity) => {
      expect(severity).toBe("warning");
    });
  });

  it("supports custom severity option", () => {
    const config = generateEslintConfig({ severity: "error" });
    Object.values(config.rules).forEach((severity) => {
      expect(severity).toBe("error");
    });
  });

  it("includes overrides for TS/JS file extensions", () => {
    const config = generateEslintConfig();
    expect(config.overrides).toBeDefined();
    expect(Array.isArray(config.overrides)).toBe(true);
    expect(config.overrides.length).toBeGreaterThan(0);
    const files = config.overrides[0].files;
    expect(files).toContain("*.ts");
    expect(files).toContain("*.tsx");
    expect(files).toContain("*.js");
    expect(files).toContain("*.jsx");
  });

  it("includes settings with sibujs version detect", () => {
    const config = generateEslintConfig();
    expect(config.settings).toBeDefined();
    expect(config.settings.sibujs.version).toBe("detect");
  });

  it("overrides contain the same rules as the top-level", () => {
    const config = generateEslintConfig();
    expect(config.overrides[0].rules).toEqual(config.rules);
  });
});

describe("no-signals-in-conditionals: nested-function false positives (regression)", () => {
  it("does not flag a top-level signal after an already-closed nested callback", () => {
    const src = [
      "function Counter() {",
      "  [1, 2].forEach((n) => { console.log(n); });",
      "  const [count, setCount] = signal(0);",
      "  return count;",
      "}",
    ].join("\n");
    const violations = lintSource(src, ["no-signals-in-conditionals"]);
    expect(violations.length).toBe(0);
  });

  it("still flags a signal genuinely inside a nested function", () => {
    const src = [
      "function Counter() {",
      "  function inner() {",
      "    const [c, setC] = signal(0);",
      "    return c;",
      "  }",
      "  return inner;",
      "}",
    ].join("\n");
    const violations = lintSource(src, ["no-signals-in-conditionals"]);
    expect(violations.some((v) => v.message.includes("nested function"))).toBe(true);
  });
});
