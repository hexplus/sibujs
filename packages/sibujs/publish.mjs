#!/usr/bin/env node

// SibuJS is a pnpm workspace of three published packages
// (@sibujs/core -> sibujs -> @sibujs/labs). The ONLY supported publish path is
// `pnpm -r publish`, run from the repo root: pnpm rewrites the `workspace:^`
// dependency ranges to concrete published versions and publishes in topological
// order. A plain `npm publish` from this package would ship the literal
// `workspace:` protocol and produce an uninstallable tarball, so this script no
// longer performs any publishing itself.
//
// In CI, publishing is handled by .github/workflows/publish.yml on a GitHub
// Release. This script exists only as a guarded local convenience that forwards
// to the same `pnpm -r publish` flow after a preflight check.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Repo root is two levels up from packages/sibujs.
const repoRoot = resolve(__dirname, "..", "..");

function run(file, args) {
  return execFileSync(file, args, { stdio: "inherit", cwd: repoRoot });
}

function runSilent(file, args) {
  try {
    return execFileSync(file, args, { cwd: repoRoot, encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

function abort(msg) {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
}

console.log("\nSibuJS — workspace publish (pnpm -r)\n");

// Preflight: clean tree + npm auth.
const status = runSilent("git", ["status", "--porcelain"]);
if (status) {
  abort("Working directory is not clean. Commit or stash changes first.");
}

const whoami = runSilent("npm", ["whoami"]);
if (!whoami) {
  abort("Not logged in to npm. Run `npm login` first.");
}
console.log(`  Logged in as: ${whoami}`);

// Publish every public workspace package in topological order. pnpm rewrites the
// `workspace:` ranges. `--tag next` keeps the 4.0.0-alpha line off `latest`.
console.log("\n  Publishing workspace with `pnpm -r publish --tag next`…\n");
try {
  run("pnpm", ["-r", "publish", "--tag", "next", "--access", "public"]);
} catch {
  abort("`pnpm -r publish` failed.");
}

console.log("\n✔ Workspace published.\n");
