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

/**
 * 创建一个作用域限速器。
 * @param {object} opts
 * @param {number} opts.max         - 窗口内最大请求数
 * @param {number} opts.windowMs    - 窗口时长（毫秒）
 * @param {number} [opts.maxBuckets=5000] - 最大 bucket 数，超出时驱逐最旧条目
 * @returns {(scope: string, identity: string) => boolean}
 *   返回 true 表示未超限（允许通过），false 表示已超限（应拒绝）。
 *   key 格式为 "scope:identity"，与 rateLimitHit 的 ip-only bucket 相互独立。
 */
export function createScopedLimiter({ max, windowMs, maxBuckets = 5000 } = {}) {
  const store = new Map();
  return function scopedLimiter(scope, identity) {
    const key = `${scope}:${identity}`;
    const now = Date.now();
    let b = store.get(key);
    if (!b || now > b.resetAt) {
      b = { count: 0, resetAt: now + windowMs };
    }
    b.count += 1;
    // Evict oldest entry when at capacity (before setting the new/updated entry)
    if (!store.has(key) && store.size >= maxBuckets) {
      store.delete(store.keys().next().value);
    }
    store.set(key, b);
    return b.count <= max;
  };
}
