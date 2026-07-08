import { describe, expect, it } from "vitest";
import { tagFactory } from "../src/core/rendering/tagFactory";
import { ref } from "../src/core/signals/ref";
import { signal } from "../src/core/signals/signal";

const div = tagFactory("div");

describe("tagFactory reactive features", () => {
  describe("reactive class binding", () => {
    it("should accept a function for class", async () => {
      const [active, setActive] = signal(false);
      const el = div({ class: () => (active() ? "active" : "inactive") });
      document.body.appendChild(el);

      expect(el.className).toBe("inactive");

      setActive(true);
      // track is synchronous, so update is immediate
      expect(el.className).toBe("active");

      document.body.removeChild(el);
    });

    it("should accept a conditional class object", () => {
      const el = div({ class: { bold: true, italic: false, underline: true } });
      expect(el.className).toBe("bold underline");
    });

    it("should handle reactive conditional class object", () => {
      const [isActive, setActive] = signal(false);
      const el = div({
        class: { base: true, active: () => isActive() },
      });
      document.body.appendChild(el);

      expect(el.className).toBe("base");

      setActive(true);
      expect(el.className).toBe("base active");

      document.body.removeChild(el);
    });
  });

  describe("reactive style binding", () => {
    it("should accept reactive style properties", () => {
      const [color, setColor] = signal("red");
      const el = div({
        style: { color: () => color(), fontWeight: "bold" },
      });
      document.body.appendChild(el);

      expect(el.style.color).toBe("red");
      expect(el.style.fontWeight).toBe("bold");

      setColor("blue");
      expect(el.style.color).toBe("blue");

      document.body.removeChild(el);
    });
  });

  describe("ref binding", () => {
    it("should assign element to ref.current", () => {
      const r = ref<HTMLDivElement | null>(null);
      const el = div({ ref: r });

      expect(r.current).toBe(el);
      expect(r.current?.tagName).toBe("DIV");
    });
  });
});
