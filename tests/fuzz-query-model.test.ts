// Seeded randomized model test for the query cache.
//
// Deterministic by construction: a fixed set of seeds drives a mulberry32 PRNG,
// so a failure prints a seed + step + the whole operation log and replays
// byte-identically. No `Math.random()` anywhere — this runs in ordinary CI.
//
// The point is not to re-prove the individually-fixed ownership bugs (QRY-003,
// QRY-005 and friends already have targeted regressions). It is to search the
// *interleavings* those targeted tests do not enumerate: dispose during flight,
// key change during flight, clearQueryCache under load, invalidate racing a
// late settle, setQueryData landing on a replaced entry.
//
// Every operation is followed by a full invariant sweep against an external
// reference model (§29–§31 of the certification brief).
import { afterEach, describe, expect, it } from "vitest";
import type { QueryResult } from "../src/data/query";
import { __resetQueryCache, clearQueryCache, invalidateQueries, query, setQueryData } from "../src/data/query";

// --- deterministic PRNG ----------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- access to the real cache for structural invariants --------------------
interface RawEntry {
  data: unknown;
  subscribers: number;
  listeners: Set<unknown>;
  refetchers: Set<unknown>;
  generation: number;
  promise: unknown;
}
const CACHE_KEY = Symbol.for("sibujs.query.cache.v1");
const rawCache = (): Map<string, RawEntry> =>
  (globalThis as unknown as Record<symbol, Map<string, RawEntry>>)[CACHE_KEY];

// --- controlled fetchers ---------------------------------------------------
interface Deferred {
  id: number;
  key: string;
  settled: boolean;
  resolve: (v: string) => void;
  reject: (e: Error) => void;
}

const KEYS = ["a", "b", "c"] as const;

interface Observer {
  id: number;
  key: string;
  q: QueryResult<string>;
  disposed: boolean;
  /** State captured at dispose time — must never change afterwards. */
  frozen?: { data: unknown; error: unknown; fetching: boolean };
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

afterEach(() => {
  __resetQueryCache();
});

function runSeed(seed: number, steps: number) {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];

  const log: string[] = [];
  const observers: Observer[] = [];
  const pending: Deferred[] = [];
  let nextObs = 0;
  let nextReq = 0;

  const makeFetcher = (keyRef: { key: string }) => () =>
    new Promise<string>((resolve, reject) => {
      pending.push({ id: nextReq++, key: keyRef.key, settled: false, resolve, reject });
    });

  const live = () => observers.filter((o) => !o.disposed);
  const unsettled = () => pending.filter((p) => !p.settled);

  // --- invariant sweep ------------------------------------------------------
  function checkInvariants(step: number, lastOp: string) {
    const ctx = () => `seed=${seed} step=${step} op=${lastOp}\nlog:\n${log.join("\n")}`;
    const cache = rawCache();

    for (const [key, entry] of cache.entries()) {
      // I1: a subscriber count can never go logically negative.
      expect(entry.subscribers, `I1 negative subscribers on "${key}"\n${ctx()}`).toBeGreaterThanOrEqual(0);

      // I2: the three registration structures are maintained as one unit.
      expect(entry.listeners.size, `I2 listeners/subscribers drift on "${key}"\n${ctx()}`).toBe(entry.subscribers);
      expect(entry.refetchers.size, `I2 refetchers/subscribers drift on "${key}"\n${ctx()}`).toBe(entry.subscribers);

      // I3: an entry can never hold more subscribers than there are live
      // observers in the whole world.
      expect(entry.subscribers, `I3 subscribers exceed live observers on "${key}"\n${ctx()}`).toBeLessThanOrEqual(
        live().length,
      );
    }

    // I4: a disposed observer must never receive another local commit.
    for (const o of observers) {
      if (!o.disposed || !o.frozen) continue;
      expect(o.q.data(), `I4 disposed observer ${o.id} data mutated\n${ctx()}`).toBe(o.frozen.data);
      expect(o.q.error(), `I4 disposed observer ${o.id} error mutated\n${ctx()}`).toBe(o.frozen.error);
      expect(o.q.fetching(), `I4 disposed observer ${o.id} fetching mutated\n${ctx()}`).toBe(o.frozen.fetching);
    }

    // I5: with nothing in flight, no live observer may remain stuck fetching.
    if (unsettled().length === 0) {
      for (const o of live()) {
        expect(o.q.fetching(), `I5 observer ${o.id} stuck fetching with no request in flight\n${ctx()}`).toBe(false);
      }
    }

    // I6: every live observer attached to a key with cached data must agree
    // with the cache. (Only checked when the observer is idle, so a
    // mid-flight intermediate state is not mistaken for divergence.)
    for (const o of live()) {
      if (o.q.fetching()) continue;
      const entry = cache.get(o.key);
      if (!entry || entry.data === undefined) continue;
      expect(o.q.data(), `I6 observer ${o.id} diverged from cache["${o.key}"]\n${ctx()}`).toBe(entry.data);
    }
  }

