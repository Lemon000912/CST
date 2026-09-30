import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { applyFetchConnectTimeout } from "../netTuning.js";

const GLOBAL_DISPATCHER = Symbol.for("undici.globalDispatcher.1");

test("applyFetchConnectTimeout: 自定义连接超时对内置 fetch 生效", async () => {
  const saved = globalThis[GLOBAL_DISPATCHER];
  const prevEnv = process.env.NODE_FETCH_CONNECT_TIMEOUT_MS;
  // 只接受 TCP、不回应 TLS 握手，模拟握手卡住
  const srv = net.createServer(() => {}).listen(0);
  try {
    process.env.NODE_FETCH_CONNECT_TIMEOUT_MS = "1500";
    const r = await applyFetchConnectTimeout();
    assert.equal(r.applied, true);
    assert.equal(r.timeout, 1500);
    const t0 = Date.now();
    const err = await fetch(`https://127.0.0.1:${srv.address().port}/`).catch((e) => e);
    const elapsed = Date.now() - t0;
    assert.equal(err?.cause?.code, "UND_ERR_CONNECT_TIMEOUT");
    assert.ok(elapsed >= 1400 && elapsed < 8000, `elapsed=${elapsed}`);
  } finally {
    srv.close();
    globalThis[GLOBAL_DISPATCHER] = saved;
    if (prevEnv === undefined) delete process.env.NODE_FETCH_CONNECT_TIMEOUT_MS;
    else process.env.NODE_FETCH_CONNECT_TIMEOUT_MS = prevEnv;
  }
});

test("applyFetchConnectTimeout: 设为 0 时保持 Node 默认", async () => {
  const prevEnv = process.env.NODE_FETCH_CONNECT_TIMEOUT_MS;
  process.env.NODE_FETCH_CONNECT_TIMEOUT_MS = "0";
  try {
    const r = await applyFetchConnectTimeout();
    assert.equal(r.applied, false);
  } finally {
    if (prevEnv === undefined) delete process.env.NODE_FETCH_CONNECT_TIMEOUT_MS;
    else process.env.NODE_FETCH_CONNECT_TIMEOUT_MS = prevEnv;
  }
});
