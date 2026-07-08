import { describe, expect, it, vi } from "vitest";
import { composeMiddleware, createMiddlewareChain } from "../src/platform/routeMiddleware";

describe("routeMiddleware", () => {
  it("composeMiddleware chains middleware functions in order", async () => {
    const order: string[] = [];

    const mw1 = vi.fn(async (_ctx, next) => {
      order.push("mw1-before");
      await next();
      order.push("mw1-after");
    });

    const mw2 = vi.fn(async (_ctx, next) => {
      order.push("mw2-before");
      await next();
      order.push("mw2-after");
    });

    const composed = composeMiddleware(mw1, mw2);
    const finalNext = vi.fn();

    await composed({ path: "/test", params: {} }, finalNext);

    expect(order).toEqual(["mw1-before", "mw2-before", "mw2-after", "mw1-after"]);
    expect(finalNext).toHaveBeenCalled();
  });

  it("composeMiddleware passes context to all middleware", async () => {
    const receivedContexts: Array<{ path: string; params: Record<string, string> }> = [];

    const mw = async (ctx: { path: string; params: Record<string, string> }, next: () => Promise<void>) => {
      receivedContexts.push(ctx);
      await next();
    };

    const composed = composeMiddleware(mw, mw);
    await composed({ path: "/users", params: { id: "42" } }, () => {});

    expect(receivedContexts).toHaveLength(2);
    expect(receivedContexts[0].path).toBe("/users");
    expect(receivedContexts[0].params).toEqual({ id: "42" });
  });

  it("middleware can short-circuit by not calling next", async () => {
    const mw1 = vi.fn(async () => {
      // Intentionally not calling next()
    });

    const mw2 = vi.fn(async (_ctx, next) => {
      await next();
    });

    const composed = composeMiddleware(mw1, mw2);
    const finalNext = vi.fn();

    await composed({ path: "/blocked", params: {} }, finalNext);

    expect(mw1).toHaveBeenCalled();
    expect(mw2).not.toHaveBeenCalled();
    expect(finalNext).not.toHaveBeenCalled();
  });

  it("createMiddlewareChain provides a builder API", async () => {
    const chain = createMiddlewareChain();
    const order: string[] = [];

    chain.use(async (_ctx, next) => {
      order.push("first");
      await next();
    });

    chain.use(async (_ctx, next) => {
      order.push("second");
      await next();
    });

    await chain.run({ path: "/test", params: {} });

    expect(order).toEqual(["first", "second"]);
  });

  it("async middleware is properly awaited", async () => {
    const chain = createMiddlewareChain();
    const order: string[] = [];

    chain.use(async (_ctx, next) => {
      order.push("start");
      await new Promise((r) => setTimeout(r, 10));
      order.push("after-delay");
      await next();
    });

    chain.use(async (_ctx, next) => {
      order.push("second");
      await next();
    });

    await chain.run({ path: "/async", params: {} });

    expect(order).toEqual(["start", "after-delay", "second"]);
  });
});
