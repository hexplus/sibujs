/**
 * Owner stack for a GLOBAL SINGLETON resource.
 *
 * WHY THIS EXISTS
 * ---------------
 * `document.title` and `<base>` are not like a `<meta>` tag. A page can carry
 * any number of meta tags, each independently owned and independently removed,
 * so "remember my element, delete it on cleanup" is a complete teardown story.
 * A singleton has exactly ONE effective value, so every owner that sets it is
 * really *taking over* from whoever held it — and giving it back is the only
 * correct teardown.
 *
 * The natural-looking fix — each owner snapshots the previous value and writes
 * it back — is provably wrong with more than two overlapping owners:
 *
 *     A takes the title ("Dashboard")   snapshot: "Original"
 *     B takes the title ("Settings")    snapshot: "Dashboard"
 *     C takes the title ("Report")      snapshot: "Settings"
 *     B disposes  → writes "Dashboard"  ← C is still the active owner!
 *
 * B, which is not even the visible owner, silently clobbers C. Overlapping
 * lifetimes are the normal case (a layout `Head` outliving a page `Head`, a
 * modal's `title()` inside a route's), so this is an everyday reordering bug,
 * not a corner case.
 *
 * A stack fixes it structurally: writes always come from the CURRENT top, a
 * release from anywhere else just removes an entry, and emptying the stack
 * restores the value captured before the first owner arrived.
 */

export interface ResourceLease<T> {
  /** Update this owner's value. Only reaches the resource while it is on top. */
  set(value: T): void;
  /** Give the resource back. Idempotent. */
  release(): void;
}

export interface ResourceIO<T> {
  /** Read the value that existed before SibuJS took over. */
  read(): T;
  /** Make `value` the effective value of the resource. */
  write(value: T): void;
}

export interface SingletonResource<T> {
  acquire(value: T): ResourceLease<T>;
  /** Number of live owners. Exposed for tests/diagnostics. */
  ownerCount(): number;
}

export function singletonResource<T>(io: ResourceIO<T>): SingletonResource<T> {
  interface Entry {
    value: T;
    released: boolean;
  }

  let original: T | null = null;
  // Distinguishes "original is null because nothing was captured" from
  // "original is legitimately null" (e.g. there was no <base> element).
  let captured = false;
  const stack: Entry[] = [];

  function apply(): void {
    if (stack.length > 0) {
      io.write(stack[stack.length - 1].value);
      return;
    }
    if (captured) {
      io.write(original as T);
      // Drop the capture so a later owner re-reads a genuinely current value
      // rather than restoring something the application has since changed.
      captured = false;
      original = null;
    }
  }

  return {
    acquire(value: T): ResourceLease<T> {
      if (!captured) {
        original = io.read();
        captured = true;
      }
      const entry: Entry = { value, released: false };
      stack.push(entry);
      apply();

      return {
        set(next: T): void {
          if (entry.released) return;
          entry.value = next;
          // `apply()` writes the TOP entry, so a superseded owner's reactive
          // update stays recorded without stealing the resource back.
          apply();
        },
        release(): void {
          if (entry.released) return;
          entry.released = true;
          const index = stack.indexOf(entry);
          if (index !== -1) stack.splice(index, 1);
          apply();
        },
      };
    },
    ownerCount(): number {
      return stack.length;
    },
  };
}
