/**
 * 简单的内存缓存系统
 * 用于缓存搜索结果和LLM响应
 */

class MemoryCache {
  constructor(options = {}) {
    this.ttl = options.ttl || 5 * 60 * 1000; // 默认5分钟
    this.maxSize = options.maxSize || 100; // 最大缓存条目数
    this.cache = new Map();
    this.accessOrder = []; // LRU追踪
  }

  /**
   * 生成缓存键
   * @param {string} prefix 前缀
   * @param {object} params 参数对象
   * @returns {string}
   */
  static key(prefix, params) {
    const sorted = Object.keys(params || {})
      .sort()
      .map(k => `${k}=${JSON.stringify(params[k])}`)
      .join('&');
    return `${prefix}:${sorted}`;
  }

  /**
   * 获取缓存值
   * @param {string} key 
   * @returns {any|null}
   */
  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    
    // 检查是否过期
    if (Date.now() > entry.expiresAt) {
      this.delete(key);
      return null;
    }
    
    // 更新访问顺序（LRU）
    this.updateAccessOrder(key);
    return entry.value;
  }

  /**
   * 设置缓存值
   * @param {string} key 
   * @param {any} value 
   * @param {number} customTtl 自定义TTL（毫秒）
   */
  set(key, value, customTtl) {
    // 如果缓存已满，删除最久未使用的
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      this.evictLRU();
    }
    
    const ttl = customTtl || this.ttl;
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + ttl,
    });
    
    this.updateAccessOrder(key);
  }

  /**
   * 删除缓存项
   * @param {string} key 
   */
  delete(key) {
    this.cache.delete(key);
    this.accessOrder = this.accessOrder.filter(k => k !== key);
  }

  /**
   * 清空缓存
   */
  clear() {
    this.cache.clear();
    this.accessOrder = [];
  }

  /**
   * 获取缓存统计
   */
  stats() {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      ttl: this.ttl,
    };
  }

  /**
   * 更新访问顺序
   */
  updateAccessOrder(key) {
    this.accessOrder = this.accessOrder.filter(k => k !== key);
    this.accessOrder.push(key);
  }

  /**
   * 淘汰最久未使用的项
   */
  evictLRU() {
    if (this.accessOrder.length === 0) return;
    const oldest = this.accessOrder.shift();
    this.cache.delete(oldest);
  }
}

// 全局缓存实例
export const searchCache = new MemoryCache({ ttl: 3 * 60 * 1000, maxSize: 50 }); // 3分钟，50条
export const rewriteCache = new MemoryCache({ ttl: 10 * 60 * 1000, maxSize: 100 }); // 10分钟，100条
export const semanticCache = new MemoryCache({ ttl: 10 * 60 * 1000, maxSize: 80 }); // 语义意图缓存

/**
 * 缓存包装器 - 自动处理缓存逻辑
 * @param {Function} fn 原函数
 * @param {MemoryCache} cache 缓存实例
 * @param {Function} keyFn 生成缓存键的函数
 * @param {number} ttl 自定义TTL
 */
export function withCache(fn, cache, keyFn, ttl) {
  return async function(...args) {
    const key = keyFn(...args);
    const cached = cache.get(key);
    
    if (cached !== null) {
      console.log(`[cache] hit: ${key.slice(0, 50)}...`);
      return cached;
    }
    
    const result = await fn.apply(this, args);
    cache.set(key, result, ttl);
    return result;
  };
}
