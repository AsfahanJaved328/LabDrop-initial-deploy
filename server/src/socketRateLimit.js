/**
 * Minimal fixed-window rate limiter for Socket.IO events, keyed by IP.
 * Good enough for a solo-student deployment; swap for a Redis-backed
 * limiter if LabDrop ever runs on more than one server process.
 */
export function createRateLimiter({ windowMs, max }) {
  /** @type {Map<string, { count: number, resetAt: number }>} */
  const hits = new Map();

  return function allow(key) {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (entry.count >= max) return false;
    entry.count += 1;
    return true;
  };
}
