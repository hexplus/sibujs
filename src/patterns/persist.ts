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
   * Encrypt the serialized value before writing to storage.
   * Paired with `decrypt` for reading. Use for sensitive data.
   *
   * **Security:** Use a real encryption algorithm (e.g. AES-GCM via Web Crypto API).
   * Do NOT use `btoa()`/`atob()` — Base64 is encoding, not encryption, and provides
   * zero confidentiality.
   *
   * @example
   * ```ts
   * // Example using a simple XOR cipher for illustration — in production,
   * // use crypto.subtle.encrypt() with AES-GCM or a proven library.
   * persisted("token", "", {
   *   encrypt: (v) => myAesGcmEncrypt(v, secretKey),
   *   decrypt: (v) => myAesGcmDecrypt(v, secretKey),
   * });
   * ```
   */
  encrypt?: (value: string) => string;
  /** Decrypt the stored value before deserialization. Required if `encrypt` is set. */
  decrypt?: (value: string) => string;
}

export function persisted<T>(
  key: string,
  initial: T,
  options: PersistOptions<T> = {},
): [() => T, (next: T | ((prev: T) => T)) => void] {
  const storage = options.session ? sessionStorage : localStorage;
  const serialize = options.serialize || JSON.stringify;
  const deserialize = options.deserialize || JSON.parse;
  const encrypt = options.encrypt;
  const decrypt = options.decrypt;

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

  // Persist on every change
  effect(() => {
    const current = value();
    try {
      let serialized = serialize(current);
      if (encrypt) serialized = encrypt(serialized);
      storage.setItem(key, serialized);
    } catch {
      // Storage full or unavailable
    }
  });

  return [value, setValue];
}
