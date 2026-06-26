/**
 * Accessibility testing utilities for SibuJS.
 * Provides automated a11y checks and WCAG compliance validation.
 */

/**
 * Escape a value for safe interpolation inside an `[attr="..."]` selector — only
 * `"` and `\` are significant. Prevents a DOM-derived value (e.g. an element id)
 * with special characters from breaking the selector or throwing.
 */
function escSel(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

// ─── Types ──────────────────────────────────────────────────────────────────

export type A11yViolationLevel = "error" | "warning" | "info";

export interface A11yViolation {
  rule: string;
  level: A11yViolationLevel;
  message: string;
  element?: Element;
  selector?: string;
}

export interface A11yCheckResult {
  passed: boolean;
  violations: A11yViolation[];
  warnings: A11yViolation[];
  info: A11yViolation[];
  summary: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const VALID_ARIA_ROLES = new Set([
  "alert",
  "alertdialog",
  "application",
  "article",
  "banner",
  "button",
  "cell",
  "checkbox",
  "columnheader",
  "combobox",
  "complementary",
  "contentinfo",
  "definition",
  "dialog",
  "directory",
  "document",
  "feed",
  "figure",
  "form",
  "grid",
  "gridcell",
  "group",
  "heading",
  "img",
  "link",
  "list",
  "listbox",
  "listitem",
  "log",
  "main",
  "marquee",
  "math",
  "menu",
  "menubar",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "meter",
  "navigation",
  "none",
  "note",
  "option",
  "presentation",
  "progressbar",
  "radio",
  "radiogroup",
  "region",
  "row",
  "rowgroup",
  "rowheader",
  "scrollbar",
  "search",
  "searchbox",
  "separator",
  "slider",
  "spinbutton",
  "status",
  "switch",
  "tab",
  "table",
  "tablist",
  "tabpanel",
  "term",
  "textbox",
  "timer",
  "toolbar",
  "tooltip",
  "tree",
  "treegrid",
  "treeitem",
]);

const LANDMARK_ROLES = new Set([
  "banner",
  "complementary",
  "contentinfo",
  "form",
  "main",
  "navigation",
  "region",
  "search",
]);

const LANDMARK_ELEMENTS: Record<string, string> = {
  header: "banner",
  footer: "contentinfo",
  main: "main",
  nav: "navigation",
  aside: "complementary",
  form: "form",
  section: "region",
};

/**
 * Roles that require specific ARIA properties.
 */
const REQUIRED_ARIA_PROPS: Record<string, string[]> = {
  checkbox: ["aria-checked"],
  combobox: ["aria-expanded"],
  heading: ["aria-level"],
  meter: ["aria-valuenow"],
  option: ["aria-selected"],
  radio: ["aria-checked"],
  scrollbar: ["aria-controls", "aria-valuenow"],
  separator: [], // only required when focusable
  slider: ["aria-valuenow"],
  spinbutton: ["aria-valuenow"],
  switch: ["aria-checked"],
};

const VALID_ARIA_ATTRIBUTES = new Set([
  "aria-activedescendant",
  "aria-atomic",
  "aria-autocomplete",
  "aria-busy",
  "aria-checked",
  "aria-colcount",
  "aria-colindex",
  "aria-colspan",
  "aria-controls",
  "aria-current",
  "aria-describedby",
  "aria-details",
  "aria-disabled",
  "aria-dropeffect",
  "aria-errormessage",
  "aria-expanded",
  "aria-flowto",
  "aria-grabbed",
  "aria-haspopup",
  "aria-hidden",
  "aria-invalid",
  "aria-keyshortcuts",
  "aria-label",
  "aria-labelledby",
  "aria-level",
  "aria-live",
  "aria-modal",
  "aria-multiline",
  "aria-multiselectable",
  "aria-orientation",
  "aria-owns",
  "aria-placeholder",
  "aria-posinset",
  "aria-pressed",
  "aria-readonly",
  "aria-relevant",
  "aria-required",
  "aria-roledescription",
  "aria-rowcount",
  "aria-rowindex",
  "aria-rowspan",
  "aria-selected",
  "aria-setsize",
  "aria-sort",
  "aria-valuemax",
  "aria-valuemin",
  "aria-valuenow",
  "aria-valuetext",
]);

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a CSS selector string that identifies the given element.
 */
function getSelector(el: Element): string {
  if (el.id) return `#${el.id}`;

  const tag = el.tagName.toLowerCase();
  const classes =
    el.className && typeof el.className === "string" ? `.${el.className.trim().split(/\s+/).join(".")}` : "";
  const role = el.getAttribute("role");
  const roleStr = role ? `[role="${role}"]` : "";

  return `${tag}${classes}${roleStr}`;
}

/**
 * Check if an element has an accessible name via any supported mechanism.
 */
function hasAccessibleName(el: Element): boolean {
  // aria-label
  if (el.getAttribute("aria-label")?.trim()) return true;

  // aria-labelledby
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const doc = el.ownerDocument;
    const ids = labelledBy.split(/\s+/);
    for (const id of ids) {
      const ref = doc.getElementById(id);
      if (ref?.textContent?.trim()) return true;
    }
  }

  // title attribute
  if (el.getAttribute("title")?.trim()) return true;

  // text content
  if (el.textContent?.trim()) return true;

  return false;
}

/**
 * Check if an element is a native HTML element that is inherently focusable/interactive.
 */
function isNativeInteractive(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (["button", "select", "textarea"].includes(tag)) return true;
  if (tag === "input" && el.getAttribute("type") !== "hidden") return true;
  if (tag === "a" && el.hasAttribute("href")) return true;
  if (tag === "area" && el.hasAttribute("href")) return true;
  return false;
}

// ─── Individual Checks ──────────────────────────────────────────────────────

/**
 * Check that all images have alt text.
 */
export function checkImageAlt(root: Element): A11yViolation[] {
  const violations: A11yViolation[] = [];
  const images = root.querySelectorAll("img");

  for (const img of Array.from(images)) {
    if (!img.hasAttribute("alt")) {
      violations.push({
        rule: "image-alt",
        level: "error",
        message: 'Image element must have an alt attribute. Use alt="" for decorative images.',
        element: img,
        selector: getSelector(img),
      });
    } else if (img.getAttribute("alt") === "" && !img.getAttribute("role")) {
      // Empty alt on non-decorative image is a warning
      // We consider it informational since empty alt is valid for decorative images
      violations.push({
        rule: "image-alt-empty",
        level: "info",
        message: "Image has empty alt text. Ensure this is a decorative image; otherwise provide meaningful alt text.",
        element: img,
        selector: getSelector(img),
      });
    }
  }

  // Also check elements with role="img"
  const roleImgs = root.querySelectorAll('[role="img"]');
  for (const el of Array.from(roleImgs)) {
    if (!hasAccessibleName(el)) {
      violations.push({
        rule: "image-alt",
        level: "error",
        message: 'Element with role="img" must have an accessible name (aria-label or aria-labelledby).',
        element: el,
        selector: getSelector(el),
      });
    }
  }

  return violations;
}

/**
 * Check that form inputs have associated labels.
 * Checks for: <label for="id">, aria-label, aria-labelledby, wrapping <label>.
 */
export function checkFormLabels(root: Element): A11yViolation[] {
  const violations: A11yViolation[] = [];
  const inputs = root.querySelectorAll("input, select, textarea");

  for (const input of Array.from(inputs)) {
    // Skip hidden inputs
    if (input.getAttribute("type") === "hidden") continue;

    // Skip buttons (submit, reset, button) - they don't need labels
    const inputType = input.getAttribute("type");
    if (inputType === "submit" || inputType === "reset" || inputType === "button") continue;

    const hasLabel = checkInputHasLabel(input, root);

    if (!hasLabel) {
      violations.push({
        rule: "form-label",
        level: "error",
        message: `Form ${input.tagName.toLowerCase()} element must have an associated label. Use <label for="id">, aria-label, aria-labelledby, or wrap in a <label>.`,
        element: input,
        selector: getSelector(input),
      });
    }
  }

  return violations;
}

function checkInputHasLabel(input: Element, root: Element): boolean {
  // Check aria-label
  if (input.getAttribute("aria-label")?.trim()) return true;

  // Check aria-labelledby
  const labelledBy = input.getAttribute("aria-labelledby");
  if (labelledBy) {
    const doc = input.ownerDocument;
    const ids = labelledBy.split(/\s+/);
    for (const id of ids) {
      const ref = doc.getElementById(id);
      if (ref?.textContent?.trim()) return true;
    }
  }

  // Check title attribute
  if (input.getAttribute("title")?.trim()) return true;

  // Check placeholder (warning-level, but counts as "has something")
  // Placeholder alone is not sufficient per WCAG, but we don't flag an error for it
  // since it provides some context. We handle this separately.

  // Check for <label for="id">
  const id = input.getAttribute("id");
  if (id) {
    const label = root.querySelector(`label[for="${escSel(id)}"]`);
    if (label?.textContent?.trim()) return true;
  }

  // Check for wrapping <label>
  let parent = input.parentElement;
  while (parent && parent !== root) {
    if (parent.tagName.toLowerCase() === "label") return true;
    parent = parent.parentElement;
  }

  return false;
}

/**
 * Check heading hierarchy (h1-h6 should not skip levels).
 */
export function checkHeadingHierarchy(root: Element): A11yViolation[] {
  const violations: A11yViolation[] = [];
  const headings = root.querySelectorAll("h1, h2, h3, h4, h5, h6");

  if (headings.length === 0) return violations;

  let previousLevel = 0;

  for (const heading of Array.from(headings)) {
    const currentLevel = parseInt(heading.tagName[1], 10);

    // First heading should ideally start at h1
    if (previousLevel === 0 && currentLevel !== 1) {
      violations.push({
        rule: "heading-order",
        level: "warning",
        message: `Heading hierarchy should start with h1. Found ${heading.tagName.toLowerCase()} as the first heading.`,
        element: heading,
        selector: getSelector(heading),
      });
    }

    // Check for skipped levels (e.g., h2 -> h4)
    if (previousLevel > 0 && currentLevel > previousLevel + 1) {
      violations.push({
        rule: "heading-order",
        level: "error",
        message: `Heading level skipped: ${heading.tagName.toLowerCase()} follows h${previousLevel}. Headings should not skip levels.`,
        element: heading,
        selector: getSelector(heading),
      });
    }

    // Check that headings have content
    if (!heading.textContent?.trim()) {
      violations.push({
        rule: "heading-empty",
        level: "error",
        message: `Heading ${heading.tagName.toLowerCase()} is empty. Headings must have discernible text.`,
        element: heading,
        selector: getSelector(heading),
      });
    }

    previousLevel = currentLevel;
  }

  return violations;
}

/**
 * Check for sufficient color contrast ratios.
 * Since we can't compute actual colors in jsdom, checks for known issues:
 * - Text with no color/background set
 * - Elements with role but no accessible name
 */
export function checkColorContrast(root: Element): A11yViolation[] {
  const violations: A11yViolation[] = [];

  // Check elements with role but no accessible name
  const roledElements = root.querySelectorAll("[role]");
  for (const el of Array.from(roledElements)) {
    const role = el.getAttribute("role");
    if (!role) continue;
    // Skip presentational/none roles
    if (role === "presentation" || role === "none") continue;

    // Roles that typically need an accessible name
    const nameRequiredRoles = new Set([
      "alert",
      "alertdialog",
      "button",
      "checkbox",
      "combobox",
      "dialog",
      "link",
      "menuitem",
      "menuitemcheckbox",
      "menuitemradio",
      "option",
      "progressbar",
      "radio",
      "slider",
      "spinbutton",
      "switch",
      "tab",
      "textbox",
      "treeitem",
    ]);

    if (nameRequiredRoles.has(role) && !hasAccessibleName(el)) {
      violations.push({
        rule: "accessible-name",
        level: "error",
        message: `Element with role="${role}" must have an accessible name (via aria-label, aria-labelledby, or text content).`,
        element: el,
        selector: getSelector(el),
      });
    }
  }

  // Check for text content using inline styles with potentially problematic patterns
  const inlineStyled = root.querySelectorAll("[style]");
  for (const el of Array.from(inlineStyled)) {
    const style = el.getAttribute("style") || "";
    const hasColor = /(?:^|;)\s*color\s*:/i.test(style);
    const hasBg = /(?:^|;)\s*background(?:-color)?\s*:/i.test(style);

    if (hasColor && !hasBg && el.textContent?.trim()) {
      violations.push({
        rule: "color-contrast",
        level: "warning",
        message:
          "Element sets text color but not background color. Ensure sufficient contrast with the inherited background.",
        element: el,
        selector: getSelector(el),
      });
    }

    if (hasBg && !hasColor && el.textContent?.trim()) {
      violations.push({
        rule: "color-contrast",
        level: "warning",
        message:
          "Element sets background color but not text color. Ensure sufficient contrast with the inherited text color.",
        element: el,
        selector: getSelector(el),
      });
    }
  }

  return violations;
}

/**
 * Check that interactive elements are keyboard accessible.
 * Elements with click handlers should have tabindex, role, and key handlers.
 */
export function checkKeyboardAccess(root: Element): A11yViolation[] {
  const violations: A11yViolation[] = [];

  // Check elements with onclick attribute that aren't natively interactive
  const clickElements = root.querySelectorAll("[onclick]");
  for (const el of Array.from(clickElements)) {
    if (isNativeInteractive(el)) continue;

    const hasTabindex = el.hasAttribute("tabindex");
    const hasRole = el.hasAttribute("role");
    const hasKeyHandler = el.hasAttribute("onkeydown") || el.hasAttribute("onkeyup") || el.hasAttribute("onkeypress");

    if (!hasTabindex) {
      violations.push({
        rule: "keyboard-access",
        level: "error",
        message: "Interactive element with onclick must have tabindex to be keyboard accessible.",
        element: el,
        selector: getSelector(el),
      });
    }

    if (!hasRole) {
      violations.push({
        rule: "keyboard-access",
        level: "warning",
        message: 'Interactive element with onclick should have an explicit role attribute (e.g., role="button").',
        element: el,
        selector: getSelector(el),
      });
    }

    if (!hasKeyHandler) {
      violations.push({
        rule: "keyboard-access",
        level: "error",
        message:
          "Interactive element with onclick must also have a keyboard event handler (onkeydown or onkeyup) for keyboard accessibility.",
        element: el,
        selector: getSelector(el),
      });
    }
  }

  // Check elements with role="button" or role="link" that aren't natively interactive
  const interactiveRoles = root.querySelectorAll(
    '[role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"]',
  );
  for (const el of Array.from(interactiveRoles)) {
    if (isNativeInteractive(el)) continue;

    if (!el.hasAttribute("tabindex")) {
      violations.push({
        rule: "keyboard-access",
        level: "error",
        message: `Element with role="${el.getAttribute("role")}" must have tabindex to be keyboard accessible.`,
        element: el,
        selector: getSelector(el),
      });
    }
  }

  return violations;
}

/**
 * Check ARIA attribute validity.
 * - role attributes use valid ARIA roles
 * - aria-* attributes are valid
 * - Required aria properties are present for roles
 */
export function checkAriaAttributes(root: Element): A11yViolation[] {
  const violations: A11yViolation[] = [];

  // Check all elements with role attributes
  const roledElements = root.querySelectorAll("[role]");
  for (const el of Array.from(roledElements)) {
    const role = el.getAttribute("role");
    if (!role) continue;

    // Validate role value
    if (!VALID_ARIA_ROLES.has(role)) {
      violations.push({
        rule: "aria-valid-role",
        level: "error",
        message: `Invalid ARIA role "${role}". Must be a valid WAI-ARIA role.`,
        element: el,
        selector: getSelector(el),
      });
    }

    // Check required ARIA properties for the role
    if (REQUIRED_ARIA_PROPS[role]) {
      for (const requiredProp of REQUIRED_ARIA_PROPS[role]) {
        if (!el.hasAttribute(requiredProp)) {
          violations.push({
            rule: "aria-required-attr",
            level: "error",
            message: `Element with role="${role}" requires the ${requiredProp} attribute.`,
            element: el,
            selector: getSelector(el),
          });
        }
      }
    }
  }

  // Check all aria-* attributes on every element
  const allElements = root.querySelectorAll("*");
  for (const el of Array.from(allElements)) {
    for (const attr of Array.from(el.attributes)) {
      if (!attr.name.startsWith("aria-")) continue;

      // Validate the aria attribute name
      if (!VALID_ARIA_ATTRIBUTES.has(attr.name)) {
        violations.push({
          rule: "aria-valid-attr",
          level: "error",
          message: `Invalid ARIA attribute "${attr.name}". Must be a valid WAI-ARIA attribute.`,
          element: el,
          selector: getSelector(el),
        });
      }

      // Check aria-labelledby / aria-describedby references exist
      if (
        attr.name === "aria-labelledby" ||
        attr.name === "aria-describedby" ||
        attr.name === "aria-controls" ||
        attr.name === "aria-owns"
      ) {
        const ids = attr.value.split(/\s+/).filter(Boolean);
        const doc = el.ownerDocument;
        for (const id of ids) {
          if (!doc.getElementById(id)) {
            violations.push({
              rule: "aria-valid-attr-value",
              level: "error",
              message: `${attr.name} references id "${id}" which does not exist in the document.`,
              element: el,
              selector: getSelector(el),
            });
          }
        }
      }

      // Check boolean-like aria attributes have valid values
      const booleanAttrs = new Set([
        "aria-checked",
        "aria-disabled",
        "aria-expanded",
        "aria-hidden",
        "aria-pressed",
        "aria-required",
        "aria-selected",
        "aria-busy",
        "aria-modal",
        "aria-multiline",
        "aria-multiselectable",
        "aria-readonly",
      ]);
      if (booleanAttrs.has(attr.name)) {
        const validValues = ["true", "false"];
        // Some boolean attrs also accept 'mixed'
        if (attr.name === "aria-checked" || attr.name === "aria-pressed") {
          validValues.push("mixed");
        }
        if (!validValues.includes(attr.value)) {
          violations.push({
            rule: "aria-valid-attr-value",
            level: "error",
            message: `${attr.name} has invalid value "${attr.value}". Expected one of: ${validValues.join(", ")}.`,
            element: el,
            selector: getSelector(el),
          });
        }
      }
    }
  }

  // Also check the root element itself
  for (const attr of Array.from(root.attributes)) {
    if (!attr.name.startsWith("aria-")) continue;
    if (!VALID_ARIA_ATTRIBUTES.has(attr.name)) {
      violations.push({
        rule: "aria-valid-attr",
        level: "error",
        message: `Invalid ARIA attribute "${attr.name}" on root element. Must be a valid WAI-ARIA attribute.`,
        element: root,
        selector: getSelector(root),
      });
    }
  }

  return violations;
}

/**
 * Check that the page has proper landmark regions.
 */
export function checkLandmarks(root: Element): A11yViolation[] {
  const violations: A11yViolation[] = [];

  // Collect all landmarks (both ARIA roles and HTML5 semantic elements)
  const foundLandmarks = new Set<string>();

  // Check for ARIA landmark roles
  for (const role of LANDMARK_ROLES) {
    const elements = root.querySelectorAll(`[role="${role}"]`);
    if (elements.length > 0) {
      foundLandmarks.add(role);
    }
  }

  // Check for HTML5 semantic landmark elements
  for (const [tag, role] of Object.entries(LANDMARK_ELEMENTS)) {
    const elements = root.querySelectorAll(tag);
    if (elements.length > 0) {
      foundLandmarks.add(role);
    }
  }

  // Warn if no main landmark is present
  if (!foundLandmarks.has("main")) {
    violations.push({
      rule: "landmark-main",
      level: "warning",
      message: 'Page should have a main landmark (<main> element or role="main").',
      selector: getSelector(root),
    });
  }

  // Check for multiple main landmarks
  const mainElements = root.querySelectorAll('main, [role="main"]');
  if (mainElements.length > 1) {
    violations.push({
      rule: "landmark-unique",
      level: "error",
      message: `Multiple main landmarks found (${mainElements.length}). A page should have at most one main landmark.`,
      selector: getSelector(root),
    });
  }

  // Check for multiple banner landmarks
  const bannerElements = root.querySelectorAll('header, [role="banner"]');
  if (bannerElements.length > 1) {
    violations.push({
      rule: "landmark-unique",
      level: "warning",
      message: `Multiple banner landmarks found (${bannerElements.length}). Consider using a single banner landmark.`,
      selector: getSelector(root),
    });
  }

  // Check for multiple contentinfo landmarks
  const contentinfoElements = root.querySelectorAll('footer, [role="contentinfo"]');
  if (contentinfoElements.length > 1) {
    violations.push({
      rule: "landmark-unique",
      level: "warning",
      message: `Multiple contentinfo landmarks found (${contentinfoElements.length}). Consider using a single contentinfo landmark.`,
      selector: getSelector(root),
    });
  }

  // Check that navigation landmarks have labels when multiple exist
  const navElements = root.querySelectorAll('nav, [role="navigation"]');
  if (navElements.length > 1) {
    for (const nav of Array.from(navElements)) {
      if (!nav.getAttribute("aria-label") && !nav.getAttribute("aria-labelledby")) {
        violations.push({
          rule: "landmark-label",
          level: "warning",
          message:
            "When multiple navigation landmarks exist, each should have a unique label (aria-label or aria-labelledby).",
          element: nav,
          selector: getSelector(nav),
        });
      }
    }
  }

  return violations;
}

/**
 * Check link and button accessibility.
 * - Links should have discernible text
 * - Buttons should have accessible names
 * - Links with target="_blank" should warn about new window
 */
export function checkLinksAndButtons(root: Element): A11yViolation[] {
  const violations: A11yViolation[] = [];

  // Check links
  const links = root.querySelectorAll("a[href]");
  for (const link of Array.from(links)) {
    if (!hasAccessibleName(link)) {
      violations.push({
        rule: "link-name",
        level: "error",
        message: "Link must have discernible text. Add text content, aria-label, or aria-labelledby.",
        element: link,
        selector: getSelector(link),
      });
    }

    // Check for target="_blank" without rel="noopener"
    if (link.getAttribute("target") === "_blank") {
      violations.push({
        rule: "link-new-window",
        level: "warning",
        message:
          'Link opens in a new window/tab (target="_blank"). Consider warning users or adding an icon to indicate this.',
        element: link,
        selector: getSelector(link),
      });

      const rel = link.getAttribute("rel") || "";
      if (!rel.includes("noopener") && !rel.includes("noreferrer")) {
        violations.push({
          rule: "link-noopener",
          level: "warning",
          message: 'Link with target="_blank" should include rel="noopener" or rel="noreferrer" for security.',
          element: link,
          selector: getSelector(link),
        });
      }
    }

    // Check for generic link text
    const linkText = link.textContent?.trim().toLowerCase() || "";
    const genericTexts = ["click here", "here", "read more", "more", "learn more", "link"];
    if (genericTexts.includes(linkText)) {
      violations.push({
        rule: "link-purpose",
        level: "warning",
        message: `Link text "${link.textContent?.trim()}" is generic. Use descriptive text that explains the link's purpose.`,
        element: link,
        selector: getSelector(link),
      });
    }
  }

  // Check buttons
  const buttons = root.querySelectorAll('button, [role="button"]');
  for (const button of Array.from(buttons)) {
    if (!hasAccessibleName(button)) {
      violations.push({
        rule: "button-name",
        level: "error",
        message: "Button must have an accessible name. Add text content, aria-label, or aria-labelledby.",
        element: button,
        selector: getSelector(button),
      });
    }
  }

  // Check input buttons (type="submit", type="reset", type="button")
  const inputButtons = root.querySelectorAll('input[type="submit"], input[type="reset"], input[type="button"]');
  for (const input of Array.from(inputButtons)) {
    const value = input.getAttribute("value");
    if (!value?.trim() && !input.getAttribute("aria-label") && !input.getAttribute("aria-labelledby")) {
      violations.push({
        rule: "button-name",
        level: "error",
        message: `Input button (type="${input.getAttribute("type")}") must have a value, aria-label, or aria-labelledby.`,
        element: input,
        selector: getSelector(input),
      });
    }
  }

  return violations;
}

/**
 * Check that lists use proper semantic markup.
 */
export function checkListSemantics(root: Element): A11yViolation[] {
  const violations: A11yViolation[] = [];

  // Check <ul> and <ol> direct children should be <li>
  const lists = root.querySelectorAll("ul, ol");
  for (const list of Array.from(lists)) {
    const children = Array.from(list.children);
    for (const child of children) {
      const tag = child.tagName.toLowerCase();
      // Allow <li>, <script>, <template> as direct children
      if (tag !== "li" && tag !== "script" && tag !== "template") {
        violations.push({
          rule: "list-semantics",
          level: "error",
          message: `Direct children of <${list.tagName.toLowerCase()}> must be <li> elements. Found <${tag}>.`,
          element: child,
          selector: getSelector(child),
        });
      }
    }

    // Empty list warning
    if (children.length === 0) {
      violations.push({
        rule: "list-empty",
        level: "info",
        message: `Empty <${list.tagName.toLowerCase()}> element found. Consider removing or adding items.`,
        element: list,
        selector: getSelector(list),
      });
    }
  }

  // Check <dl> direct children should be <dt>, <dd>, or <div>
  const dlLists = root.querySelectorAll("dl");
  for (const dl of Array.from(dlLists)) {
    const children = Array.from(dl.children);
    for (const child of children) {
      const tag = child.tagName.toLowerCase();
      if (tag !== "dt" && tag !== "dd" && tag !== "div" && tag !== "script" && tag !== "template") {
        violations.push({
          rule: "list-semantics",
          level: "error",
          message: `Direct children of <dl> must be <dt>, <dd>, or <div> elements. Found <${tag}>.`,
          element: child,
          selector: getSelector(child),
        });
      }
    }
  }

  // Check elements with role="list" have children with role="listitem"
  const roleLists = root.querySelectorAll('[role="list"]');
  for (const list of Array.from(roleLists)) {
    const children = Array.from(list.children);
    const hasListItems = children.some(
      (child) => child.getAttribute("role") === "listitem" || child.tagName.toLowerCase() === "li",
    );
    if (children.length > 0 && !hasListItems) {
      violations.push({
        rule: "list-semantics",
        level: "warning",
        message: 'Element with role="list" should contain children with role="listitem".',
        element: list,
        selector: getSelector(list),
      });
    }
  }

  return violations;
}

/**
 * Check for tab order issues.
 * - Positive tabindex values (anti-pattern)
 * - Focus traps without escape mechanism
 */
export function checkTabOrder(root: Element): A11yViolation[] {
  const violations: A11yViolation[] = [];

  // Check for positive tabindex values
  const tabbable = root.querySelectorAll("[tabindex]");
  for (const el of Array.from(tabbable)) {
    const tabindex = parseInt(el.getAttribute("tabindex") ?? "", 10);
    if (!Number.isNaN(tabindex) && tabindex > 0) {
      violations.push({
        rule: "tabindex-positive",
        level: "warning",
        message: `Element has tabindex="${tabindex}". Positive tabindex values create a confusing tab order. Use tabindex="0" instead and rely on DOM order.`,
        element: el,
        selector: getSelector(el),
      });
    }
  }

  // Check for focus trap containers without accessible escape indication
  const focusTraps = root.querySelectorAll('[data-sibu-focus-trap], [aria-modal="true"]');
  for (const trap of Array.from(focusTraps)) {
    // Modal dialogs should have a close mechanism
    const role = trap.getAttribute("role");
    if (role === "dialog" || role === "alertdialog" || trap.hasAttribute("aria-modal")) {
      // Check for a close button or escape handler indication
      const hasCloseButton = trap.querySelector(
        'button[aria-label*="close" i], button[aria-label*="dismiss" i], [data-dismiss], [data-close]',
      );
      if (!hasCloseButton) {
        violations.push({
          rule: "focus-trap-escape",
          level: "warning",
          message:
            "Modal/dialog with focus trap should have a visible close button. Users must be able to dismiss the dialog.",
          element: trap,
          selector: getSelector(trap),
        });
      }
    }

    // Check that focus trap containers have focusable children
    const focusable = trap.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (focusable.length === 0) {
      violations.push({
        rule: "focus-trap-empty",
        level: "error",
        message: "Focus trap contains no focusable elements. Users will be trapped with no way to interact.",
        element: trap,
        selector: getSelector(trap),
      });
    }
  }

  return violations;
}

// ─── Check Name Map ─────────────────────────────────────────────────────────

type CheckName =
  | "images"
  | "forms"
  | "headings"
  | "contrast"
  | "keyboard"
  | "aria"
  | "landmarks"
  | "links"
  | "lists"
  | "tabOrder";

const CHECK_FUNCTIONS: Record<CheckName, (root: Element) => A11yViolation[]> = {
  images: checkImageAlt,
  forms: checkFormLabels,
  headings: checkHeadingHierarchy,
  contrast: checkColorContrast,
  keyboard: checkKeyboardAccess,
  aria: checkAriaAttributes,
  landmarks: checkLandmarks,
  links: checkLinksAndButtons,
  lists: checkListSemantics,
  tabOrder: checkTabOrder,
};

const ALL_CHECKS: CheckName[] = [
  "images",
  "forms",
  "headings",
  "contrast",
  "keyboard",
  "aria",
  "landmarks",
  "links",
  "lists",
  "tabOrder",
];

// ─── Aggregate Check ────────────────────────────────────────────────────────

/**
 * Run all accessibility checks on an element.
 * Returns a comprehensive report.
 */
export function checkA11y(
  root: Element,
  options?: {
    /** Which checks to run (default: all) */
    checks?: CheckName[];
    /** Minimum violation level to report */
    level?: A11yViolationLevel;
  },
): A11yCheckResult {
  const checksToRun = options?.checks || ALL_CHECKS;
  const minLevel = options?.level || "info";

  const levelPriority: Record<A11yViolationLevel, number> = {
    error: 2,
    warning: 1,
    info: 0,
  };
  const minPriority = levelPriority[minLevel];

  // Run all selected checks
  const allViolations: A11yViolation[] = [];
  for (const check of checksToRun) {
    const fn = CHECK_FUNCTIONS[check];
    if (fn) {
      const results = fn(root);
      allViolations.push(...results);
    }
  }

  // Filter by minimum level
  const filtered = allViolations.filter((v) => levelPriority[v.level] >= minPriority);

  // Categorize
  const violations = filtered.filter((v) => v.level === "error");
  const warnings = filtered.filter((v) => v.level === "warning");
  const info = filtered.filter((v) => v.level === "info");

  // Build summary
  const parts: string[] = [];
  if (violations.length > 0) parts.push(`${violations.length} error(s)`);
  if (warnings.length > 0) parts.push(`${warnings.length} warning(s)`);
  if (info.length > 0) parts.push(`${info.length} info`);

  const passed = violations.length === 0;
  const summary = passed
    ? parts.length > 0
      ? `Passed with ${parts.join(", ")}.`
      : "Passed with no issues."
    : `Failed with ${parts.join(", ")}.`;

  return { passed, violations, warnings, info, summary };
}

/**
 * Assert that an element has no accessibility violations.
 * Throws with a detailed report if violations are found.
 */
export function assertA11y(root: Element, options?: Parameters<typeof checkA11y>[1]): void {
  const result = checkA11y(root, options);

  if (!result.passed) {
    const lines = [`Accessibility check failed: ${result.summary}`, ""];

    if (result.violations.length > 0) {
      lines.push("ERRORS:");
      for (const v of result.violations) {
        lines.push(`  [${v.rule}] ${v.message}${v.selector ? ` (${v.selector})` : ""}`);
      }
      lines.push("");
    }

    if (result.warnings.length > 0) {
      lines.push("WARNINGS:");
      for (const w of result.warnings) {
        lines.push(`  [${w.rule}] ${w.message}${w.selector ? ` (${w.selector})` : ""}`);
      }
      lines.push("");
    }

    throw new Error(lines.join("\n"));
  }
}
