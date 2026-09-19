/**
 * Emit a lifecycle event to the DevTools global hook, if one is installed.
 *
 * DevTools observe the runtime; they must never change what it does. An
 * uncontained throw from `emit` at a create or init point aborted construction
 * after the thing had already subscribed or committed (an effect's first run, a
 * computed's source edges, a mounted tree), so the caller never received the
 * disposer that would release it. At an update point it aborted a setter after
 * the value changed but before subscribers were notified. Hook failures are
 * therefore swallowed, as the destroy paths already did.
 *
 * @internal
 */
export function emitDevtools(
  hook: { emit: (event: string, payload: unknown) => void },
  event: string,
  payload: unknown,
): void {
  try {
    hook.emit(event, payload);
  } catch {
    /* devtools hook errors must not alter the application's lifecycle */
  }
}
