// In-memory sliding-window limiter. One process, no persistence: fine for a single token server.
export function createLimiter({ windowMs, max }) {
  const hits = new Map(); // key -> number[] of timestamps

  const recent = (key, now) => {
    const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (list.length) hits.set(key, list); else hits.delete(key);
    return list;
  };

  const timer = setInterval(() => { const now = Date.now(); for (const k of [...hits.keys()]) recent(k, now); }, windowMs);
  timer.unref();

  return {
    // Count one attempt. Returns { ok, retryAfterSec }.
    hit(key, now = Date.now()) {
      const list = recent(key, now);
      if (list.length >= max) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((list[0] + windowMs - now) / 1000)) };
      list.push(now);
      hits.set(key, list);
      return { ok: true, retryAfterSec: 0 };
    },
    // Check without counting (used to lock out after failures recorded via hit()).
    blocked(key, now = Date.now()) {
      const list = recent(key, now);
      return list.length >= max ? Math.max(1, Math.ceil((list[0] + windowMs - now) / 1000)) : 0;
    },
    reset(key) { hits.delete(key); },
  };
}
