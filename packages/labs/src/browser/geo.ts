import { batch, signal } from "@sibujs/core";

/**
 * geo provides reactive access to the device's geographic position.
 * Uses `navigator.geolocation.watchPosition` for continuous updates.
 *
 * @param options Optional PositionOptions for the geolocation API
 * @returns Object with reactive latitude, longitude, accuracy, error getters and dispose
 */
export function geo(options?: PositionOptions): {
  latitude: () => number | null;
  longitude: () => number | null;
  accuracy: () => number | null;
  error: () => GeolocationPositionError | null;
  dispose: () => void;
} {
  const [latitude, setLatitude] = signal<number | null>(null);
  const [longitude, setLongitude] = signal<number | null>(null);
  const [accuracy, setAccuracy] = signal<number | null>(null);
  const [error, setError] = signal<GeolocationPositionError | null>(null);

  let watchId: number | null = null;

  if (typeof navigator !== "undefined" && navigator.geolocation) {
    watchId = navigator.geolocation.watchPosition(
      (position) => {
        batch(() => {
          setLatitude(position.coords.latitude);
          setLongitude(position.coords.longitude);
          setAccuracy(position.coords.accuracy);
          setError(null);
        });
      },
      (err) => {
        setError(err);
      },
      options,
    );
  }

  function dispose() {
    if (watchId !== null && typeof navigator !== "undefined" && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
  }

  return { latitude, longitude, accuracy, error, dispose };
}
