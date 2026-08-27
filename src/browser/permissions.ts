import { signal } from "../core/signals/signal";

type PermissionState = "granted" | "denied" | "prompt" | "unsupported";

/**
 * permissions queries and reactively tracks a browser permission status.
 * Uses `navigator.permissions.query` and listens for state changes.
 *
 * @param name The permission name to query (e.g. "camera", "microphone", "geolocation")
 * @returns Object with reactive state getter and dispose function
 */
export function permissions(name: string): {
  state: () => PermissionState;
  dispose: () => void;
} {
  const [state, setState] = signal<PermissionState>("prompt");

  let permissionStatus: PermissionStatus | null = null;
  let onChange: (() => void) | null = null;
  let disposed = false;

  if (typeof navigator === "undefined" || !navigator.permissions) {
    setState("unsupported");
    return { state, dispose: () => {} };
  }

  navigator.permissions
    .query({ name: name as PermissionName })
    .then((status) => {
      if (disposed) return;

      permissionStatus = status;
      setState(status.state as PermissionState);

      onChange = () => {
        setState(status.state as PermissionState);
      };

      status.addEventListener("change", onChange);
    })
    .catch(() => {
      // Lifetime check on the FAILURE path too. The success path already had
      // one; without the matching guard here a query that rejected after
      // teardown still flipped a disposed controller's state to "unsupported",
      // which any lingering reader would then observe as fact.
      if (disposed) return;
      setState("unsupported");
    });

  function dispose() {
    disposed = true;
    if (permissionStatus && onChange) {
      permissionStatus.removeEventListener("change", onChange);
      permissionStatus = null;
      onChange = null;
    }
  }

  return { state, dispose };
}
