import { adoptThenable } from "../../utils/adoptThenable";
import { reportError } from "../errors";

// ---------------------------------------------------------------------------
// Enter / leave phases for `when()` / `match()` branches.
//
// A phase is "play this on these nodes, then tell me when it is over". It ends
// on the FIRST of:
//   - the custom `enter` / `leave` callback's promise settling (or the callback
//     returning synchronously);
//   - every element of the branch reporting the end of its CSS animation or
//     transition (`animationend` / `transitionend` on the element itself);
//   - a timeout derived from the computed styles (+ 50 ms of slack), capped by
//     `maxDuration` and by a hard 5 s ceiling, so a phase can never hang: an
//     infinite animation, an end event that never fires, or a promise that
//     never settles all end at the cap.
// A branch whose measured duration is zero (no animation, `display: none`, a
// reduced-motion stylesheet that shortens everything to ~0) ends synchronously.
// ---------------------------------------------------------------------------

/**
 * Animate the branches of a `when()` / `match()`. See `DirectiveOptions.transition`.
 *
 * `enterClass` and `leaveClass` are the option names (and types) of
 * `transition()` in `sibujs/motion`.
 */
export interface DirectiveTransition {
  /** Class added to the branch's elements when it is inserted, removed when its animation / transition ends. */
  enterClass?: string;
  /** Class added to the outgoing branch's elements; the branch is removed when their animation / transition ends. */
  leaveClass?: string;
  /**
   * How a branch switch is sequenced:
   * - `"both"` (default): the new branch is inserted (and enters) immediately,
   *   while the old one leaves alongside it.
   * - `"out-in"`: the new branch is built and inserted only once every
   *   outgoing branch has finished leaving.
   * - `"in-out"`: the new branch is inserted and enters first; the old one
   *   starts leaving when the enter has finished.
   */
  mode?: "both" | "out-in" | "in-out";
  /**
   * Custom JS leave (Web Animations, a library). Receives the branch's
   * top-level nodes; the branch is removed when the returned promise settles,
   * or right away when it returns nothing. Takes precedence over `leaveClass`.
   */
  leave?: (nodes: Node[]) => Promise<void> | void;
  /** Custom JS enter; see `leave`. Takes precedence over `enterClass`. */
  enter?: (nodes: Node[]) => Promise<void> | void;
  /**
   * Safety cap for one enter or leave, in ms. By default a phase waits for its
   * end events, or for the longest computed animation / transition (delay +
   * duration x iteration count) + 50 ms. Never more than 5000 ms.
   */
  maxDuration?: number;
  /** Also play the enter on the directive's first render. Default `false`. */
  appear?: boolean;
}

/** A phase in progress. */
export interface PhaseRun {
  /** End the phase now WITHOUT calling its completion (classes and listeners are removed). */
  cancel(): void;
}

const HARD_CAP_MS = 5000;
const SLACK_MS = 50;
// A total at or below this is "no animation": a reduced-motion stylesheet
// typically shortens durations to 0.01ms rather than 0.
const INSTANT_MS = 1;

/** `"0.3s, 120ms"` → `[300, 120]`. */
function parseTimes(list: string | undefined): number[] {
  if (!list) return [0];
  return list.split(",").map((part) => {
    const v = part.trim();
    const n = Number.parseFloat(v);
    if (!Number.isFinite(n)) return 0;
    return v.endsWith("ms") ? n : n * 1000;
  });
}

interface Timing {
  /** Longest end time in ms (Infinity for an infinite animation). */
  total: number;
  /** The end event that marks `total`. */
  event: "animationend" | "transitionend";
  /** How many such events to wait for. */
  count: number;
}

