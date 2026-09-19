import { expect, it, vi } from "vitest";
import { setRuntimeErrorHandler } from "../../src/core/errors";
import { when } from "../../src/core/rendering/directives";
import { div } from "../../src/core/rendering/html";
it("deferred first render that throws", async () => {
  const handler = vi.fn();
  setRuntimeErrorHandler(handler);
  const host = div() as HTMLElement;
  document.body.appendChild(host);
  host.appendChild(
    when(
      () => true,
      () => {
        throw new Error("deferred boom");
      },
    ),
  );
  await new Promise((r) => setTimeout(r, 0));
  console.log("handler calls:", handler.mock.calls.length, handler.mock.calls[0]?.[1]);
  setRuntimeErrorHandler(null);
});
