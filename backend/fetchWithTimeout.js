/**
 * 带超时控制的fetch工具
 */

/**
 * 执行带超时控制的fetch请求
 * @param {string} url 请求URL
 * @param {object} options fetch选项
 * @param {number} timeoutMs 超时时间（毫秒）
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  if (options.signal?.aborted) abortFromCaller();
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    options.signal?.removeEventListener("abort", abortFromCaller);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    options.signal?.removeEventListener("abort", abortFromCaller);
    if (options.signal?.aborted) throw error;
    if (timedOut && error.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeoutMs}ms`);
    }
    throw error;
  }
}

/**
 * 并行执行多个Promise，带超时和错误处理
 * @param {Array<{name: string, promise: Promise}>} tasks 任务列表
 * @param {number} timeoutMs 每个任务的最大等待时间
 * @returns {Promise<Array<{name: string, status: string, value?: any, reason?: any}>>}
 */
export async function raceWithTimeout(tasks, timeoutMs = 15000, { signal } = {}) {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Search cancelled", "AbortError");
  let abortHandler;
  const aborted = new Promise((_, reject) => {
    abortHandler = () => reject(signal.reason ?? new DOMException("Search cancelled", "AbortError"));
    signal?.addEventListener("abort", abortHandler, { once: true });
  });
  const wrappedTasks = tasks.map(({ name, promise }) => {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`${name} timeout`)), timeoutMs);
    });
    return Promise.race([promise, timeoutPromise, aborted])
      .then(value => ({ name, status: 'fulfilled', value }))
      .catch(reason => {
        if (signal?.aborted) throw reason;
        return { name, status: 'rejected', reason: reason?.message || String(reason) };
      })
      .finally(() => clearTimeout(timeoutId));
  });
  try {
    return await Promise.all(wrappedTasks);
  } finally {
    signal?.removeEventListener("abort", abortHandler);
  }
}

/**
 * 快速获取最先返回的成功结果
 * @param {Array<{name: string, promise: Promise}>} tasks 任务列表
 * @param {number} minResults 最少需要的结果数
 * @param {number} timeoutMs 总体超时时间
 * @returns {Promise<Array<{name: string, value: any}>>}
 */
export async function getFastestResults(tasks, minResults = 3, timeoutMs = 12000) {
  const results = [];
  const errors = [];
  
  const promises = tasks.map(({ name, promise }) =>
    promise
      .then(value => ({ name, value, success: true }))
      .catch(error => ({ name, error: error?.message || String(error), success: false }))
  );
  
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (results.length >= minResults) {
        resolve(results);
      } else {
        // 超时但结果不足，返回已有结果
        resolve(results);
      }
    }, timeoutMs);
    
    promises.forEach(p => {
      p.then(result => {
        if (result.success) {
          results.push({ name: result.name, value: result.value });
          // 如果已收集到足够结果，提前返回
          if (results.length >= minResults) {
            clearTimeout(timer);
            resolve(results);
          }
        } else {
          errors.push({ name: result.name, error: result.error });
        }
      });
    });
  });
}
