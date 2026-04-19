import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../src/components/ErrorBoundary";
import { signal } from "../src/core/signals/signal";

// Helper to mount and extract container
function mountComponent(component: () => HTMLElement) {
  const container = document.createElement("div");
  const el = component();
  container.appendChild(el);
  return { container, el };
}

// Helper to wait for async operations
const waitForAsync = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("ErrorBoundary Working Features", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Suppress console.error during tests to avoid noise
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe("Basic Error Catching", () => {
    it("should catch errors thrown by nodes and display fallback", async () => {
      const [shouldThrow, setShouldThrow] = signal(false);

      function TestComponent() {
        if (shouldThrow()) {
          throw new Error("Test error message");
        }
        const div = document.createElement("div");
        div.textContent = "Normal content";
        return div;
      }

      const tree = () =>
        ErrorBoundary(
          {
            fallback: (error) => {
              const div = document.createElement("div");
              div.textContent = `Error caught: ${error.message}`;
              return div;
            },
          },
          TestComponent,
        );

      const { container } = mountComponent(tree);
      await waitForAsync();

      // Initially should render normally
      expect(container.textContent).toBe("Normal content");

      // Trigger error
      setShouldThrow(true);
      await waitForAsync();
      expect(container.textContent).toBe("Error caught: Test error message");
    });

    it("should provide retry functionality", async () => {
      const [shouldThrow, setShouldThrow] = signal(true);

      function TestComponent() {
        if (shouldThrow()) {
          throw new Error("Retry test error");
        }
        const div = document.createElement("div");
        div.textContent = "Success after retry";
        return div;
      }

      const tree = () =>
        ErrorBoundary(
          {
            fallback: (error, retry) => {
              const div = document.createElement("div");
              div.textContent = `Error: ${error.message}`;

              const button = document.createElement("button");
              button.textContent = "Retry";
              button.onclick = () => {
                setShouldThrow(false);
                retry?.();
              };

              div.appendChild(button);
              return div;
            },
          },
          TestComponent,
        );

      const { container } = mountComponent(tree);
      await waitForAsync();

      // Should show error initially
      expect(container.textContent).toContain("Error: Retry test error");

      // Click retry button
      const retryButton = container.querySelector("button");
      expect(retryButton).toBeTruthy();
      retryButton?.click();
      await waitForAsync();

      // Should show success content
      expect(container.textContent).toBe("Success after retry");
    });

    it("should handle initialization errors", async () => {
      function FailingComponent() {
        throw new Error("Initialization failed");
      }

      const tree = () =>
        ErrorBoundary(
          {
            fallback: (error) => {
              const div = document.createElement("div");
              div.textContent = `Init error: ${error.message}`;
              return div;
            },
          },
          FailingComponent,
        );

      const { container } = mountComponent(tree);
      await waitForAsync();
      expect(container.textContent).toBe("Init error: Initialization failed");
    });
  });

  describe("Nested ErrorBoundaries", () => {
    it("should handle nested boundaries correctly", async () => {
      const [triggerInner, setTriggerInner] = signal(false);

      function InnerComponent() {
        if (triggerInner()) {
          throw new Error("Inner error");
        }
        const div = document.createElement("div");
        div.textContent = "Inner content";
        return div;
      }

      function MiddleComponent() {
        return ErrorBoundary(
          {
            fallback: (error) => {
              const div = document.createElement("div");
              div.textContent = `Inner fallback: ${error.message}`;
              return div;
            },
          },
          InnerComponent,
        );
      }

      const tree = () =>
        ErrorBoundary(
          {
            fallback: (error) => {
              const div = document.createElement("div");
              div.textContent = `Outer fallback: ${error.message}`;
              return div;
            },
          },
          MiddleComponent,
        );

      const { container } = mountComponent(tree);
      await waitForAsync();

      // Initially should render inner content
      expect(container.textContent).toBe("Inner content");

      // Trigger inner error - should be caught by inner boundary
      setTriggerInner(true);
      await waitForAsync();
      expect(container.textContent).toBe("Inner fallback: Inner error");
    });
  });

  describe("Error Recovery", () => {
    it("should clear error state when nodes render successfully again", async () => {
      const [errorState, setErrorState] = signal<"normal" | "error" | "recovered">("normal");

      function TestComponent() {
        switch (errorState()) {
          case "error":
            throw new Error("Temporary error");
          case "recovered": {
            const div = document.createElement("div");
            div.textContent = "Recovered successfully";
            return div;
          }
          default: {
            const normalDiv = document.createElement("div");
            normalDiv.textContent = "Normal state";
            return normalDiv;
          }
        }
      }

      const tree = () =>
        ErrorBoundary(
          {
            fallback: (error, retry) => {
              const div = document.createElement("div");
              div.textContent = `Error state: ${error.message}`;

              const button = document.createElement("button");
              button.textContent = "Recover";
              button.onclick = () => {
                setErrorState("recovered");
                retry?.();
              };

              div.appendChild(button);
              return div;
            },
          },
          TestComponent,
        );

      const { container } = mountComponent(tree);
      await waitForAsync();

      // Initially normal
      expect(container.textContent).toBe("Normal state");

      // Trigger error
      setErrorState("error");
      await waitForAsync();
      expect(container.textContent).toContain("Error state: Temporary error");

      // Recover
      const recoverButton = container.querySelector("button");
      recoverButton?.click();
      await waitForAsync();
      expect(container.textContent).toBe("Recovered successfully");
    });
  });

  describe("Error Type Handling", () => {
    it("should handle string errors", async () => {
      function StringErrorComponent() {
        throw "String error message";
      }

      const tree = () =>
        ErrorBoundary(
          {
            fallback: (error) => {
              const div = document.createElement("div");
              div.textContent = `Caught: ${error.message}`;
              return div;
            },
          },
          StringErrorComponent,
        );

      const { container } = mountComponent(tree);
      await waitForAsync();
      expect(container.textContent).toBe("Caught: String error message");
    });

    it("should handle Error objects", async () => {
      function ErrorObjectComponent() {
        throw new Error("Error object message");
      }

      const tree = () =>
        ErrorBoundary(
          {
            fallback: (error) => {
              const div = document.createElement("div");
              div.textContent = `Caught: ${error.message}`;
              return div;
            },
          },
          ErrorObjectComponent,
        );

      const { container } = mountComponent(tree);
      await waitForAsync();
      expect(container.textContent).toBe("Caught: Error object message");
    });
  });

  describe("Edge Cases", () => {
    it("should handle components that return null/undefined gracefully", async () => {
      const [returnType, setReturnType] = signal<"element" | "null" | "undefined">("element");

      function TestComponent() {
        switch (returnType()) {
          case "null":
            return null as unknown as HTMLElement;
          case "undefined":
            return undefined as unknown as HTMLElement;
          default: {
            const div = document.createElement("div");
            div.textContent = "Valid element";
            return div;
          }
        }
      }

      const tree = () =>
        ErrorBoundary(
          {
            fallback: (error) => {
              const div = document.createElement("div");
              div.textContent = `Error: ${error.message}`;
              return div;
            },
          },
          TestComponent,
        );

      const { container } = mountComponent(tree);
      await waitForAsync();

      // Initially should render element
      expect(container.textContent).toBe("Valid element");

      // Test null return - should handle gracefully
      setReturnType("null");
      await waitForAsync();
      // Should not crash

      // Test undefined return - should handle gracefully
      setReturnType("undefined");
      await waitForAsync();
      // Should not crash

      // Back to normal
      setReturnType("element");
      await waitForAsync();
      expect(container.textContent).toBe("Valid element");
    });

    it("should handle multiple error/recovery cycles", async () => {
      const [cycle, setCycle] = signal(0);

      function CyclingComponent() {
        const currentCycle = cycle();
        if (currentCycle % 2 === 1) {
          throw new Error(`Error in cycle ${currentCycle}`);
        }
        const div = document.createElement("div");
        div.textContent = `Success in cycle ${currentCycle}`;
        return div;
      }

      const tree = () =>
        ErrorBoundary(
          {
            fallback: (error, retry) => {
              const div = document.createElement("div");
              div.textContent = error.message;

              const button = document.createElement("button");
              button.textContent = "Next Cycle";
              button.onclick = () => {
                setCycle((c) => c + 1);
                retry?.();
              };

              div.appendChild(button);
              return div;
            },
          },
          CyclingComponent,
        );

      const { container } = mountComponent(tree);
      await waitForAsync();

      // Cycle 0: Success
      expect(container.textContent).toBe("Success in cycle 0");

      // Cycle 1: Error
      setCycle(1);
      await waitForAsync();
      expect(container.textContent).toContain("Error in cycle 1");

      // Cycle 2: Success
      const button = container.querySelector("button");
      button?.click();
      await waitForAsync();
      expect(container.textContent).toBe("Success in cycle 2");
    });
  });
});
