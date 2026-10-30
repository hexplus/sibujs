// Scenarios shared by `ssr-head-lifecycle.test.ts` (jsdom) and
// `ssr-head-lifecycle.node.test.ts` (the built-in server DOM): a server
// `Head()` layer belongs to its component, and its getters are resolved
// against the settled render.

import { when } from "../src/core/rendering/directives";
import { div, p } from "../src/core/rendering/html";
import { signal } from "../src/core/signals/signal";
import { trackPending } from "../src/core/ssr-context";
import { query } from "../src/data/query";
import { Head } from "../src/platform/head";
import { renderRoute } from "../src/platform/renderRoute";
import { renderToStringAsync } from "../src/platform/ssrAsync";
import type { RouteDef } from "../src/plugins/router";

export const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Registered work that flips `set` to `value` after `ms`, before serialization. */
export function later<T>(ms: number, set: (v: T) => void, value: T): void {
  trackPending(
    delay(ms).then(() => set(value)),
    "test:flip",
  );
}

/** A page whose temporary `when()` branch declares a title and `noindex`, then goes away. */
export function temporaryBranchRoutes(): RouteDef[] {
  return [
    {
      path: "/",
      component: () => {
        const [show, setShow] = signal(true);
        later(5, setShow, false);
        return div([
          Head({ title: "Page", meta: [{ name: "description", content: "Outer description" }] }),
          when(
            () => show(),
            () =>
              div([
                Head({
                  title: "Temporary",
                  meta: [
                    { name: "robots", content: "noindex" },
                    { name: "description", content: "Inner description" },
                  ],
                }),
                p("temporary body"),
              ]),
            () => p("final body"),
          ),
        ]);
      },
    },
  ];
}

export async function renderTemporaryBranch() {
  return renderRoute(temporaryBranchRoutes(), "/");
}

/** A page whose title, description and Open Graph title come from a query. */
export async function renderQueryBackedHead() {
  return renderToStringAsync(() => {
    const q = query("page-title", async () => {
      await delay(5);
      return "Loaded title";
    });
    return div([
      Head({
        title: () => q.data() ?? "Loading",
        meta: [
          { name: "description", content: () => `About ${q.data() ?? "nothing yet"}` },
          { property: "og:title", content: () => q.data() ?? "" },
        ],
      }),
      p(() => q.data() ?? "Loading"),
    ]);
  });
}
