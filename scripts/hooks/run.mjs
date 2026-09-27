// Git hook runner, invoked by the thin shell stubs in `.githooks/`.
//
//   node scripts/hooks/run.mjs pre-commit
//   node scripts/hooks/run.mjs pre-push
//
// pre-commit is the quick gate, run on every commit:
//   staged-file guards -> lint -> source typecheck -> test typecheck
//   -> the unit tests related to the staged files (file names are passed to
//      Vitest as an argument vector, never through a shell)
//
// pre-push mirrors CI's `fast` job, so a push does not start a CI run that is
// already known to fail:
//   build -> source typecheck -> test typecheck -> lint -> full unit suite
//
// The build comes first for the same reason it does in CI: several suites read
// real files out of `dist/`, and against a stale or absent `dist/` they report
// failures that say nothing about the source.
//
// Checks run against the working tree, not the staged snapshot, so a partially
// staged file is checked as it is on disk. Skip a hook once with
// `git commit --no-verify` / `git push --no-verify`, or set SIBU_SKIP_HOOKS=1.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const hook = process.argv[2];

if (process.env.SIBU_SKIP_HOOKS === "1") {
  console.log(`[${hook}] skipped (SIBU_SKIP_HOOKS=1)`);
  process.exit(0);
}

// Vitest's CLI entry, run with this same Node binary. Going through `npx`
// needs a shell on Windows (to resolve the `.cmd` shim), and the staged file
// names are passed to Vitest: through a shell, a name containing `"`, `$()` or
// a backtick would break the quoting or run as shell syntax.
const VITEST_CLI = fileURLToPath(new URL("../../node_modules/vitest/vitest.mjs", import.meta.url));

/**
 * Run one check and stop the hook if it fails. `args` go straight to the
 * process as an argument vector, never through a shell.
 */
function run(label, file, args) {
  console.log(`\n[${hook}] ${label}`);
  const started = Date.now();
  const result = spawnSync(file, args, { stdio: "inherit" });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) {
    console.error(`\n[${hook}] FAILED: ${label}. Fix it, or bypass once with --no-verify.`);
    process.exit(result.status ?? 1);
  }
  console.log(`[${hook}] ok: ${label} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
}

/**
 * Run a package.json script. This one does use a shell: `npm` is a `.cmd` shim
 * on Windows, which cannot be spawned without one. The command line is built
 * only from constant script names, never from file names or other input.
 */
function runScript(label, script) {
  console.log(`\n[${hook}] ${label}\n> npm run ${script}`);
  const started = Date.now();
  const result = spawnSync(`npm run ${script}`, { stdio: "inherit", shell: true });
  if (result.status !== 0) {
    console.error(`\n[${hook}] FAILED: ${label}. Fix it, or bypass once with --no-verify.`);
    process.exit(result.status ?? 1);
  }
  console.log(`[${hook}] ok: ${label} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
}

function stagedFiles() {
  const out = spawnSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], {
    encoding: "utf8",
  });
  if (out.status !== 0) {
    console.error(`[${hook}] could not list staged files`);
    process.exit(1);
  }
  return out.stdout.split("\0").filter(Boolean);
}

// Two things that reached a commit before and cost a cleanup each time:
//
// - Scratch copies used to prove a regression test fails on the old code
//   (`__routerOrigTmp.ts`, `__orig-tmp.test.ts`). They are full duplicates of
//   real modules; one shipped a second router with its own module state.
// - Raw U+2028 / U+2029 characters. Editors flag them as "unusual line
//   terminators" and offer to remove them, which silently rewrites a string
//   such as `case "\u2028":` into a duplicate `case "":`. Source must spell them
//   as escapes.
function checkStaged(files) {
  const problems = [];
  const scratch = /(^|\/)__[^/]*(tmp|orig)[^/]*$/i;
  const separators = new RegExp(`[${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`);
  for (const file of files) {
    if (scratch.test(file)) problems.push(`${file}: looks like a scratch file (__*tmp* / __*orig*)`);
    if (!/\.(m?[jt]s|json|md)$/.test(file)) continue;
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (separators.test(lines[i])) {
        problems.push(`${file}:${i + 1}: raw U+2028/U+2029 character; write it as an escape`);
      }
    }
  }
  if (problems.length > 0) {
    console.error(`\n[${hook}] staged-file guards failed:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`[${hook}] ok: staged-file guards (${files.length} files)`);
}

if (hook === "pre-commit") {
  const files = stagedFiles();
  if (files.length === 0) process.exit(0);
  checkStaged(files);
  runScript("lint", "lint");
  runScript("source typecheck", "typecheck");
  runScript("test typecheck", "typecheck:tests");
  // Only tests whose import graph reaches a staged source or test file. The full
  // suite runs on pre-push; here it would make every commit take minutes. A
  // name starting with `-` is left out so it cannot be read as a CLI flag.
  const related = files.filter(
    (f) => !f.startsWith("-") && (/^(src|tests)\/.*\.ts$/.test(f) || /^[^/]+\.ts$/.test(f)),
  );
  if (related.length > 0) {
    run("related unit tests", process.execPath, [VITEST_CLI, "related", "--run", "--passWithNoTests", ...related]);
  }
} else if (hook === "pre-push") {
  runScript("build", "build");
  runScript("source typecheck", "typecheck");
  runScript("test typecheck", "typecheck:tests");
  runScript("lint", "lint");
  run("unit suite", process.execPath, [VITEST_CLI, "run", "--reporter=dot"]);
} else {
  console.error(`unknown hook: ${hook}`);
  process.exit(1);
}
