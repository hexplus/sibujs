import { signal } from "../core/signals/signal";

export interface GamepadSnapshot {
  index: number;
  id: string;
  connected: boolean;
  buttons: readonly { pressed: boolean; value: number }[];
  axes: readonly number[];
}

/**
 * gamepad exposes the Gamepad API as reactive snapshots. Unlike the
 * native API (which requires polling each frame), this wrapper polls for
 * you via `requestAnimationFrame` and emits a signal update whenever ANY
 * button or axis changes.
 *
 * Returns `pads()` — a reactive array of currently-connected gamepads — and
 * `dispose()` to stop polling. Listens to `gamepadconnected` and
 * `gamepaddisconnected` to auto-start/stop the poll loop.
 *
 * @example
 * ```ts
 * const gp = gamepad();
 * effect(() => {
 *   const pad = gp.pads()[0];
 *   if (pad?.buttons[0]?.pressed) jump();
 *   setAngle((pad?.axes[0] ?? 0) * 90);
 * });
 * ```
 */
export function gamepad(): { pads: () => GamepadSnapshot[]; dispose: () => void } {
  const [pads, setPads] = signal<GamepadSnapshot[]>([]);

  if (
    typeof window === "undefined" ||
    typeof navigator === "undefined" ||
    typeof navigator.getGamepads !== "function"
  ) {
    return { pads, dispose: () => {} };
  }

  let rafId: number | null = null;

  function snapshot(pad: Gamepad): GamepadSnapshot {
    return {
      index: pad.index,
      id: pad.id,
      connected: pad.connected,
      buttons: pad.buttons.map((b) => ({ pressed: b.pressed, value: b.value })),
      axes: [...pad.axes],
    };
  }

  function equal(a: GamepadSnapshot[], b: GamepadSnapshot[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const pa = a[i];
      const pb = b[i];
      if (pa.index !== pb.index || pa.connected !== pb.connected) return false;
      if (pa.buttons.length !== pb.buttons.length) return false;
      for (let j = 0; j < pa.buttons.length; j++) {
        if (pa.buttons[j].pressed !== pb.buttons[j].pressed) return false;
        if (pa.buttons[j].value !== pb.buttons[j].value) return false;
      }
      if (pa.axes.length !== pb.axes.length) return false;
      for (let j = 0; j < pa.axes.length; j++) {
        if (pa.axes[j] !== pb.axes[j]) return false;
      }
    }
    return true;
  }

  function poll() {
    const raw = navigator.getGamepads();
    const snap = Array.from(raw)
      .filter((g): g is Gamepad => g !== null)
      .map(snapshot);
    const current = pads();
    if (!equal(current, snap)) setPads(snap);
    rafId = requestAnimationFrame(poll);
  }

  function startPolling() {
    if (rafId === null) poll();
  }

  function stopPolling() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  const onConnect = () => startPolling();
  const onDisconnect = () => {
    // Stop polling only when all pads are gone
    const raw = navigator.getGamepads();
    const hasAny = Array.from(raw).some((g) => g !== null);
    if (!hasAny) stopPolling();
  };

  window.addEventListener("gamepadconnected", onConnect);
  window.addEventListener("gamepaddisconnected", onDisconnect);

  // If a gamepad is already connected (e.g. on page reload), start polling
  const initial = Array.from(navigator.getGamepads()).some((g) => g !== null);
  if (initial) startPolling();

  function dispose() {
    stopPolling();
    window.removeEventListener("gamepadconnected", onConnect);
    window.removeEventListener("gamepaddisconnected", onDisconnect);
  }

  return { pads, dispose };
}
