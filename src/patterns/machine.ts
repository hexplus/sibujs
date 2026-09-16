import { signal } from "../core/signals/signal";
import { batch } from "../reactivity/batch";
import { stripUnsafeKeys } from "../utils/guards";

// ============================================================================
// STATE MACHINE
// ============================================================================

export interface MachineConfig<S extends string, E extends string, C extends object = Record<string, unknown>> {
  initial: S;
  context?: C;
  states: {
    [K in S]: {
      on?: {
        [Event in E]?:
          | {
              target: S;
              guard?: (context: C) => boolean;
              action?: (context: C) => Partial<C>;
            }
          | S;
      };
      entry?: (context: C) => void;
      exit?: (context: C) => void;
    };
  };
}

export interface MachineReturn<S extends string, E extends string, C extends object> {
  state: () => S;
  context: () => C;
  send: (event: E) => void;
  matches: (state: S) => boolean;
  can: (event: E) => boolean;
}

/**
 * machine creates a finite state machine with states, events, guards, and actions.
 */
export function machine<S extends string, E extends string, C extends object = Record<string, unknown>>(
  config: MachineConfig<S, E, C>,
): MachineReturn<S, E, C> {
  const [state, setState] = signal<S>(config.initial);
  const [context, setContext] = signal<C>((config.context || {}) as C);

  // Plain-variable source of truth for transitions. Reading the signals inside
  // send() would subscribe a calling effect to this machine, and — worse — a
  // send() nested inside a transition would see state the outer transition had
  // not committed yet.
  let currentState: S = config.initial;
  let currentContext: C = context();

  // RUN-TO-COMPLETION. Hooks, actions and subscribers woken by a publication
  // may call send() again. Executing that immediately ran the nested event
  // against the OLD state: its transition was then overwritten when the outer
  // one committed, and exit hooks could run twice for one logical state. Events
  // sent while a transition is in progress are queued and processed, in order,
  // once it has fully completed (exit → action → publish → entry).
  const queue: E[] = [];
  let processing = false;

  function drain(): void {
    processing = true;
    try {
      while (queue.length > 0) {
        step(queue.shift() as E);
      }
    } catch (err) {
      // A failed transition abandons the events it queued: they were sent in
      // response to work that did not complete.
      queue.length = 0;
      throw err;
    } finally {
      processing = false;
    }
  }

  function step(event: E): void {
    const stateDef = config.states[currentState];
    if (!stateDef?.on) return;

    const transition = stateDef.on[event];
    if (!transition) return;

    let target: S;
    let guard: ((ctx: C) => boolean) | undefined;
    let action: ((ctx: C) => Partial<C>) | undefined;

    if (typeof transition === "string") {
      target = transition as S;
    } else {
      target = transition.target;
      guard = transition.guard;
      action = transition.action;
    }

    const ctx = currentContext;

    // Check guard
    if (guard && !guard(ctx)) return;

    // Run exit action for current state
    if (stateDef.exit) {
      stateDef.exit(ctx);
    }

    // Run transition action. The returned patch is merged into context
    // via a filtered loop rather than a raw spread to prevent prototype
    // pollution: a patch of `{ __proto__: {...} }` parsed from JSON
    // (where `__proto__` is an own enumerable key) can otherwise invoke
    // the `Object.prototype` setter through object-spread semantics.
    let nextContext = ctx;
    if (action) {
      const rawPatch = action(ctx) as Record<string, unknown>;
      nextContext = { ...ctx, ...stripUnsafeKeys(rawPatch) } as C;
    }

    // Commit, then publish context and state together so no subscriber ever
    // observes the new context paired with the old state.
    currentState = target;
    currentContext = nextContext;
    batch(() => {
      if (action) setContext(nextContext);
      setState(target);
    });

    // Run entry action for new state
    const targetDef = config.states[target];
    if (targetDef?.entry) {
      targetDef.entry(currentContext);
    }
  }

  function send(event: E): void {
    queue.push(event);
    if (processing) return;
    drain();
  }

  // Run entry action for initial state. Guarded like a transition, so an event
  // it sends is processed after the entry hook returns.
  const initialDef = config.states[config.initial];
  if (initialDef?.entry) {
    processing = true;
    try {
      initialDef.entry(currentContext);
    } catch (err) {
      queue.length = 0;
      throw err;
    } finally {
      processing = false;
    }
    if (queue.length > 0) drain();
  }

  function matches(s: S): boolean {
    return state() === s;
  }

  function can(event: E): boolean {
    const currentState = state();
    const stateDef = config.states[currentState];
    if (!stateDef?.on) return false;

    const transition = stateDef.on[event];
    if (!transition) return false;

    if (typeof transition === "string") return true;

    if (transition.guard) {
      return transition.guard(context());
    }

    return true;
  }

  return { state, context, send, matches, can };
}
