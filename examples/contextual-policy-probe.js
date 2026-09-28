// Loaded only by examples/contextual-policy-security-browser.html. Counts its
// own executions so the spec can tell "never requested" from "requested and
// run". The spec intercepts every request for the runtime-chosen variant.
window.__probeRuns = (window.__probeRuns || 0) + 1;
