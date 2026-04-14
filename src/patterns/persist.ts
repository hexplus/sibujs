import { effect } from "../core/signals/effect";
import { signal } from "../core/signals/signal";

/**
 * Creates a reactive state that automatically persists to localStorage
 * or sessionStorage. Restores persisted value on initialization.
 *
 * @param key Storage key
 * @param initial Default value when no persisted value exists
 * @param options Storage options
 * @returns Same tuple as signal: [getter, setter]
 *
 * @example
 * ```ts
 * const [theme, setTheme] = persisted("theme", "light");
 * setTheme("dark"); // Automatically saved to localStorage
 * // On page reload, theme() returns "dark"
 * ```
 */
export interface PersistOptions<T = unknown> {
  /** Use sessionStorage instead of localStorage */
  session?: boolean;
  /** Custom serializer (defaults to JSON.stringify) */
  serialize?: (value: unknown) => string;
  /** Custom deserializer (defaults to JSON.parse) */
  deserialize?: (raw: string) => unknown;
  /** Optional type guard to validate deserialized data. Falls back to initial on failure. */
  validate?: (value: unknown) => value is T;
  /**
   * Sync the signal across browser tabs via the `storage` event.
   * Only applies when using localStorage (not sessionStorage — session storage
   * is already isolated per tab). Default: `true` for localStorage.
   */
  syncTabs?: boolean;
  /**
   * Encrypt the serialized value before writing to storage.
   * Paired with `decrypt` for reading. Use for sensitive data.
   *
   * **Security requirement:** use an authenticated encryption algorithm
   * such as AES-GCM via the Web Crypto API. Do NOT:
   *
   *  - use `btoa()` / `atob()` — Base64 is encoding, not encryption
   *  - use XOR with a static key — trivially reversible
   *  - roll your own cipher — nearly always broken
   *
   * **Sync only:** because `persisted()` exposes synchronous getters and
   * setters, both `encrypt` and `decrypt` must be SYNCHRONOUS. Async
   * crypto (e.g. `crypto.subtle.encrypt`) is NOT supported here — derive
   * keys ahead of time and use a sync wrapper, or pre/post-process the
   * value yourself before/after `setValue`.
   *
   * @example
   * ```ts
   * // Pre-derived key + sync wrapper
   * persisted("token", "", {
   *   encrypt: (v) => syncAesGcmEncrypt(v, derivedKey),
   *   decrypt: (v) => syncAesGcmDecrypt(v, derivedKey),
   * });
   * ```
   */
  encrypt?: (value: string) => string;
  /** Decrypt the stored value before deserialization. Required if `encrypt` is set.
   *  Must be synchronous — see `encrypt` docs. */
  decrypt?: (value: string) => string;
}

export function persisted<T>(
  key: string,
  initial: T,
  options: PersistOptions<T> = {},
): [() => T, (next: T | ((prev: T) => T)) => void] {
  const storage = options.session ? sessionStorage : localStorage;
  const serialize = options.serialize || JSON.stringify;
  // Reject __proto__ / constructor / prototype keys at parse time to block
  // prototype pollution from a tampered storage entry (CWE-1321).
  const safeReviver = (k: string, v: unknown): unknown => {
    if (k === "__proto__" || k === "constructor" || k === "prototype") return undefined;
    return v;
  };
  const deserialize = options.deserialize || ((raw: string) => JSON.parse(raw, safeReviver));
  const encrypt = options.encrypt;
  const decrypt = options.decrypt;
  // Cross-tab sync defaults to on for localStorage, always off for sessionStorage
  const syncTabs = options.session ? false : (options.syncTabs ?? true);

  // Try to restore persisted value
  let restored = initial;
  try {
    let raw = storage.getItem(key);
    if (raw !== null) {
      if (decrypt) raw = decrypt(raw);
      const parsed = deserialize(raw);
      // If a validate guard is provided, only accept data that passes it
      restored = options.validate && !options.validate(parsed) ? initial : (parsed as T);
    }
  } catch {
    // If parsing or decryption fails, use initial
  }

  const [value, setValue] = signal<T>(restored);

  // Guard reentry when a storage event causes us to setValue(), which would
  // otherwise bounce back through the persisting effect below.
  let applyingFromStorage = false;

  // Persist on every change
  const stopPersistEffect = effect(() => {
    const current = value();
    if (applyingFromStorage) return;
    try {
      let serialized = serialize(current);
      if (encrypt) serialized = encrypt(serialized);
      storage.setItem(key, serialized);
    } catch {
      // Storage full or unavailable
    }
  });

  // Cross-tab synchronization via the `storage` event.
  // Only localStorage fires this event in other tabs. The listener is
  // cleaned up by the returned `dispose` function on the handle — callers
  // that never dispose should be aware that the listener lives for the
  // lifetime of the page.
  let storageListener: ((e: StorageEvent) => void) | null = null;
  if (syncTabs && typeof window !== "undefined") {
    storageListener = (e: StorageEvent) => {
      if (e.storageArea !== storage || e.key !== key) return;
      if (e.newValue === null) {
        applyingFromStorage = true;
        try {
          setValue(initial);
        } finally {
          applyingFromStorage = false;
        }
        return;
      }
      try {
        let raw = e.newValue;
        if (decrypt) raw = decrypt(raw);
        const parsed = deserialize(raw);
        if (options.validate && !options.validate(parsed)) return;
        applyingFromStorage = true;
        try {
          setValue(parsed as T);
        } finally {
          applyingFromStorage = false;
        }
      } catch {
        // Ignore malformed updates from other tabs
      }
    };
    window.addEventListener("storage", storageListener);
  }

  // Attach a dispose hook to the returned tuple so callers that want to
  // clean up the storage listener (e.g. during component unmount) can do
  // so. Exposed as a non-enumerable property on the setter to keep the
  // tuple's public shape identical to `signal()`'s return type.
  const dispose = () => {
    stopPersistEffect();
    if (storageListener && typeof window !== "undefined") {
      window.removeEventListener("storage", storageListener);
      storageListener = null;
    }
  };
  Object.defineProperty(setValue, "dispose", {
    value: dispose,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return [value, setValue];
}
