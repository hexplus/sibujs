// Positive control for tests-browser/head-url-security.spec.ts: proves the
// probe can observe a script that Head() accepts actually executing, so the
// negative assertions about a refused one are meaningful rather than merely
// early.
globalThis.__sibuSafeScriptRan = true;
