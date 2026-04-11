import { signal } from "../core/signals/signal";

type EffectiveType = "slow-2g" | "2g" | "3g" | "4g" | "unknown";

interface NetworkInformation extends EventTarget {
  effectiveType?: EffectiveType;
  downlink?: number;
  rtt?: number;
  saveData?: boolean;
  type?: string;
}

/**
 * network tracks the browser's Network Information API.
 * Returns reactive getters for effective connection type, downlink bandwidth,
 * round-trip time, and save-data preference.
 *
 * Useful for adapting content (image quality, prefetching, polling intervals)
 * to the user's actual connection — not just online/offline state.
 *
 * Falls back to sensible defaults on browsers without the API (notably Safari).
 *
 * @returns Reactive network info with dispose function
 *
 * @example
 * ```ts
 * const { effectiveType, saveData } = network();
 * const imageQuality = derived(() =>
 *   saveData() || effectiveType() === "2g" ? "low" : "high"
 * );
 * ```
 */
export function network(): {
  effectiveType: () => EffectiveType;
  downlink: () => number;
  rtt: () => number;
  saveData: () => boolean;
  dispose: () => void;
} {
  const connection: NetworkInformation | undefined =
    typeof navigator !== "undefined"
      ? ((navigator as unknown as { connection?: NetworkInformation }).connection ??
        (navigator as unknown as { mozConnection?: NetworkInformation }).mozConnection ??
        (navigator as unknown as { webkitConnection?: NetworkInformation }).webkitConnection)
      : undefined;

  const [effectiveType, setEffectiveType] = signal<EffectiveType>(connection?.effectiveType ?? "unknown");
  const [downlink, setDownlink] = signal<number>(connection?.downlink ?? 0);
  const [rtt, setRtt] = signal<number>(connection?.rtt ?? 0);
  const [saveData, setSaveData] = signal<boolean>(connection?.saveData ?? false);

  if (!connection) {
    return { effectiveType, downlink, rtt, saveData, dispose: () => {} };
  }

  const update = () => {
    setEffectiveType(connection.effectiveType ?? "unknown");
    setDownlink(connection.downlink ?? 0);
    setRtt(connection.rtt ?? 0);
    setSaveData(connection.saveData ?? false);
  };

  connection.addEventListener("change", update);

  function dispose() {
    connection?.removeEventListener("change", update);
  }

  return { effectiveType, downlink, rtt, saveData, dispose };
}
