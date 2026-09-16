import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "../src/testing/index";
import { findByRole, findByTestId, queryByLabel, queryByRole, queryByTestId } from "../src/testing/queries";

// ---------------------------------------------------------------------------
// Testing queries match attribute values exactly, whatever they contain.
//
// THE DEFECT: `testId`, `role` and `aria-label` values were interpolated into
// CSS selectors unescaped. A valid attribute value containing a quote or bracket
// produced an invalid selector (a DOMException) — or matched something else —
// and because polling did not catch errors, `findBy*()` threw from a timer while
// its returned promise never settled.
// ---------------------------------------------------------------------------

const TRICKY = ['save"]', "back\\slash", "[brackets]", "line\nbreak", "unicode ✓ ünï", "a'b", "#id.class > x"];

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function add(attr: string, value: string, tag = "div"): HTMLElement {
  const el = document.createElement(tag);
  el.setAttribute(attr, value);
  container.appendChild(el);
  return el;
}

describe("queryBy* exact attribute matching", () => {
  for (const value of TRICKY) {
    it(`finds data-testid ${JSON.stringify(value)}`, () => {
      const el = add("data-testid", value);
      expect(queryByTestId(container, value)).toBe(el);
    });

    it(`finds role ${JSON.stringify(value)}`, () => {
      const el = add("role", value);
      expect(queryByRole(container, value)).toBe(el);
    });

    it(`finds aria-label ${JSON.stringify(value)}`, () => {
      const el = add("aria-label", value);
      expect(queryByLabel(container, value)).toBe(el);
    });
  }

  it("matches the whole value, not a selector fragment", () => {
    add("data-testid", "save");
    const exact = add("data-testid", 'save"] , [data-testid="other');
    add("data-testid", "other");

    expect(queryByTestId(container, 'save"] , [data-testid="other')).toBe(exact);
    expect(queryByTestId(container, "sav")).toBeNull();
  });

  it("follows a label's `for` to an id containing special characters", () => {
    const input = document.createElement("input");
    input.id = 'weird"id]';
    const label = document.createElement("label");
    label.setAttribute("for", 'weird"id]');
    label.textContent = "Name";
    container.append(label, input);

    expect(queryByLabel(container, "Name")).toBe(input);
  });

  it("render() helpers match tricky test ids exactly", () => {
    const el = document.createElement("div");
    el.setAttribute("data-testid", 'save"]');
    const result = render(() => el);
    expect(result.getByTestId('save"]')).toBe(el);
    expect(result.getByRole('nope"]')).toBeNull();
    result.unmount();
  });
});

describe("findBy* never hangs on a throwing query", () => {
  it("resolves for a tricky value that appears later", async () => {
    setTimeout(() => add("data-testid", 'late"]'), 20);
    const found = await findByTestId(container, 'late"]', { timeout: 500, interval: 5 });
    expect(found.getAttribute("data-testid")).toBe('late"]');
  });

  it("rejects instead of hanging when polling throws", async () => {
    // Throw only from a LATER poll: the first poll runs inside the promise
    // executor, where a throw already rejects. The hang was on timer polls.
    let calls = 0;
    const explodeLater = <T>(firstResult: T) => {
      return () => {
        calls++;
        if (calls > 1) throw new Error("query exploded");
        return firstResult as never;
      };
    };
    vi.spyOn(container, "querySelector").mockImplementation(explodeLater(null));
    vi.spyOn(container, "querySelectorAll").mockImplementation(explodeLater([]));

    await expect(findByRole(container, "button", { timeout: 200, interval: 5 })).rejects.toThrow("query exploded");
  });

  it("leaves no pending timer after resolving or rejecting", async () => {
    vi.useFakeTimers();
    add("data-testid", "present");
    await findByTestId(container, "present", { timeout: 100, interval: 10 });
    expect(vi.getTimerCount()).toBe(0);

    const missing = findByTestId(container, "missing", { timeout: 30, interval: 10 });
    const settled = missing.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(50);
    expect(await settled).toBeInstanceOf(Error);
    expect(vi.getTimerCount()).toBe(0);
  });
});
