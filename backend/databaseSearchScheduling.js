export function observeSearchJob(promise) {
  promise.catch(() => {});
  return promise;
}
export async function runBoundedDatabaseWeb(task, parentSignal) {
  const budget = Math.min(45000, Math.max(5000, Number(process.env.DB_WEB_SEARCH_BUDGET_MS) || 20000));
  const controller = new AbortController();
  const relay = () => controller.abort(parentSignal.reason);
  parentSignal?.addEventListener('abort', relay, { once: true });
  if (parentSignal?.aborted) relay();
  let timer;
  try {
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => {
        controller.abort(new Error('database web supplement deadline'));
        resolve({ papers: [], patents: [], sourcesUsed: ['database_web_timeout'] });
      }, budget);
    });
    return await Promise.race([Promise.resolve().then(() => task(controller.signal)), timeout]);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', relay);
  }
}

export async function runBoundedDatabaseEnrichment(task, papers, parentSignal) {
  const budget = Math.min(15000, Math.max(2000, Number(process.env.DB_WEB_FETCH_BUDGET_MS) || 8000));
  const controller = new AbortController();
  let timer, abortHandler;
  const fallback = { papers, fetched: 0, attempted: 0, timedOut: true };
  const deadline = new Promise((resolve, reject) => {
    abortHandler = () => { controller.abort(parentSignal.reason); reject(parentSignal.reason || new Error('Search cancelled')); };
    parentSignal?.addEventListener('abort', abortHandler, { once: true });
    timer = setTimeout(() => { controller.abort(new Error('database page enrichment deadline')); resolve(fallback); }, budget);
  });
  if (parentSignal?.aborted) abortHandler();
  try { return await Promise.race([Promise.resolve().then(() => task(controller.signal)), deadline]); }
  finally { clearTimeout(timer); parentSignal?.removeEventListener('abort', abortHandler); }
}
