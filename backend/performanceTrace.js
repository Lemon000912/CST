const MAX_STAGES = 240;

function safeDetails(value) {
  if (!value || typeof value !== "object") return undefined;
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw == null) continue;
    if (typeof raw === "number" || typeof raw === "boolean") {
      out[key] = raw;
    } else if (typeof raw === "string") {
      out[key] = raw.slice(0, 240);
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/** Request-scoped, concurrency-safe performance trace for user-visible search work. */
export function createPerformanceTrace(requestId) {
  const startedAt = Date.now();
  const stages = [];

  const start = (name, details) => {
    const stageStartedAt = Date.now();
    let ended = false;
    return (endDetails) => {
      if (ended || stages.length >= MAX_STAGES) return;
      ended = true;
      const stage = {
        name: String(name || "unknown").slice(0, 96),
        startMs: Math.max(0, stageStartedAt - startedAt),
        durationMs: Math.max(0, Date.now() - stageStartedAt),
        ...((safeDetails({ ...details, ...endDetails }))
          ? { details: safeDetails({ ...details, ...endDetails }) }
          : {}),
      };
      stages.push(stage);
      console.log("[perf-stage]", JSON.stringify({ requestId, ...stage }));
    };
  };

  const snapshot = () => ({
    version: 1,
    requestId: String(requestId || "").slice(0, 128) || undefined,
    startedAt,
    totalMs: Math.max(0, Date.now() - startedAt),
    stages: [...stages].sort((a, b) => a.startMs - b.startMs || a.durationMs - b.durationMs),
  });

  return { start, snapshot };
}

export async function traceAsync(trace, name, details, task, summarize) {
  const end = trace?.start?.(name, details);
  try {
    const value = await task();
    end?.({ ok: true, ...(summarize ? summarize(value) : {}) });
    return value;
  } catch (error) {
    end?.({ ok: false, error: String(error?.message || error).slice(0, 160) });
    throw error;
  }
}
