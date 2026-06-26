// Minimal static file server for the browser tests that need real HTTP (the
// lazy-`import()` path — ES module imports are blocked over file://). Serves the
// package root with correct MIME types. Run by Playwright's `webServer`.
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 5099;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    const filePath = normalize(join(root, urlPath));
    // Path-traversal guard — never serve outside the package root.
    if (filePath !== root && !filePath.startsWith(root + sep)) {
      res.writeHead(403);
      return res.end("forbidden");
    }
    const data = await readFile(filePath);
    res.writeHead(200, { "content-type": TYPES[extname(filePath)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}).listen(PORT, () => {
  console.log(`[tests-browser] serving ${root} on http://localhost:${PORT}`);
});
