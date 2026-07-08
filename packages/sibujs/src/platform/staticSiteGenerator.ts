export interface SSGOptions {
  routes: string[];
  renderFn: (path: string) => Promise<string>;
  outDir?: string;
}

export interface SSGResult {
  pages: Array<{ path: string; html: string }>;
  errors: Array<{ path: string; error: Error }>;
}

/**
 * Generate a static site by iterating over routes and collecting rendered HTML.
 * This is a pure async function — it does NOT write files, only returns results.
 */
export async function generateStaticSite(options: SSGOptions): Promise<SSGResult> {
  const { routes, renderFn } = options;
  const pages: SSGResult["pages"] = [];
  const errors: SSGResult["errors"] = [];

  for (const route of routes) {
    try {
      const html = await renderFn(route);
      pages.push({ path: route, html });
    } catch (err) {
      errors.push({
        path: route,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  return { pages, errors };
}
