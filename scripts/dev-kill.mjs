#!/usr/bin/env node
/**
 * 释放开发端口 8787（API）与 5175（Vite），避免旧 node 进程导致连到旧版后端。
 * 用法：npm run dev:kill
 */
import { execSync } from "node:child_process";

const PORTS = [8787, 5175];

function killPort(port) {
  const killed = new Set();

  try {
    const out = execSync(`ss -tlnp 2>/dev/null | grep ":${port} "`, { encoding: "utf8" });
    for (const line of out.split("\n")) {
      const m = line.match(/pid=(\d+)/);
      if (m) killed.add(Number(m[1]));
    }
  } catch {
    /* 无监听 */
  }

  if (!killed.size) {
    try {
      const pids = execSync(`lsof -ti:${port} 2>/dev/null`, { encoding: "utf8" })
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      for (const p of pids) killed.add(Number(p));
    } catch {
      /* ignore */
    }
  }

  for (const pid of killed) {
    try {
      process.kill(pid, "SIGTERM");
      console.log(`[dev:kill] 已结束 PID ${pid}（端口 ${port}）`);
    } catch (e) {
      console.warn(`[dev:kill] 无法结束 PID ${pid}:`, e?.message || e);
    }
  }

  if (!killed.size) {
    console.log(`[dev:kill] 端口 ${port} 无占用`);
  }
}

for (const port of PORTS) killPort(port);
console.log("[dev:kill] 完成。可执行 npm run dev 重新启动。");