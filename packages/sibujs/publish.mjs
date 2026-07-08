#!/usr/bin/env node

import { execSync, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkgPath = join(__dirname, "package.json");

// ── Helpers ──────────────────────────────────────────────────────────────────

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { stdio: "inherit", cwd: __dirname, ...opts });
  } catch {
    return null;
  }
}

// Argv-array form: safe against shell-interpolation of version strings.
// Usage: runArgs("git", ["commit", "-m", msg])
function runArgs(file, args, opts = {}) {
  // Throw on failure so callers (release flow) can abort instead of silently
  // proceeding to tag/publish with broken state. The previous swallow-and-return-null
  // could leave a half-committed release on a pre-commit hook failure.
  return execFileSync(file, args, { stdio: "inherit", cwd: __dirname, ...opts });
}

function runSilent(cmd) {
  try {
    return execSync(cmd, { cwd: __dirname, encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

function readPkg() {
  return JSON.parse(readFileSync(pkgPath, "utf-8"));
}

function writePkg(pkg) {
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
}

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function abort(msg) {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
}

function log(msg) {
  console.log(`\n► ${msg}`);
}

function bumpVersion(version, type) {
  const [major, minor, patch] = version.split(".").map(Number);
  switch (type) {
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "major":
      return `${major + 1}.0.0`;
    default:
      return null;
  }
}

// ── Pre-flight checks ───────────────────────────────────────────────────────

async function preflight() {
  log("Running pre-flight checks...");

  // Check for uncommitted changes
  const status = runSilent("git status --porcelain");
  if (status) {
    abort("Working directory is not clean. Commit or stash changes first.");
  }

  // Check current branch
  const branch = runSilent("git rev-parse --abbrev-ref HEAD");
  if (branch && !["main", "master"].includes(branch)) {
    console.warn(`\n⚠ You are on branch "${branch}", not main/master.`);
    const proceed = await ask("Continue anyway? (y/N) ");
    if (proceed.toLowerCase() !== "y") {
      abort("Aborted.");
    }
  }

  // Check npm login
  const whoami = runSilent("npm whoami");
  if (!whoami) {
    abort("Not logged in to npm. Run `npm login` first.");
  }
  console.log(`  Logged in as: ${whoami}`);
}

// ── Version selection ────────────────────────────────────────────────────────

async function selectVersion() {
  const pkg = readPkg();
  const current = pkg.version;

  console.log(`\n  Current version: ${current}`);
  console.log(`  1) patch → ${bumpVersion(current, "patch")}`);
  console.log(`  2) minor → ${bumpVersion(current, "minor")}`);
  console.log(`  3) major → ${bumpVersion(current, "major")}`);
  console.log(`  4) custom`);

  const choice = await ask("\nSelect version bump (1-4): ");

  let newVersion;
  switch (choice) {
    case "1":
      newVersion = bumpVersion(current, "patch");
      break;
    case "2":
      newVersion = bumpVersion(current, "minor");
      break;
    case "3":
      newVersion = bumpVersion(current, "major");
      break;
    case "4":
      newVersion = await ask("Enter custom version: ");
      if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(newVersion)) {
        abort(`Invalid version format: "${newVersion}"`);
      }
      break;
    default:
      abort("Invalid choice.");
  }

  const confirm = await ask(`\n  Bump ${current} → ${newVersion}? (y/N) `);
  if (confirm.toLowerCase() !== "y") {
    abort("Aborted.");
  }

  return newVersion;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n╔══════════════════════════════════════╗");
  console.log("║       SibuJS — Publish to npm          ║");
  console.log("╚══════════════════════════════════════╝");

  // 1. Pre-flight
  await preflight();

  // 2. Version bump — capture pre-bump version so we can roll back on failure
  const newVersion = await selectVersion();
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(newVersion)) {
    abort(`Invalid version format: "${newVersion}"`);
  }
  const pkg = readPkg();
  const previousVersion = pkg.version;
  pkg.version = newVersion;
  writePkg(pkg);
  console.log(`  Updated package.json to v${newVersion}`);

  // Helper: restore package.json to its pre-bump state
  const restoreVersion = () => {
    const current = readPkg();
    current.version = previousVersion;
    writePkg(current);
    console.log(`  Restored package.json to v${previousVersion}`);
  };

  // 3. Build
  log("Building...");
  if (run("npm run build") === null) {
    restoreVersion();
    abort("Build failed.");
  }

  // 4. Tests
  log("Running tests...");
  if (run("npm run test -- --run") === null) {
    restoreVersion();
    abort("Tests failed.");
  }

  // 5. Publish FIRST so a publish failure leaves no orphaned commit/tag
  // behind. OTP is handled interactively by npm if required.
  log("Publishing to npm...");
  // publishConfig.access + provenance are set in package.json so the CLI flag
  // is redundant; keep --access explicit as a belt-and-braces guard against
  // private-by-default registries.
  if (run("npm publish --access public") === null) {
    restoreVersion();
    abort("Publish failed. Reverted package.json; no git commit/tag created.");
  }

  // 6. Git commit & tag — only after publish succeeds. Args as array so the
  // version string cannot be shell-interpreted. runArgs throws on failure
  // (e.g. pre-commit hook), aborting before push.
  log("Creating git commit and tag...");
  try {
    runArgs("git", ["add", "package.json"]);
    runArgs("git", ["commit", "-m", `release: v${newVersion}`]);
    runArgs("git", ["tag", `v${newVersion}`]);
  } catch (err) {
    abort(
      `Publish succeeded but git commit/tag failed (${err && err.message ? err.message : err}). ` +
        `You'll need to commit and tag v${newVersion} manually.`,
    );
  }

  // 7. Push
  log("Pushing to remote...");
  run("git push");
  run("git push --tags");

  // 8. Done
  console.log("\n╔══════════════════════════════════════╗");
  console.log(`║  ✔ Published sibujs@${newVersion.padEnd(19)}║`);
  console.log(`║  https://www.npmjs.com/package/sibujs   ║`);
  console.log("╚══════════════════════════════════════╝\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
