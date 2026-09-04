#!/usr/bin/env node
/**
 * 释放校园版和企业版开发端口，避免旧进程导致连接到错误版本。
 * 用法：npm run dev:kill
 */
import { execFileSync, execSync } from "node:child_process";
import process from "node:process";

const PORTS = [8787, 8788, 5175, 5176];

function killPort(port) {
  const killed = new Set();

  if (process.platform === "win32") {
    try {
      const out = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" });
      for (const line of out.split(/\r?\n/)) {
        const match = line.match(new RegExp(`^\\s*TCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$`, "i"));
        if (match) killed.add(Number(match[1]));
      }
    } catch {
      /* netstat unavailable or no matching listener */
    }
  }

  if (process.platform !== "win32") {
    try {
      const out = execSync(`ss -tlnp 2>/dev/null | grep ":${port} "`, { encoding: "utf8" });
      for (const line of out.split("\n")) {
        const m = line.match(/pid=(\d+)/);
        if (m) killed.add(Number(m[1]));
      }
    } catch {
      /* 无监听或系统没有 ss */
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
  }

  for (const pid of killed) {
    try {
      if (process.platform === "win32") {
        execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        process.kill(pid, "SIGTERM");
      }
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
