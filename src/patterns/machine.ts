import { signal } from "../core/signals/signal";

// ============================================================================
// STATE MACHINE
// ============================================================================

export interface MachineConfig<
  S extends string,
  E extends string,
  C extends Record<string, unknown> = Record<string, unknown>,
> {
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

export interface MachineReturn<S extends string, E extends string, C extends Record<string, unknown>> {
  state: () => S;
  context: () => C;
  send: (event: E) => void;
  matches: (state: S) => boolean;
  can: (event: E) => boolean;
}

/**
 * machine creates a finite state machine with states, events, guards, and actions.
 */
export function machine<
  S extends string,
  E extends string,
  C extends Record<string, unknown> = Record<string, unknown>,
>(config: MachineConfig<S, E, C>): MachineReturn<S, E, C> {
  const [state, setState] = signal<S>(config.initial);
  const [context, setContext] = signal<C>((config.context || {}) as C);

  // Run entry action for initial state
  const initialDef = config.states[config.initial];
  if (initialDef?.entry) {
    initialDef.entry(context());
  }

  function send(event: E): void {
    const currentState = state();
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

    const ctx = context();

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
    if (action) {
      const rawPatch = action(ctx) as Record<string, unknown>;
      const next: Record<string, unknown> = { ...ctx };
      for (const key of Object.keys(rawPatch)) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
        next[key] = rawPatch[key];
      }
      setContext(next as C);
    }

    // Transition to new state
    setState(target);

    // Run entry action for new state
    const targetDef = config.states[target];
    if (targetDef?.entry) {
      targetDef.entry(context());
    }
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
