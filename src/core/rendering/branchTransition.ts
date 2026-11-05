import { adoptThenable } from "../../utils/adoptThenable";
import { reportError } from "../errors";

// ---------------------------------------------------------------------------
// Enter / leave phases for `when()` / `match()` branches.
//
// A phase is "play this on these nodes, then tell me when it is over". It ends
// on the FIRST of:
//   - the custom `enter` / `leave` callback's promise settling (or the callback
//     returning synchronously);
//   - every animation and transition each element of the branch actually
//     started having finished (`getAnimations()`); where that API is missing,
//     an `animationend` / `transitionend` on the element itself for every
//     `animation-name` / `transition-property` entry;
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
  /**
   * Class-based phases only: elements that joined the branch while the phase
   * runs (rows a caller-owned `each()` added). They get the class and the
   * phase waits for their animations too, within its original deadline.
   */
  add?(elements: Element[]): void;
}

const HARD_CAP_MS = 5000;
const SLACK_MS = 50;
// A total at or below this is "no animation": a reduced-motion stylesheet
// typically shortens durations to 0.01ms rather than 0.
const INSTANT_MS = 1;
const END_EVENTS = ["transitionend", "animationend"] as const;

/** A comma-separated computed list, trimmed; `fallback` when the engine reports nothing. */
function parseList(list: string | undefined, fallback: string): string[] {
  return (list?.trim() ? list : fallback).split(",").map((part) => part.trim());
}

/** `"0.3s, 120ms"` → `[300, 120]`. */
function parseTimes(list: string | undefined): number[] {
  return parseList(list, "0s").map((v) => (Number.parseFloat(v) || 0) * (v.endsWith("ms") ? 1 : 1000));
}

interface Timing {
  /** Longest end time in ms (Infinity for an infinite animation). */
  total: number;
  /** End events still expected, per `transition-property` entry. */
  transitions: Map<string, number>;
  /** End events still expected, per `animation-name` entry. */
  animations: Map<string, number>;
  /** Total of both maps. */
  pending: number;
}

/**
 * Every transition and animation the element will run, from its computed style.
 *
 * CSS list matching: `transition-property` and `animation-name` say how many
 * there are; the duration, delay and iteration lists repeat to match them, and
 * their surplus entries are ignored. `transition-property` defaults to `all`;
 * a `none` entry runs nothing. Returns null when nothing runs longer than
 * `INSTANT_MS`.
 */
function measure(el: Element): Timing | null {
  if (typeof getComputedStyle !== "function") return null;
  const cs = getComputedStyle(el);
  if (cs.display === "none") return null;
  const timing: Timing = { total: 0, transitions: new Map(), animations: new Map(), pending: 0 };
  const expect = (
    map: Map<string, number>,
    names: string[],
    durations: number[],
    delays: number[],
    iterations: string[],
  ): void => {
    for (let i = 0; i < names.length; i++) {
      const duration = durations[i % durations.length];
      if (names[i] === "none" || duration <= 0) continue;
      const count = iterations[i % iterations.length];
      const runs = count === "infinite" ? Number.POSITIVE_INFINITY : Number.parseFloat(count) || 1;
      timing.total = Math.max(timing.total, delays[i % delays.length] + duration * runs);
      map.set(names[i], (map.get(names[i]) ?? 0) + 1);
      timing.pending++;
    }
  };
  expect(
    timing.transitions,
    parseList(cs.transitionProperty, "all"),
    parseTimes(cs.transitionDuration),
    parseTimes(cs.transitionDelay),
    ["1"],
  );
  expect(
    timing.animations,
    parseList(cs.animationName, "none"),
    parseTimes(cs.animationDuration),
    parseTimes(cs.animationDelay),
    parseList(cs.animationIterationCount, "1"),
  );
  return timing.total <= INSTANT_MS ? null : timing;
}

/**
 * Which expected entry an end event completes: its own name, the listed
 * shorthand of a longhand (`margin` for `margin-top`), `all`, or — for an
 * event carrying no name (a synthetic one) — any pending entry.
 */
function matchEntry(map: Map<string, number>, name: unknown): string | undefined {
  if (typeof name !== "string" || name === "") return map.keys().next().value;
  if (map.has(name)) return name;
  for (const key of map.keys()) if (name.startsWith(`${key}-`)) return key;
  return map.has("all") ? "all" : undefined;
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
  // `elements` grows when late elements join (see `add`), so the class comes
  // off every one of them however the phase ends.
  cleanups.push(() => {
    for (let i = 0; i < elements.length; i++) elements[i].classList.remove(cls);
  });

  // The fallback deadline is absolute: `maxDuration` and the 5 s ceiling are
  // measured from the phase start, so elements joining later can move the
  // deadline out to cover their own animation, never past that cap.
  const capAt = Date.now() + cap;
  let deadline = 0;
  const arm = (until: number): void => {
    const at = Math.min(until, capAt);
    if (timer !== null && at <= deadline) return;
    if (timer !== null) clearTimeout(timer);
    deadline = at;
    timer = setTimeout(() => finish(true), Math.max(0, at - Date.now()));
  };

  // Enrolls `el` in the phase; returns how long its animations run (ms), or
  // -1 when it runs none. Measured AFTER the class is applied: reading the
  // computed style resolves the animation the class just started. An element
  // is done when every transition and animation it runs has ended, so the
  // first of several (a shared duration with different delays) cannot end
  // the phase.
  let waiting = 0;
  const enroll = (el: Element): number => {
    const timing = measure(el);
    if (timing === null) return -1;
    // Where the engine exposes them (every supported browser), the animations
    // and transitions that actually started are known exactly: a listed
    // `transition-property` whose value did not change starts none, so it is
    // not waited for. Each settles on finish or cancel; the deadline still
    // caps the phase. Reading them flushes the style change above.
    const running = typeof el.getAnimations === "function" ? el.getAnimations() : null;
    if (running !== null) {
      if (running.length === 0) return -1;
      waiting++;
      let left = running.length;
      const settle = () => {
        if (--left === 0 && !finished && --waiting === 0) finish(true);
      };
      for (const animation of running) animation.finished.then(settle, settle);
      return timing.total;
    }
    waiting++;
    const onEnd = (event: Event) => {
      // Ends bubbling up from descendants are theirs, not the branch's.
      if (event.target !== el || timing.pending === 0) return;
      const transition = event.type === "transitionend";
      const map = transition ? timing.transitions : timing.animations;
      const key = matchEntry(
        map,
        (event as TransitionEvent & AnimationEvent)[transition ? "propertyName" : "animationName"],
      );
      if (key === undefined) return;
      const left = (map.get(key) as number) - 1;
      if (left > 0) map.set(key, left);
      else map.delete(key);
      if (--timing.pending === 0 && --waiting === 0) finish(true);
    };
    for (const type of END_EVENTS) el.addEventListener(type, onEnd);
    cleanups.push(() => {
      for (const type of END_EVENTS) el.removeEventListener(type, onEnd);
    });
    return timing.total;
  };

  let longest = -1;
  for (let i = 0; i < elements.length; i++) longest = Math.max(longest, enroll(elements[i]));
  if (waiting === 0) {
    finish(true);
    return null;
  }
  arm(Date.now() + longest + SLACK_MS);
  return {
    cancel: () => finish(false),
    add: (late) => {
      if (finished) return;
      for (let i = 0; i < late.length; i++) {
        const el = late[i];
        if (elements.includes(el)) continue;
        el.classList.add(cls);
        elements.push(el);
        const total = enroll(el);
        if (total >= 0) arm(Date.now() + total + SLACK_MS);
      }
    },
  };
}
