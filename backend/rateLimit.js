const buckets = new Map();

/** 简单匿名 QPS：默认每 IP 每分钟 60 次 */
export function rateLimitHit(ip, { max = 60, windowMs = 60_000 } = {}) {
  const now = Date.now();
  const b = buckets.get(ip) ?? { count: 0, resetAt: now + windowMs };
  if (now > b.resetAt) {
    b.count = 0;
    b.resetAt = now + windowMs;
  }
  b.count += 1;
  buckets.set(ip, b);
  return b.count <= max;
}
