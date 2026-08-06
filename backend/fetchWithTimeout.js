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
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
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
export async function raceWithTimeout(tasks, timeoutMs = 15000) {
  const wrappedTasks = tasks.map(({ name, promise }) => {
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${name} timeout`)), timeoutMs);
    });
    
    return Promise.race([promise, timeoutPromise])
      .then(value => ({ name, status: 'fulfilled', value }))
      .catch(reason => ({ name, status: 'rejected', reason: reason?.message || String(reason) }));
  });
  
  return Promise.all(wrappedTasks);
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
