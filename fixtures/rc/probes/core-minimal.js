// Tree-shaking + `sideEffects: false` probe: CORE ONLY.
//
// Imports a single reactive primitive and nothing else. Two things are being
// measured at once:
//   1. does the bundle still WORK (i.e. `sideEffects: false` did not let the
//      bundler drop the reactive runtime's Symbol.for registry initialisation)?
//   2. is unrelated machinery (router / query / SSR / devtools / widgets)
//      absent from the output?
// The marker line is what the runtime smoke test greps for.
import { batch, derived, effect, signal } from "sibujs";

const [count, setCount] = signal(0);
const doubled = derived(() => count() * 2);

let runs = 0;
const stop = effect(() => {
  doubled();
  runs++;
});

setCount(1);
batch(() => {
  setCount(2);
  setCount(3);
});
stop();

const ok = count() === 3 && doubled() === 6 && runs === 3;
console.log(`SIBU_PROBE core-minimal ${ok ? "OK" : "BROKEN"} count=${count()} doubled=${doubled()} runs=${runs}`);
if (!ok) process.exit?.(1);
