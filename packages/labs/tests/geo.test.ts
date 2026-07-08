import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { geo } from "../src/browser/geo";

describe("geo", () => {
  let successCallback: PositionCallback;
  let errorCallback: PositionErrorCallback;
  let clearWatchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearWatchSpy = vi.fn();

    vi.stubGlobal("navigator", {
      geolocation: {
        watchPosition: vi.fn((success: PositionCallback, error?: PositionErrorCallback) => {
          successCallback = success;
          if (error) errorCallback = error;
          return 42; // watch ID
        }),
        clearWatch: clearWatchSpy,
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null for all values initially", () => {
    const { latitude, longitude, accuracy, error } = geo();
    expect(latitude()).toBeNull();
    expect(longitude()).toBeNull();
    expect(accuracy()).toBeNull();
    expect(error()).toBeNull();
  });

  it("updates position when geolocation reports success", () => {
    const { latitude, longitude, accuracy } = geo();

    successCallback({
      coords: {
        latitude: 51.5074,
        longitude: -0.1278,
        accuracy: 10,
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
        speed: null,
      },
      timestamp: Date.now(),
    } as GeolocationPosition);

    expect(latitude()).toBe(51.5074);
    expect(longitude()).toBe(-0.1278);
    expect(accuracy()).toBe(10);
  });

  it("updates error when geolocation reports an error", () => {
    const { error } = geo();
    const geoError = { code: 1, message: "User denied" } as GeolocationPositionError;

    errorCallback(geoError);
    expect(error()).toBe(geoError);
  });

  it("clears watch on dispose", () => {
    const { dispose } = geo();
    dispose();
    expect(clearWatchSpy).toHaveBeenCalledWith(42);
  });

  it("clears error on successful position update", () => {
    const { error } = geo();

    const geoError = { code: 1, message: "User denied" } as GeolocationPositionError;
    errorCallback(geoError);
    expect(error()).toBe(geoError);

    successCallback({
      coords: {
        latitude: 40.7128,
        longitude: -74.006,
        accuracy: 5,
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
        speed: null,
      },
      timestamp: Date.now(),
    } as GeolocationPosition);

    expect(error()).toBeNull();
  });
});
