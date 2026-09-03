// Tree-shaking + `sideEffects: false` probe: EXTERNAL-STATE PRIMITIVE ONLY.
//
// `external()` is the seam for state SibuJS does not own. A page that uses it
// for a canvas, an editor or a socket cache must not be charged for the island
// runtime, the router, the data layer or anything else — so this probe imports
// it beside `signal`/`effect` and nothing more, and the matrix asserts that no
// other subsystem's marker survives into the bundle.
import { effect, external, signal } from "sibujs";

// A deliberately opaque mutable object — the thing SibuJS cannot observe.
const engine = { moves: 0 };
const changed = external();

let seen = -1;
const stop = effect(() => {
  changed.track();
  seen = engine.moves;
});

engine.moves = 7;
changed.invalidate();

const [n, setN] = signal(0);
setN(1);
stop();
engine.moves = 99;
changed.invalidate(); // must not reach the disposed effect

const ok = seen === 7 && n() === 1;
console.log(`SIBU_PROBE external-only ${ok ? "OK" : "BROKEN"} seen=${seen} n=${n()}`);
if (!ok) process.exit?.(1);
