import { signal } from "@sibujs/core";

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
