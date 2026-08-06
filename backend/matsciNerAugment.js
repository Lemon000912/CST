/**
 * 调用本机 MatSciBERT NER（默认 E:\15w\pipeline.py）为检索 query 追加材料实体短语。
 * 常驻 Python 子进程（--serve），避免每次检索重复加载大模型。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SCRIPT = path.join(__dirname, "scripts", "matsci_query_entities.py");

function matsciPython() {
  const p = String(process.env.MATSCI_PYTHON ?? "").trim();
  return p || (process.platform === "win32" ? "python" : "python3");
}

function pipelineRoot() {
  return String(process.env.MATSCI_PIPELINE_ROOT ?? "").trim();
}

/** @type {import('node:child_process').ChildProcessWithoutNullStreams | null} */
let child = null;
let buf = "";
/** @type {Promise<void> | null} */
let readyPromise = null;
/** @type {((v: void) => void) | null} */
let readyResolve = null;
/** @type {((e: Error) => void) | null} */
let readyReject = null;

/** @type {Array<{ resolve: (s: string) => void; reject: (e: Error) => void }>} */
const queue = [];

/** @type {Promise<void>} */
let mutex = Promise.resolve();

function killChild() {
  if (child && !child.killed) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  child = null;
  buf = "";
  readyPromise = null;
  readyResolve = null;
  readyReject = null;
}

function ensureChild() {
  if (child && !child.killed) return;
  buf = "";
  readyPromise = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const py = matsciPython();
  const env = {
    ...process.env,
    MATSCI_PIPELINE_ROOT: pipelineRoot(),
    PYTHONUNBUFFERED: "1",
    PYTHONIOENCODING: "utf-8",
  };
  child = spawn(py, [SCRIPT, "--serve"], {
    cwd: __dirname,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr?.on("data", (c) => {
    const s = c.toString();
    if (s.trim()) console.warn("[matsci-ner]", s.slice(0, 400));
  });
  child.stdout?.on("data", (c) => {
    buf += c.toString();
    const parts = buf.split("\n");
    buf = parts.pop() ?? "";
    for (const line of parts) {
      if (!line.trim()) continue;
      let j;
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      if (j.ready === true) {
        readyResolve?.();
        readyResolve = null;
        readyReject = null;
        continue;
      }
      const job = queue.shift();
      if (job) {
        if (j.ok === false) job.reject(new Error(j.error || "matsci failed"));
        else job.resolve(line);
      }
    }
  });
  child.on("error", (e) => {
    readyReject?.(e);
    killChild();
  });
  child.on("exit", () => {
    killChild();
    while (queue.length) {
      const j = queue.shift();
      j?.reject(new Error("matsci python exited"));
    }
  });
}

/**
 * @param {string} mergedQuery
 * @returns {Promise<string>} 原文或附带 NER 后缀的 query
 */
export async function augmentQueryWithMatsci(mergedQuery) {
  const q = String(mergedQuery ?? "").trim();
  if (!q || String(process.env.MATSCI_NER_DISABLE ?? "").trim() === "1") return q;

  const run = async () => {
    const timeoutMs = Math.min(300_000, Number(process.env.MATSCI_NER_READY_MS ?? 300_000) || 300_000);
    try {
      ensureChild();
      await Promise.race([
        readyPromise,
        new Promise((_, rej) => setTimeout(() => rej(new Error("matsci ready timeout")), timeoutMs)),
      ]);
      if (!child?.stdin) throw new Error("matsci child not ready");

      const line = JSON.stringify({ text: q.slice(0, 50_000) });
      const resp = await new Promise((res, rej) => {
        queue.push({
          resolve: (raw) => res(raw),
          reject: rej,
        });
        try {
          child.stdin.write(`${line}\n`);
        } catch (e) {
          queue.pop();
          rej(e);
        }
      });
      const j = JSON.parse(resp);
      if (!j.ok) throw new Error(j.error || "matsci");
      const suf = String(j.suffix ?? "").trim();
      if (!suf) return q;
      const block = `\n\n---- MatSciBERT NER（材料实体，供检索对齐）----\n${suf}`;
      return (q + block).slice(0, 55_000);
    } catch (e) {
      console.warn("[matsci-ner] augment skipped:", e?.message || e);
      killChild();
      return q;
    }
  };

  const p = mutex.then(run);
  mutex = p.then(() => {}).catch(() => {});
  return p;
}

export function isMatsciAugmentConfigured() {
  const root = pipelineRoot();
  const disabled = String(process.env.MATSCI_NER_DISABLE ?? "").trim() === "1";
  return !disabled && Boolean(root) && fs.existsSync(root) && fs.existsSync(SCRIPT);
}
