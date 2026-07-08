import { signal } from "@sibujs/core";
import { batch } from "@sibujs/core";

/**
 * Battery manager interface matching the Battery Status API.
 */
interface BatteryManager extends EventTarget {
  charging: boolean;
  chargingTime: number;
  dischargingTime: number;
  level: number;
}

/**
 * battery provides reactive access to the Battery Status API.
 * Returns reactive getters for battery level, charging status, and timing.
 *
 * @returns Object with reactive battery state getters, supported flag, and dispose
 */
export function battery(): {
  level: () => number | null;
  charging: () => boolean | null;
  chargingTime: () => number | null;
  dischargingTime: () => number | null;
  supported: () => boolean;
  dispose: () => void;
} {
  const [level, setLevel] = signal<number | null>(null);
  const [charging, setCharging] = signal<boolean | null>(null);
  const [chargingTime, setChargingTime] = signal<number | null>(null);
  const [dischargingTime, setDischargingTime] = signal<number | null>(null);
  const [supported, setSupported] = signal(false);

  let battery: BatteryManager | null = null;
  let onLevelChange: (() => void) | null = null;
  let onChargingChange: (() => void) | null = null;
  let onChargingTimeChange: (() => void) | null = null;
  let onDischargingTimeChange: (() => void) | null = null;
  let disposed = false;

  if (typeof navigator !== "undefined" && "getBattery" in navigator) {
    setSupported(true);

    const batteryPromise = (navigator as unknown as { getBattery(): Promise<BatteryManager> })
      .getBattery()
      .then((bm: BatteryManager) => {
        if (disposed) return;

        battery = bm;

        batch(() => {
          setLevel(bm.level);
          setCharging(bm.charging);
          setChargingTime(bm.chargingTime);
          setDischargingTime(bm.dischargingTime);
        });

        onLevelChange = () => setLevel(bm.level);
        onChargingChange = () => setCharging(bm.charging);
        onChargingTimeChange = () => setChargingTime(bm.chargingTime);
        onDischargingTimeChange = () => setDischargingTime(bm.dischargingTime);

        bm.addEventListener("levelchange", onLevelChange);
        bm.addEventListener("chargingchange", onChargingChange);
        bm.addEventListener("chargingtimechange", onChargingTimeChange);
        bm.addEventListener("dischargingtimechange", onDischargingTimeChange);
      });
    batteryPromise.catch(() => {
      // getBattery() can reject (insecure context / permission denied) —
      // degrade quietly instead of surfacing an unhandled rejection.
      if (!disposed) setSupported(false);
    });
  }

  function dispose() {
    disposed = true;
    if (battery) {
      if (onLevelChange) battery.removeEventListener("levelchange", onLevelChange);
      if (onChargingChange) battery.removeEventListener("chargingchange", onChargingChange);
      if (onChargingTimeChange) battery.removeEventListener("chargingtimechange", onChargingTimeChange);
      if (onDischargingTimeChange) battery.removeEventListener("dischargingtimechange", onDischargingTimeChange);
      battery = null;
    }
  }

  return { level, charging, chargingTime, dischargingTime, supported, dispose };
}