  return (async () => {
    for (let step = 0; step < steps; step++) {
      const ops = [
        "create",
        "dispose",
        "changeKey",
        "resolve",
        "reject",
        "invalidate",
        "clearCache",
        "setQueryData",
        "refetch",
      ] as const;
      const op = pick(ops);
      let desc: string = op;

      switch (op) {
        case "create": {
          if (observers.length >= 8) break;
          const key = pick(KEYS);
          const keyRef = { key };
          const id = nextObs++;
          const q = query<string>(key, makeFetcher(keyRef), { retry: { maxRetries: 0 }, cacheTime: 60_000 });
          observers.push({ id, key, q, disposed: false });
          desc = `create obs${id} key=${key}`;
          break;
        }
        case "dispose": {
          const l = live();
          if (!l.length) break;
          const o = pick(l);
          o.q.dispose();
          o.disposed = true;
          o.frozen = { data: o.q.data(), error: o.q.error(), fetching: o.q.fetching() };
          desc = `dispose obs${o.id}`;
          break;
        }
        case "changeKey": {
          // The public key-as-function form is exercised by the targeted suite;
          // here we model an observer moving keys by disposing and recreating,
          // which is the ownership transition that matters to the cache.
          const l = live();
          if (!l.length) break;
          const o = pick(l);
          const newKey = pick(KEYS);
          o.q.dispose();
          o.disposed = true;
          o.frozen = { data: o.q.data(), error: o.q.error(), fetching: o.q.fetching() };
          const keyRef = { key: newKey };
          const id = nextObs++;
          observers.push({
            id,
            key: newKey,
            q: query<string>(newKey, makeFetcher(keyRef), { retry: { maxRetries: 0 }, cacheTime: 60_000 }),
            disposed: false,
          });
          desc = `changeKey obs${o.id} -> obs${id} key=${newKey}`;
          break;
        }
        case "resolve": {
          const u = unsettled();
          if (!u.length) break;
          const d = pick(u);
          d.settled = true;
          d.resolve(`v${d.id}`);
          desc = `resolve req${d.id} key=${d.key} -> v${d.id}`;
          break;
        }
        case "reject": {
          const u = unsettled();
          if (!u.length) break;
          const d = pick(u);
          d.settled = true;
          d.reject(new Error(`boom${d.id}`));
          desc = `reject req${d.id} key=${d.key}`;
          break;
        }
        case "invalidate": {
          const key = pick(KEYS);
          invalidateQueries(key);
          desc = `invalidate ${key}`;
          break;
        }
        case "clearCache": {
          clearQueryCache();
          desc = "clearCache";
          break;
        }
        case "setQueryData": {
          const key = pick(KEYS);
          const value = `set${step}`;
          setQueryData(key, value);
          desc = `setQueryData ${key}=${value}`;
          break;
        }
        case "refetch": {
          const l = live();
          if (!l.length) break;
          const o = pick(l);
          void o.q.refetch().catch(() => {});
          desc = `refetch obs${o.id}`;
          break;
        }
      }

      log.push(`${step}: ${desc}`);
      await flush();
      checkInvariants(step, desc);
    }

    // --- terminal drain: settle everything, then assert a quiescent world ---
    for (const d of unsettled()) {
      d.settled = true;
      d.resolve(`drain${d.id}`);
    }
    await flush();
    checkInvariants(steps, "terminal drain");

    for (const o of live()) {
      expect(o.q.fetching(), `terminal: observer ${o.id} still fetching (seed=${seed})`).toBe(false);
    }

    // Disposing every observer must return every entry to zero subscribers.
    for (const o of live()) {
      o.q.dispose();
      o.disposed = true;
    }
    await flush();
    for (const [key, entry] of rawCache().entries()) {
      expect(entry.subscribers, `terminal: "${key}" retained subscribers (seed=${seed})`).toBe(0);
    }
  })();
}

describe("query cache — seeded model fuzzing", () => {
  const SEEDS = [1, 42, 123456, 999999, 7, 31337];
  for (const seed of SEEDS) {
    it(`survives 400 operations under seed ${seed}`, async () => {
      await runSeed(seed, 400);
    });
  }
});
