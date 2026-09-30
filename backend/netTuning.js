/**
 * 调整 Node 内置 fetch（undici）的全局连接参数。
 *
 * Node 内置 fetch 默认连接超时固定 10s（含 DNS + TCP + TLS 握手），
 * 网络丢包时握手重传很容易超过 10s，报 UND_ERR_CONNECT_TIMEOUT。
 * 这里复用 Node 自带的 undici Agent 类重建全局 dispatcher，无需额外依赖，
 * 且与当前 Node 版本内置的 undici 保持一致。
 *
 * 环境变量：NODE_FETCH_CONNECT_TIMEOUT_MS（默认 30000，设为 0 保持 Node 默认值）
 */

const GLOBAL_DISPATCHER = Symbol.for("undici.globalDispatcher.1");

export async function applyFetchConnectTimeout() {
  const raw = process.env.NODE_FETCH_CONNECT_TIMEOUT_MS;
  const ms = raw === undefined || String(raw).trim() === "" ? 30_000 : Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) return { applied: false, reason: "disabled" };
  const timeout = Math.min(120_000, Math.max(1000, Math.floor(ms)));
  try {
    // 内置 fetch 懒加载：先触发一次（data: URL 不走网络），全局 dispatcher 才会创建
    if (!globalThis[GLOBAL_DISPATCHER]) await fetch("data:,").catch(() => {});
    const current = globalThis[GLOBAL_DISPATCHER];
    const Agent = current?.constructor;
    if (typeof Agent !== "function") return { applied: false, reason: "no-dispatcher" };
    globalThis[GLOBAL_DISPATCHER] = new Agent({ connect: { timeout } });
    return { applied: true, timeout };
  } catch (e) {
    return { applied: false, reason: String(e?.message || e) };
  }
}