/** The longest animation or transition the element will run, from its computed style. */
function measure(el: Element): Timing | null {
  if (typeof getComputedStyle !== "function") return null;
  const cs = getComputedStyle(el);
  if (cs.display === "none") return null;

  const tDur = parseTimes(cs.transitionDuration);
  const tDel = parseTimes(cs.transitionDelay);
  let transition = 0;
  let transitions = 0;
  for (let i = 0; i < tDur.length; i++) {
    if (tDur[i] <= 0) continue;
    transitions++;
    transition = Math.max(transition, tDur[i] + tDel[i % tDel.length]);
  }

  const aDur = parseTimes(cs.animationDuration);
  const aDel = parseTimes(cs.animationDelay);
  const names = (cs.animationName || "").split(",");
  const iterations = (cs.animationIterationCount || "1").split(",");
  let animation = 0;
  let animations = 0;
  for (let i = 0; i < aDur.length; i++) {
    if (aDur[i] <= 0 || names[i % names.length].trim() === "none") continue;
    const raw = iterations[i % iterations.length].trim();
    const count = raw === "infinite" ? Number.POSITIVE_INFINITY : Number.parseFloat(raw) || 1;
    animations++;
    animation = Math.max(animation, aDel[i % aDel.length] + aDur[i] * count);
  }

  if (animation <= INSTANT_MS && transition <= INSTANT_MS) return null;
  return animation >= transition
    ? { total: animation, event: "animationend", count: animations }
    : { total: transition, event: "transitionend", count: transitions };
}

/**
 * Play one phase on `nodes` and call `onDone` when it is over.
 *
 * @returns The running phase, or `null` when it finished synchronously (in
 * which case `onDone` has already been called).
 */
export function runPhase(
  nodes: Node[],
  cls: string | undefined,
  custom: ((nodes: Node[]) => Promise<void> | void) | undefined,
  maxDuration: number | undefined,
  onDone: () => void,
  name: string,
): PhaseRun | null {
  const cap = Math.min(typeof maxDuration === "number" && maxDuration >= 0 ? maxDuration : HARD_CAP_MS, HARD_CAP_MS);
  const elements: Element[] = [];
  for (let i = 0; i < nodes.length; i++) if (nodes[i].nodeType === 1) elements.push(nodes[i] as Element);

  let finished = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cleanups: (() => void)[] = [];
  const finish = (complete: boolean): void => {
    if (finished) return;
    finished = true;
    if (timer !== null) clearTimeout(timer);
    for (let i = 0; i < cleanups.length; i++) cleanups[i]();
    if (complete) onDone();
  };
  const report = (error: unknown) => reportError(error, { phase: "async", name, node: elements[0] });

  if (custom) {
    let result: unknown;
    try {
      result = custom(nodes);
    } catch (error) {
      report(error);
    }
    const pending = adoptThenable(result);
    if (pending === null) {
      onDone();
      return null;
    }
    pending.then(
      () => finish(true),
      (error) => {
        report(error);
        finish(true);
      },
    );
    timer = setTimeout(() => finish(true), cap);
    return { cancel: () => finish(false) };
  }

  if (!cls || elements.length === 0) {
    onDone();
    return null;
  }

  for (let i = 0; i < elements.length; i++) elements[i].classList.add(cls);
  cleanups.push(() => {
    for (let i = 0; i < elements.length; i++) elements[i].classList.remove(cls);
  });

  // Measured AFTER the class is applied: reading the computed style resolves
  // the animation the class just started.
  let longest = 0;
  let waiting = 0;
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    const timing = measure(el);
    if (timing === null) continue;
    longest = Math.max(longest, timing.total);
    waiting++;
    let remaining = timing.count;
    const onEnd = (event: Event) => {
      // Ends bubbling up from descendants are theirs, not the branch's.
      if (event.target !== el) return;
      if (--remaining > 0) return;
      el.removeEventListener(timing.event, onEnd);
      if (--waiting === 0) finish(true);
    };
    el.addEventListener(timing.event, onEnd);
    cleanups.push(() => el.removeEventListener(timing.event, onEnd));
  }

  if (waiting === 0) {
    finish(true);
    return null;
  }
  timer = setTimeout(() => finish(true), Math.min(longest + SLACK_MS, cap));
  return { cancel: () => finish(false) };
}
