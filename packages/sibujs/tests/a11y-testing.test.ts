import { beforeEach, describe, expect, it } from "vitest";
import {
  type A11yCheckResult,
  type A11yViolation,
  assertA11y,
  checkA11y,
  checkAriaAttributes,
  checkColorContrast,
  checkFormLabels,
  checkHeadingHierarchy,
  checkImageAlt,
  checkKeyboardAccess,
  checkLandmarks,
  checkLinksAndButtons,
  checkListSemantics,
  checkTabOrder,
} from "../src/testing/a11y";

// Helper to create a root element with given HTML content
function html(markup: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = markup;
  document.body.appendChild(root);
  return root;
}

// Cleanup helper
function _cleanup(root: HTMLElement): void {
  root.remove();
}

// ──────────────────────────────────────────────────────────────────────────────
// checkImageAlt
// ──────────────────────────────────────────────────────────────────────────────

describe("checkImageAlt", () => {
  let root: HTMLElement;

  beforeEach(() => {
    root?.remove();
  });

  it("should report error for img without alt attribute", () => {
    root = html('<img src="photo.jpg">');
    const violations = checkImageAlt(root);

    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("image-alt");
    expect(violations[0].level).toBe("error");
    expect(violations[0].message).toContain("must have an alt attribute");
  });

  it("should report info for img with alt='' and no role", () => {
    root = html('<img src="decorative.jpg" alt="">');
    const violations = checkImageAlt(root);

    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("image-alt-empty");
    expect(violations[0].level).toBe("info");
    expect(violations[0].message).toContain("empty alt text");
  });

  it("should pass for img with meaningful alt text", () => {
    root = html('<img src="photo.jpg" alt="A scenic mountain view">');
    const violations = checkImageAlt(root);

    expect(violations).toHaveLength(0);
  });

  it("should not report info for img with alt='' and role='presentation'", () => {
    root = html('<img src="spacer.gif" alt="" role="presentation">');
    const violations = checkImageAlt(root);

    // No image-alt-empty info because it has a role
    const emptyAltInfos = violations.filter((v) => v.rule === "image-alt-empty");
    expect(emptyAltInfos).toHaveLength(0);
  });

  it("should report error for role='img' without accessible name", () => {
    root = html('<div role="img"></div>');
    const violations = checkImageAlt(root);

    const errors = violations.filter((v) => v.rule === "image-alt" && v.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('role="img"');
    expect(errors[0].message).toContain("accessible name");
  });

  it("should pass for role='img' with aria-label", () => {
    root = html('<div role="img" aria-label="Logo illustration"></div>');
    const violations = checkImageAlt(root);

    const errors = violations.filter((v) => v.rule === "image-alt" && v.level === "error");
    expect(errors).toHaveLength(0);
  });

  it("should handle multiple images with mixed compliance", () => {
    root = html(`
      <img src="a.jpg" alt="OK image">
      <img src="b.jpg">
      <img src="c.jpg" alt="">
    `);
    const violations = checkImageAlt(root);

    const errors = violations.filter((v) => v.level === "error");
    const infos = violations.filter((v) => v.level === "info");
    expect(errors).toHaveLength(1);
    expect(infos).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// checkFormLabels
// ──────────────────────────────────────────────────────────────────────────────

describe("checkFormLabels", () => {
  let root: HTMLElement;

  beforeEach(() => {
    root?.remove();
  });

  it("should report error for input without any label", () => {
    root = html('<input type="text">');
    const violations = checkFormLabels(root);

    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("form-label");
    expect(violations[0].level).toBe("error");
    expect(violations[0].message).toContain("must have an associated label");
  });

  it("should pass for input with aria-label", () => {
    root = html('<input type="text" aria-label="Username">');
    const violations = checkFormLabels(root);

    expect(violations).toHaveLength(0);
  });

  it("should pass for input with label[for=id]", () => {
    root = html(`
      <label for="email">Email</label>
      <input type="email" id="email">
    `);
    const violations = checkFormLabels(root);

    expect(violations).toHaveLength(0);
  });

  it("should pass for input wrapped in a label", () => {
    root = html(`
      <label>
        Name
        <input type="text">
      </label>
    `);
    const violations = checkFormLabels(root);

    expect(violations).toHaveLength(0);
  });

  it("should skip hidden inputs", () => {
    root = html('<input type="hidden" name="csrf" value="token123">');
    const violations = checkFormLabels(root);

    expect(violations).toHaveLength(0);
  });

  it("should skip submit, reset, and button type inputs", () => {
    root = html(`
      <input type="submit" value="Submit">
      <input type="reset" value="Reset">
      <input type="button" value="Click">
    `);
    const violations = checkFormLabels(root);

    expect(violations).toHaveLength(0);
  });

  it("should report error for select without label", () => {
    root = html(`
      <select>
        <option value="a">A</option>
        <option value="b">B</option>
      </select>
    `);
    const violations = checkFormLabels(root);

    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("form-label");
  });

  it("should report error for textarea without label", () => {
    root = html("<textarea></textarea>");
    const violations = checkFormLabels(root);

    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("form-label");
  });

  it("should pass for input with title attribute", () => {
    root = html('<input type="text" title="Search query">');
    const violations = checkFormLabels(root);

    expect(violations).toHaveLength(0);
  });

  it("should pass for input with aria-labelledby", () => {
    root = html(`
      <span id="lbl">Username</span>
      <input type="text" aria-labelledby="lbl">
    `);
    const violations = checkFormLabels(root);

    expect(violations).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// checkHeadingHierarchy
// ──────────────────────────────────────────────────────────────────────────────

describe("checkHeadingHierarchy", () => {
  let root: HTMLElement;

  beforeEach(() => {
    root?.remove();
  });

  it("should pass for proper h1 -> h2 -> h3 hierarchy", () => {
    root = html(`
      <h1>Title</h1>
      <h2>Subtitle</h2>
      <h3>Section</h3>
    `);
    const violations = checkHeadingHierarchy(root);

    expect(violations).toHaveLength(0);
  });

  it("should report error for skipped levels h1 -> h3", () => {
    root = html(`
      <h1>Title</h1>
      <h3>Skipped h2</h3>
    `);
    const violations = checkHeadingHierarchy(root);

    const errors = violations.filter((v) => v.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].rule).toBe("heading-order");
    expect(errors[0].message).toContain("Heading level skipped");
    expect(errors[0].message).toContain("h3");
  });

  it("should report warning when first heading is not h1", () => {
    root = html("<h2>Starting with h2</h2>");
    const violations = checkHeadingHierarchy(root);

    const warnings = violations.filter((v) => v.level === "warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].rule).toBe("heading-order");
    expect(warnings[0].message).toContain("should start with h1");
  });

  it("should report error for empty heading", () => {
    root = html("<h1></h1>");
    const violations = checkHeadingHierarchy(root);

    const errors = violations.filter((v) => v.rule === "heading-empty");
    expect(errors).toHaveLength(1);
    expect(errors[0].level).toBe("error");
    expect(errors[0].message).toContain("is empty");
  });

  it("should report no violations when there are no headings", () => {
    root = html("<p>No headings here</p>");
    const violations = checkHeadingHierarchy(root);

    expect(violations).toHaveLength(0);
  });

  it("should allow same-level and going back to higher levels", () => {
    root = html(`
      <h1>Title</h1>
      <h2>Section A</h2>
      <h2>Section B</h2>
      <h1>Another Title</h1>
    `);
    const violations = checkHeadingHierarchy(root);

    expect(violations).toHaveLength(0);
  });

  it("should detect both skipped level and empty heading", () => {
    root = html(`
      <h1>Title</h1>
      <h4></h4>
    `);
    const violations = checkHeadingHierarchy(root);

    const errors = violations.filter((v) => v.level === "error");
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors.some((v) => v.rule === "heading-order")).toBe(true);
    expect(errors.some((v) => v.rule === "heading-empty")).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// checkColorContrast
// ──────────────────────────────────────────────────────────────────────────────

describe("checkColorContrast", () => {
  let root: HTMLElement;

  beforeEach(() => {
    root?.remove();
  });

  it("should warn when inline color is set without background", () => {
    root = html('<p style="color: red;">Red text</p>');
    const violations = checkColorContrast(root);

    const warnings = violations.filter((v) => v.rule === "color-contrast");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].level).toBe("warning");
    expect(warnings[0].message).toContain("text color but not background");
  });

  it("should warn when background is set without text color", () => {
    root = html('<p style="background-color: yellow;">Highlighted</p>');
    const violations = checkColorContrast(root);

    const warnings = violations.filter((v) => v.rule === "color-contrast");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].level).toBe("warning");
    expect(warnings[0].message).toContain("background color but not text color");
  });

  it("should not warn when both color and background are set", () => {
    root = html('<p style="color: white; background-color: black;">Good contrast</p>');
    const violations = checkColorContrast(root);

    const colorWarnings = violations.filter((v) => v.rule === "color-contrast");
    expect(colorWarnings).toHaveLength(0);
  });

  it("should report error for role element without accessible name", () => {
    root = html('<div role="button"></div>');
    const violations = checkColorContrast(root);

    const errors = violations.filter((v) => v.rule === "accessible-name");
    expect(errors).toHaveLength(1);
    expect(errors[0].level).toBe("error");
    expect(errors[0].message).toContain('role="button"');
    expect(errors[0].message).toContain("accessible name");
  });

  it("should pass for role element with aria-label", () => {
    root = html('<div role="button" aria-label="Close dialog"></div>');
    const violations = checkColorContrast(root);

    const errors = violations.filter((v) => v.rule === "accessible-name");
    expect(errors).toHaveLength(0);
  });

  it("should skip presentation/none roles", () => {
    root = html('<div role="presentation"></div><div role="none"></div>');
    const violations = checkColorContrast(root);

    const errors = violations.filter((v) => v.rule === "accessible-name");
    expect(errors).toHaveLength(0);
  });

  it("should not warn on elements without text content", () => {
    root = html('<div style="color: red;"></div>');
    const violations = checkColorContrast(root);

    const colorWarnings = violations.filter((v) => v.rule === "color-contrast");
    expect(colorWarnings).toHaveLength(0);
  });

  it("should handle background shorthand property", () => {
    root = html('<p style="background: #f00;">Text</p>');
    const violations = checkColorContrast(root);

    const colorWarnings = violations.filter((v) => v.rule === "color-contrast");
    expect(colorWarnings).toHaveLength(1);
    expect(colorWarnings[0].message).toContain("background color but not text color");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// checkKeyboardAccess
// ──────────────────────────────────────────────────────────────────────────────

describe("checkKeyboardAccess", () => {
  let root: HTMLElement;

  beforeEach(() => {
    root?.remove();
  });

  it("should report error for onclick without tabindex", () => {
    root = html('<div onclick="doSomething()">Click me</div>');
    const violations = checkKeyboardAccess(root);

    const errors = violations.filter((v) => v.level === "error" && v.message.includes("tabindex"));
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].rule).toBe("keyboard-access");
  });

  it("should report warning for onclick without role", () => {
    root = html('<div onclick="doSomething()" tabindex="0" onkeydown="handleKey()">Click</div>');
    const violations = checkKeyboardAccess(root);

    const warnings = violations.filter((v) => v.level === "warning" && v.message.includes("role"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0].rule).toBe("keyboard-access");
  });

  it("should report error for onclick without keyboard handler", () => {
    root = html('<div onclick="doSomething()" tabindex="0" role="button">Click</div>');
    const violations = checkKeyboardAccess(root);

    const errors = violations.filter((v) => v.level === "error" && v.message.includes("keyboard event handler"));
    expect(errors).toHaveLength(1);
  });

  it("should report error for role='button' without tabindex", () => {
    root = html('<div role="button">Click me</div>');
    const violations = checkKeyboardAccess(root);

    const errors = violations.filter(
      (v) => v.level === "error" && v.message.includes('role="button"') && v.message.includes("tabindex"),
    );
    expect(errors).toHaveLength(1);
  });

  it("should not report for natively interactive elements", () => {
    root = html(`
      <button onclick="doSomething()">Native button</button>
      <a href="#" onclick="doSomething()">Native link</a>
      <input type="text" onclick="doSomething()">
    `);
    const violations = checkKeyboardAccess(root);

    // Native interactive elements should be skipped
    const keyboardErrors = violations.filter((v) => v.rule === "keyboard-access");
    expect(keyboardErrors).toHaveLength(0);
  });

  it("should not flag native button with role='button'", () => {
    root = html('<button role="button">OK</button>');
    const violations = checkKeyboardAccess(root);

    const keyboardErrors = violations.filter((v) => v.rule === "keyboard-access");
    expect(keyboardErrors).toHaveLength(0);
  });

  it("should report error for role='link' without tabindex on non-interactive", () => {
    root = html('<span role="link">Go somewhere</span>');
    const violations = checkKeyboardAccess(root);

    const errors = violations.filter((v) => v.level === "error" && v.message.includes('role="link"'));
    expect(errors).toHaveLength(1);
  });

  it("should report error for role='tab' without tabindex", () => {
    root = html('<div role="tab">Tab 1</div>');
    const violations = checkKeyboardAccess(root);

    const errors = violations.filter((v) => v.level === "error" && v.message.includes('role="tab"'));
    expect(errors).toHaveLength(1);
  });

  it("should pass for fully accessible onclick element", () => {
    root = html('<div onclick="doSomething()" tabindex="0" role="button" onkeydown="handleKey()">Click</div>');
    const violations = checkKeyboardAccess(root);

    expect(violations).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// checkAriaAttributes
// ──────────────────────────────────────────────────────────────────────────────

describe("checkAriaAttributes", () => {
  let root: HTMLElement;

  beforeEach(() => {
    root?.remove();
  });

  it("should report error for invalid ARIA role", () => {
    root = html('<div role="banana">Content</div>');
    const violations = checkAriaAttributes(root);

    const errors = violations.filter((v) => v.rule === "aria-valid-role");
    expect(errors).toHaveLength(1);
    expect(errors[0].level).toBe("error");
    expect(errors[0].message).toContain('"banana"');
  });

  it("should pass for valid ARIA role", () => {
    root = html('<div role="navigation">Nav</div>');
    const violations = checkAriaAttributes(root);

    const roleErrors = violations.filter((v) => v.rule === "aria-valid-role");
    expect(roleErrors).toHaveLength(0);
  });

  it("should report error for missing required aria props", () => {
    root = html('<div role="checkbox">Check me</div>');
    const violations = checkAriaAttributes(root);

    const errors = violations.filter((v) => v.rule === "aria-required-attr");
    expect(errors).toHaveLength(1);
    expect(errors[0].level).toBe("error");
    expect(errors[0].message).toContain("aria-checked");
  });

  it("should pass for role with all required aria props", () => {
    root = html('<div role="checkbox" aria-checked="false">Check</div>');
    const violations = checkAriaAttributes(root);

    const requiredAttrErrors = violations.filter((v) => v.rule === "aria-required-attr");
    expect(requiredAttrErrors).toHaveLength(0);
  });

  it("should report error for invalid aria attribute name", () => {
    root = html('<div aria-fakeprop="yes">Content</div>');
    const violations = checkAriaAttributes(root);

    const errors = violations.filter((v) => v.rule === "aria-valid-attr");
    expect(errors).toHaveLength(1);
    expect(errors[0].level).toBe("error");
    expect(errors[0].message).toContain('"aria-fakeprop"');
  });

  it("should report error for aria-labelledby referencing nonexistent id", () => {
    root = html('<div aria-labelledby="nonexistent-id">Content</div>');
    const violations = checkAriaAttributes(root);

    const errors = violations.filter((v) => v.rule === "aria-valid-attr-value");
    expect(errors).toHaveLength(1);
    expect(errors[0].level).toBe("error");
    expect(errors[0].message).toContain("nonexistent-id");
    expect(errors[0].message).toContain("does not exist");
  });

  it("should pass for aria-labelledby referencing existing id", () => {
    root = html(`
      <span id="label-text">Description</span>
      <div aria-labelledby="label-text">Content</div>
    `);
    const violations = checkAriaAttributes(root);

    const refErrors = violations.filter(
      (v) => v.rule === "aria-valid-attr-value" && v.message.includes("does not exist"),
    );
    expect(refErrors).toHaveLength(0);
  });

  it("should report error for boolean aria attr with invalid value", () => {
    root = html('<div aria-hidden="yes">Hidden content</div>');
    const violations = checkAriaAttributes(root);

    const errors = violations.filter((v) => v.rule === "aria-valid-attr-value" && v.message.includes("aria-hidden"));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('"yes"');
    expect(errors[0].message).toContain("true, false");
  });

  it("should pass for boolean aria attr with valid values", () => {
    root = html(`
      <div aria-hidden="true">Hidden</div>
      <div aria-expanded="false">Collapsed</div>
      <div aria-checked="mixed">Indeterminate</div>
    `);
    const violations = checkAriaAttributes(root);

    const booleanErrors = violations.filter(
      (v) =>
        v.rule === "aria-valid-attr-value" &&
        (v.message.includes("aria-hidden") ||
          v.message.includes("aria-expanded") ||
          v.message.includes("aria-checked")),
    );
    expect(booleanErrors).toHaveLength(0);
  });

  it("should report error for aria-controls referencing nonexistent id", () => {
    root = html('<div aria-controls="missing-panel">Toggle</div>');
    const violations = checkAriaAttributes(root);

    const errors = violations.filter((v) => v.rule === "aria-valid-attr-value" && v.message.includes("missing-panel"));
    expect(errors).toHaveLength(1);
  });

  it("should require multiple aria props for roles that need them", () => {
    root = html('<div role="scrollbar">Scroll</div>');
    const violations = checkAriaAttributes(root);

    const errors = violations.filter((v) => v.rule === "aria-required-attr");
    // scrollbar requires aria-controls and aria-valuenow
    expect(errors).toHaveLength(2);
    const messages = errors.map((e) => e.message);
    expect(messages.some((m) => m.includes("aria-controls"))).toBe(true);
    expect(messages.some((m) => m.includes("aria-valuenow"))).toBe(true);
  });

  it("should accept 'mixed' value for aria-pressed", () => {
    root = html('<button aria-pressed="mixed">Toggle</button>');
    const violations = checkAriaAttributes(root);

    const boolErrors = violations.filter(
      (v) => v.rule === "aria-valid-attr-value" && v.message.includes("aria-pressed"),
    );
    expect(boolErrors).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// checkLandmarks
// ──────────────────────────────────────────────────────────────────────────────

describe("checkLandmarks", () => {
  let root: HTMLElement;

  beforeEach(() => {
    root?.remove();
  });

  it("should warn when no main landmark is present", () => {
    root = html("<div><p>Content without landmarks</p></div>");
    const violations = checkLandmarks(root);

    const warnings = violations.filter((v) => v.rule === "landmark-main");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].level).toBe("warning");
    expect(warnings[0].message).toContain("main landmark");
  });

  it("should not warn when <main> element is present", () => {
    root = html("<main><p>Main content</p></main>");
    const violations = checkLandmarks(root);

    const mainWarnings = violations.filter((v) => v.rule === "landmark-main");
    expect(mainWarnings).toHaveLength(0);
  });

  it("should not warn when role='main' is present", () => {
    root = html('<div role="main"><p>Main content</p></div>');
    const violations = checkLandmarks(root);

    const mainWarnings = violations.filter((v) => v.rule === "landmark-main");
    expect(mainWarnings).toHaveLength(0);
  });

  it("should report error for multiple main landmarks", () => {
    root = html(`
      <main>First main</main>
      <main>Second main</main>
    `);
    const violations = checkLandmarks(root);

    const errors = violations.filter((v) => v.rule === "landmark-unique" && v.message.includes("main"));
    expect(errors).toHaveLength(1);
    expect(errors[0].level).toBe("error");
    expect(errors[0].message).toContain("Multiple main landmarks");
  });

  it("should report error for mixed main element and role='main'", () => {
    root = html(`
      <main>Native main</main>
      <div role="main">Role main</div>
    `);
    const violations = checkLandmarks(root);

    const errors = violations.filter((v) => v.rule === "landmark-unique" && v.message.includes("main"));
    expect(errors).toHaveLength(1);
  });

  it("should warn for multiple navs without labels", () => {
    root = html(`
      <main>Content</main>
      <nav>Primary nav</nav>
      <nav>Secondary nav</nav>
    `);
    const violations = checkLandmarks(root);

    const warnings = violations.filter((v) => v.rule === "landmark-label");
    expect(warnings).toHaveLength(2);
    expect(warnings[0].level).toBe("warning");
    expect(warnings[0].message).toContain("unique label");
  });

  it("should not warn for multiple navs when all have labels", () => {
    root = html(`
      <main>Content</main>
      <nav aria-label="Primary">Primary nav</nav>
      <nav aria-label="Secondary">Secondary nav</nav>
    `);
    const violations = checkLandmarks(root);

    const navWarnings = violations.filter((v) => v.rule === "landmark-label");
    expect(navWarnings).toHaveLength(0);
  });

  it("should not warn for a single nav without label", () => {
    root = html(`
      <main>Content</main>
      <nav>Only one nav</nav>
    `);
    const violations = checkLandmarks(root);

    const navWarnings = violations.filter((v) => v.rule === "landmark-label");
    expect(navWarnings).toHaveLength(0);
  });

  it("should warn for multiple banners", () => {
    root = html(`
      <main>Content</main>
      <header>Header 1</header>
      <header>Header 2</header>
    `);
    const violations = checkLandmarks(root);

    const warnings = violations.filter((v) => v.rule === "landmark-unique" && v.message.includes("banner"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0].level).toBe("warning");
  });

  it("should warn for multiple contentinfo (footer) landmarks", () => {
    root = html(`
      <main>Content</main>
      <footer>Footer 1</footer>
      <footer>Footer 2</footer>
    `);
    const violations = checkLandmarks(root);

    const warnings = violations.filter((v) => v.rule === "landmark-unique" && v.message.includes("contentinfo"));
    expect(warnings).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// checkLinksAndButtons
// ──────────────────────────────────────────────────────────────────────────────

describe("checkLinksAndButtons", () => {
  let root: HTMLElement;

  beforeEach(() => {
    root?.remove();
  });

  it("should report error for link without text", () => {
    root = html('<a href="/page"></a>');
    const violations = checkLinksAndButtons(root);

    const errors = violations.filter((v) => v.rule === "link-name");
    expect(errors).toHaveLength(1);
    expect(errors[0].level).toBe("error");
    expect(errors[0].message).toContain("discernible text");
  });

  it("should pass for link with text content", () => {
    root = html('<a href="/page">Go to page</a>');
    const violations = checkLinksAndButtons(root);

    const linkNameErrors = violations.filter((v) => v.rule === "link-name");
    expect(linkNameErrors).toHaveLength(0);
  });

  it("should pass for link with aria-label", () => {
    root = html('<a href="/page" aria-label="Navigate to page"></a>');
    const violations = checkLinksAndButtons(root);

    const linkNameErrors = violations.filter((v) => v.rule === "link-name");
    expect(linkNameErrors).toHaveLength(0);
  });

  it("should warn for link with target='_blank'", () => {
    root = html('<a href="https://example.com" target="_blank">External</a>');
    const violations = checkLinksAndButtons(root);

    const warnings = violations.filter((v) => v.rule === "link-new-window");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].level).toBe("warning");
    expect(warnings[0].message).toContain("new window");
  });

  it("should warn for target='_blank' without rel='noopener'", () => {
    root = html('<a href="https://example.com" target="_blank">External</a>');
    const violations = checkLinksAndButtons(root);

    const securityWarnings = violations.filter((v) => v.rule === "link-noopener");
    expect(securityWarnings).toHaveLength(1);
    expect(securityWarnings[0].message).toContain("noopener");
  });

  it("should not warn about noopener when rel='noopener' is present", () => {
    root = html('<a href="https://example.com" target="_blank" rel="noopener">External</a>');
    const violations = checkLinksAndButtons(root);

    const securityWarnings = violations.filter((v) => v.rule === "link-noopener");
    expect(securityWarnings).toHaveLength(0);
  });

  it("should warn for generic link text like 'click here'", () => {
    root = html('<a href="/page">click here</a>');
    const violations = checkLinksAndButtons(root);

    const warnings = violations.filter((v) => v.rule === "link-purpose");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].level).toBe("warning");
    expect(warnings[0].message).toContain("generic");
  });

  it("should warn for other generic link texts", () => {
    root = html(`
      <a href="/a">here</a>
      <a href="/b">read more</a>
      <a href="/c">more</a>
      <a href="/d">learn more</a>
      <a href="/e">link</a>
    `);
    const violations = checkLinksAndButtons(root);

    const purposeWarnings = violations.filter((v) => v.rule === "link-purpose");
    expect(purposeWarnings).toHaveLength(5);
  });

  it("should report error for button without accessible name", () => {
    root = html("<button></button>");
    const violations = checkLinksAndButtons(root);

    const errors = violations.filter((v) => v.rule === "button-name");
    expect(errors).toHaveLength(1);
    expect(errors[0].level).toBe("error");
    expect(errors[0].message).toContain("accessible name");
  });

  it("should pass for button with text content", () => {
    root = html("<button>Submit</button>");
    const violations = checkLinksAndButtons(root);

    const buttonErrors = violations.filter((v) => v.rule === "button-name");
    expect(buttonErrors).toHaveLength(0);
  });

  it("should pass for button with aria-label", () => {
    root = html('<button aria-label="Close">X</button>');
    const violations = checkLinksAndButtons(root);

    const buttonErrors = violations.filter((v) => v.rule === "button-name");
    expect(buttonErrors).toHaveLength(0);
  });

  it("should report error for div[role='button'] without accessible name", () => {
    root = html('<div role="button"></div>');
    const violations = checkLinksAndButtons(root);

    const errors = violations.filter((v) => v.rule === "button-name");
    expect(errors).toHaveLength(1);
  });

  it("should report error for input[type='submit'] without value", () => {
    root = html('<input type="submit">');
    const violations = checkLinksAndButtons(root);

    const errors = violations.filter((v) => v.rule === "button-name");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("submit");
  });

  it("should pass for input[type='submit'] with value", () => {
    root = html('<input type="submit" value="Send">');
    const violations = checkLinksAndButtons(root);

    const buttonErrors = violations.filter((v) => v.rule === "button-name" && v.message.includes("submit"));
    expect(buttonErrors).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// checkListSemantics
// ──────────────────────────────────────────────────────────────────────────────

describe("checkListSemantics", () => {
  let root: HTMLElement;

  beforeEach(() => {
    root?.remove();
  });

  it("should report error for ul with non-li children", () => {
    root = html(`
      <ul>
        <li>Item 1</li>
        <div>Not a list item</div>
      </ul>
    `);
    const violations = checkListSemantics(root);

    const errors = violations.filter((v) => v.rule === "list-semantics" && v.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("<div>");
    expect(errors[0].message).toContain("<ul>");
  });

  it("should report error for ol with non-li children", () => {
    root = html(`
      <ol>
        <span>Bad child</span>
        <li>Good child</li>
      </ol>
    `);
    const violations = checkListSemantics(root);

    const errors = violations.filter((v) => v.rule === "list-semantics" && v.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("<span>");
  });

  it("should pass for proper ul > li structure", () => {
    root = html(`
      <ul>
        <li>Item 1</li>
        <li>Item 2</li>
        <li>Item 3</li>
      </ul>
    `);
    const violations = checkListSemantics(root);

    const errors = violations.filter((v) => v.rule === "list-semantics");
    expect(errors).toHaveLength(0);
  });

  it("should report info for empty list", () => {
    root = html("<ul></ul>");
    const violations = checkListSemantics(root);

    const infos = violations.filter((v) => v.rule === "list-empty");
    expect(infos).toHaveLength(1);
    expect(infos[0].level).toBe("info");
    expect(infos[0].message).toContain("Empty");
  });

  it("should report error for dl with invalid children", () => {
    root = html(`
      <dl>
        <dt>Term</dt>
        <dd>Definition</dd>
        <span>Invalid child</span>
      </dl>
    `);
    const violations = checkListSemantics(root);

    const errors = violations.filter((v) => v.rule === "list-semantics" && v.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("<span>");
    expect(errors[0].message).toContain("<dl>");
  });

  it("should pass for proper dl structure with dt and dd", () => {
    root = html(`
      <dl>
        <dt>Term 1</dt>
        <dd>Definition 1</dd>
        <dt>Term 2</dt>
        <dd>Definition 2</dd>
      </dl>
    `);
    const violations = checkListSemantics(root);

    const errors = violations.filter((v) => v.rule === "list-semantics" && v.level === "error");
    expect(errors).toHaveLength(0);
  });

  it("should allow div children inside dl", () => {
    root = html(`
      <dl>
        <div>
          <dt>Term</dt>
          <dd>Definition</dd>
        </div>
      </dl>
    `);
    const violations = checkListSemantics(root);

    const errors = violations.filter((v) => v.rule === "list-semantics" && v.level === "error");
    expect(errors).toHaveLength(0);
  });

  it("should allow script and template children in lists", () => {
    root = html(`
      <ul>
        <li>Item</li>
        <script>/* noop */</script>
        <template><li>Template item</li></template>
      </ul>
    `);
    const violations = checkListSemantics(root);

    const errors = violations.filter((v) => v.rule === "list-semantics" && v.level === "error");
    expect(errors).toHaveLength(0);
  });

  it("should warn for role='list' without role='listitem' children", () => {
    root = html(`
      <div role="list">
        <div>Not a listitem</div>
        <div>Also not a listitem</div>
      </div>
    `);
    const violations = checkListSemantics(root);

    const warnings = violations.filter((v) => v.rule === "list-semantics" && v.level === "warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('role="list"');
    expect(warnings[0].message).toContain('role="listitem"');
  });

  it("should pass for role='list' with role='listitem' children", () => {
    root = html(`
      <div role="list">
        <div role="listitem">Item 1</div>
        <div role="listitem">Item 2</div>
      </div>
    `);
    const violations = checkListSemantics(root);

    const roleListWarnings = violations.filter((v) => v.rule === "list-semantics" && v.level === "warning");
    expect(roleListWarnings).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// checkTabOrder
// ──────────────────────────────────────────────────────────────────────────────

describe("checkTabOrder", () => {
  let root: HTMLElement;

  beforeEach(() => {
    root?.remove();
  });

  it("should warn for positive tabindex values", () => {
    root = html('<button tabindex="5">Misordered</button>');
    const violations = checkTabOrder(root);

    const warnings = violations.filter((v) => v.rule === "tabindex-positive");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].level).toBe("warning");
    expect(warnings[0].message).toContain('tabindex="5"');
    expect(warnings[0].message).toContain('tabindex="0"');
  });

  it("should not warn for tabindex='0'", () => {
    root = html('<div tabindex="0" role="button">Focusable</div>');
    const violations = checkTabOrder(root);

    const tabWarnings = violations.filter((v) => v.rule === "tabindex-positive");
    expect(tabWarnings).toHaveLength(0);
  });

  it("should not warn for tabindex='-1'", () => {
    root = html('<div tabindex="-1">Programmatically focusable</div>');
    const violations = checkTabOrder(root);

    const tabWarnings = violations.filter((v) => v.rule === "tabindex-positive");
    expect(tabWarnings).toHaveLength(0);
  });

  it("should report error for focus trap without focusable children", () => {
    root = html('<div aria-modal="true" role="dialog"><p>No buttons here</p></div>');
    const violations = checkTabOrder(root);

    const errors = violations.filter((v) => v.rule === "focus-trap-empty");
    expect(errors).toHaveLength(1);
    expect(errors[0].level).toBe("error");
    expect(errors[0].message).toContain("no focusable elements");
  });

  it("should not report focus-trap-empty when focusable children exist", () => {
    root = html('<div aria-modal="true" role="dialog"><button>Close</button></div>');
    const violations = checkTabOrder(root);

    const emptyErrors = violations.filter((v) => v.rule === "focus-trap-empty");
    expect(emptyErrors).toHaveLength(0);
  });

  it("should warn for modal dialog without close button", () => {
    root = html('<div aria-modal="true" role="dialog"><button>OK</button></div>');
    const violations = checkTabOrder(root);

    const escapeWarnings = violations.filter((v) => v.rule === "focus-trap-escape");
    expect(escapeWarnings).toHaveLength(1);
    expect(escapeWarnings[0].level).toBe("warning");
    expect(escapeWarnings[0].message).toContain("close button");
  });

  it("should not warn for modal dialog with close button", () => {
    root = html('<div aria-modal="true" role="dialog"><button aria-label="close">X</button></div>');
    const violations = checkTabOrder(root);

    const escapeWarnings = violations.filter((v) => v.rule === "focus-trap-escape");
    expect(escapeWarnings).toHaveLength(0);
  });

  it("should handle data-sibu-focus-trap attribute", () => {
    root = html('<div data-sibu-focus-trap role="dialog"><p>Trapped with no focusable items</p></div>');
    const violations = checkTabOrder(root);

    const errors = violations.filter((v) => v.rule === "focus-trap-empty");
    expect(errors).toHaveLength(1);
  });

  it("should accept inputs, links, and selects as focusable children", () => {
    root = html(`
      <div aria-modal="true" role="dialog">
        <input type="text" aria-label="Name">
        <button aria-label="close">Close</button>
      </div>
    `);
    const violations = checkTabOrder(root);

    const emptyErrors = violations.filter((v) => v.rule === "focus-trap-empty");
    expect(emptyErrors).toHaveLength(0);
  });

  it("should warn for multiple positive tabindex values", () => {
    root = html(`
      <div tabindex="1">First</div>
      <div tabindex="3">Third</div>
      <div tabindex="2">Second</div>
    `);
    const violations = checkTabOrder(root);

    const warnings = violations.filter((v) => v.rule === "tabindex-positive");
    expect(warnings).toHaveLength(3);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// checkA11y (aggregate)
// ──────────────────────────────────────────────────────────────────────────────

describe("checkA11y", () => {
  let root: HTMLElement;

  beforeEach(() => {
    root?.remove();
  });

  it("should run all checks and return combined result", () => {
    root = html(`
      <main>
        <h1>Title</h1>
        <img src="photo.jpg">
        <input type="text">
        <a href="/page"></a>
      </main>
    `);
    const result = checkA11y(root);

    expect(result).toHaveProperty("passed");
    expect(result).toHaveProperty("violations");
    expect(result).toHaveProperty("warnings");
    expect(result).toHaveProperty("info");
    expect(result).toHaveProperty("summary");

    // Should fail because there are errors
    expect(result.passed).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.summary).toContain("Failed");
  });

  it("should pass for a fully accessible DOM", () => {
    root = html(`
      <main>
        <h1>Welcome</h1>
        <h2>Section</h2>
        <p>Paragraph text</p>
        <img src="photo.jpg" alt="A photo">
        <label for="name">Name</label>
        <input type="text" id="name">
        <a href="/about">About us</a>
        <button>Submit</button>
        <ul>
          <li>Item 1</li>
          <li>Item 2</li>
        </ul>
      </main>
    `);
    const result = checkA11y(root);

    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("should filter violations by level (errors only)", () => {
    root = html(`
      <main>
        <h2>Not starting with h1</h2>
        <img src="photo.jpg">
      </main>
    `);
    const result = checkA11y(root, { level: "error" });

    // The heading warning should be filtered out
    // Only errors should remain
    expect(result.warnings).toHaveLength(0);
    expect(result.info).toHaveLength(0);
    // The img without alt is an error, should be present
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it("should filter violations by level (warnings and above)", () => {
    root = html(`
      <main>
        <h2>Not starting with h1</h2>
        <img src="decorative.jpg" alt="">
      </main>
    `);
    const result = checkA11y(root, { level: "warning" });

    // Info about decorative image should be filtered out
    expect(result.info).toHaveLength(0);
    // Warning about heading should remain
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("should run selective checks only", () => {
    root = html(`
      <img src="photo.jpg">
      <input type="text">
    `);

    // Only run image checks
    const imageOnly = checkA11y(root, { checks: ["images"] });
    const imageViolations = imageOnly.violations.concat(imageOnly.warnings, imageOnly.info);
    const imageRules = imageViolations.map((v) => v.rule);
    expect(imageRules.every((r) => r.startsWith("image"))).toBe(true);

    // Only run form checks
    const formOnly = checkA11y(root, { checks: ["forms"] });
    const formViolations = formOnly.violations.concat(formOnly.warnings, formOnly.info);
    const formRules = formViolations.map((v) => v.rule);
    expect(formRules.every((r) => r.startsWith("form"))).toBe(true);
  });

  it("should run multiple selective checks", () => {
    root = html(`
      <img src="photo.jpg">
      <input type="text">
      <h3>Skipped heading</h3>
    `);

    const result = checkA11y(root, { checks: ["images", "headings"] });
    const allViolations = result.violations.concat(result.warnings, result.info);
    const rules = allViolations.map((v) => v.rule);

    // Should include image and heading rules, but not form-label
    expect(rules.some((r) => r.startsWith("image"))).toBe(true);
    expect(rules.some((r) => r.startsWith("heading"))).toBe(true);
    expect(rules.some((r) => r.startsWith("form"))).toBe(false);
  });

  it("should produce correct summary for passing result", () => {
    root = html(`
      <main>
        <h1>Title</h1>
        <p>Content</p>
        <button>Click</button>
      </main>
    `);
    const result = checkA11y(root);

    expect(result.passed).toBe(true);
    expect(result.summary).toContain("Passed");
  });

  it("should produce summary with error count for failing result", () => {
    root = html(`
      <main>
        <h1>Title</h1>
        <img src="photo.jpg">
      </main>
    `);
    const result = checkA11y(root);

    expect(result.passed).toBe(false);
    expect(result.summary).toContain("error");
  });

  it("should return passed=true with warnings-only summary", () => {
    root = html(`
      <main>
        <h2>Starting with h2</h2>
      </main>
    `);
    const result = checkA11y(root);

    // Only warnings (heading not starting with h1), no errors
    expect(result.passed).toBe(true);
    expect(result.summary).toContain("Passed");
    expect(result.summary).toContain("warning");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// assertA11y
// ──────────────────────────────────────────────────────────────────────────────

describe("assertA11y", () => {
  let root: HTMLElement;

  beforeEach(() => {
    root?.remove();
  });

  it("should not throw for a clean, accessible DOM", () => {
    root = html(`
      <main>
        <h1>Page Title</h1>
        <p>Some content</p>
        <img src="photo.jpg" alt="Description">
        <label for="search">Search</label>
        <input type="text" id="search">
        <a href="/home">Home</a>
        <button>Submit</button>
      </main>
    `);

    expect(() => assertA11y(root)).not.toThrow();
  });

  it("should throw for DOM with violations", () => {
    root = html(`
      <img src="photo.jpg">
      <input type="text">
    `);

    expect(() => assertA11y(root)).toThrow();
  });

  it("should include detailed report in error message", () => {
    root = html(`
      <img src="photo.jpg">
      <input type="text">
    `);

    try {
      assertA11y(root);
      // Should not reach here
      expect.unreachable("assertA11y should have thrown");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("Accessibility check failed");
      expect(message).toContain("ERRORS:");
      expect(message).toContain("image-alt");
      expect(message).toContain("form-label");
    }
  });

  it("should include warnings in the error report", () => {
    root = html(`
      <h2>Starting with h2</h2>
      <img src="photo.jpg">
    `);

    try {
      assertA11y(root);
      expect.unreachable("assertA11y should have thrown");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("ERRORS:");
      expect(message).toContain("WARNINGS:");
    }
  });

  it("should respect options when asserting", () => {
    root = html(`
      <main>
        <h1>Title</h1>
        <img src="photo.jpg">
      </main>
    `);

    // Running only headings check should pass
    expect(() => assertA11y(root, { checks: ["headings"] })).not.toThrow();

    // Running images check should fail
    expect(() => assertA11y(root, { checks: ["images"] })).toThrow();
  });

  it("should respect level filter in options", () => {
    root = html(`
      <main>
        <h2>Warning: not starting with h1</h2>
      </main>
    `);

    // With default level (info), should pass (only warnings, no errors)
    expect(() => assertA11y(root)).not.toThrow();

    // Explicit error level should also pass since there are no errors
    expect(() => assertA11y(root, { level: "error" })).not.toThrow();
  });

  it("should provide selector info in the error report", () => {
    root = html('<img id="hero" src="hero.jpg">');

    try {
      assertA11y(root);
      expect.unreachable("assertA11y should have thrown");
    } catch (err) {
      const message = (err as Error).message;
      // The img has an id, so selector should include #hero
      expect(message).toContain("#hero");
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Type checks (compile-time verification)
// ──────────────────────────────────────────────────────────────────────────────

describe("types", () => {
  it("should export expected types with correct shapes", () => {
    const violation: A11yViolation = {
      rule: "test-rule",
      level: "error",
      message: "Test message",
      element: document.createElement("div"),
      selector: "div",
    };

    expect(violation.rule).toBe("test-rule");
    expect(violation.level).toBe("error");
    expect(violation.message).toBe("Test message");
    expect(violation.element).toBeInstanceOf(HTMLDivElement);
    expect(violation.selector).toBe("div");
  });

  it("should allow optional element and selector on violation", () => {
    const violation: A11yViolation = {
      rule: "test-rule",
      level: "warning",
      message: "Test message",
    };

    expect(violation.element).toBeUndefined();
    expect(violation.selector).toBeUndefined();
  });

  it("should have correct A11yCheckResult shape", () => {
    const result: A11yCheckResult = {
      passed: true,
      violations: [],
      warnings: [],
      info: [],
      summary: "Passed with no issues.",
    };

    expect(result.passed).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.info).toEqual([]);
    expect(result.summary).toBe("Passed with no issues.");
  });
});
