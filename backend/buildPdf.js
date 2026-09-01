import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectProcessSteps, extractRecipeLines } from "./processArtifacts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PY_SCRIPT = path.join(__dirname, "scripts", "render_artifact_pdf.py");

function cleanInline(value) {
  return String(value ?? "")
    .replace(/\*\*/g, "")
    .replace(/\*(?!\*)/g, "")
    .replace(/`+/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function parseMarkdownSections(markdown, maxSections = 14) {
  const text = String(markdown ?? "").trim();
  if (!text) return [];
  const sections = [];
  for (const part of text.split(/\n(?=#{1,3}\s)/)) {
    const lines = part.split("\n").map((line) => line.trim()).filter(Boolean);
    if (!lines.length) continue;
    const head = cleanInline(lines[0].replace(/^#+\s*/, "")).slice(0, 80);
    const bullets = [];
    for (const line of lines.slice(1)) {
      if (line.startsWith("|") || line.startsWith("```")) continue;
      const list = line.match(/^[-*•]\s+(.+)/)?.[1] ?? line.match(/^\d+[.、．):：]\s+(.+)/)?.[1] ?? null;
      if (list) bullets.push(cleanInline(list).slice(0, 500));
      else if (!line.startsWith("#") && line.length >= 6) bullets.push(cleanInline(line).slice(0, 500));
    }
    if (!bullets.length) {
      const body = cleanInline(lines.slice(1).join(" ")).slice(0, 700);
      if (body) bullets.push(body);
    }
    if (head && bullets.length) sections.push({ head, bullets: bullets.slice(0, 12) });
    if (sections.length >= maxSections) break;
  }
  if (!sections.length) {
    const plain = cleanInline(text.replace(/^#+\s*/gm, "")).slice(0, 900);
    if (plain) sections.push({ head: "方案摘要", bullets: [plain] });
  }
  return sections;
}

function pythonCmdCandidates() {
  const custom = String(process.env.PDF_PYTHON ?? process.env.MATPLOTLIB_PYTHON ?? "").trim();
  if (custom) return [[custom]];
  return process.platform === "win32" ? [["python"], ["py", "-3"], ["python3"]] : [["python3"], ["python"]];
}

function runPython(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ code: 124, stderr: `${stderr}\n(timeout)` }); }, 55_000);
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: 127, stderr: String(error?.message || error) }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stderr }); });
  });
}

/** Generate a PDF using the same content extraction as the PPT export. */
export async function buildPdfBuffer(opts) {
  const inputPath = path.join(os.tmpdir(), `qp-artifact-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const outputPath = path.join(os.tmpdir(), `qp-artifact-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  const markdown = String(opts.synthesisMarkdown ?? "").trim();
  const plan = opts.synthesisPlan && typeof opts.synthesisPlan === "object" ? opts.synthesisPlan : null;
  const payload = {
    title: String(opts.title ?? "方案汇报").trim().slice(0, 120) || "方案汇报",
    sections: parseMarkdownSections(markdown),
    recipes: extractRecipeLines(markdown),
    steps: collectProcessSteps(plan, markdown),
    rows: Array.isArray(plan?.extractedData) ? plan.extractedData : [],
  };
  await fs.writeFile(inputPath, JSON.stringify(payload), "utf8");
  let lastError = "未执行";
  try {
    for (const parts of pythonCmdCandidates()) {
      const result = await runPython(parts[0], [...parts.slice(1), PY_SCRIPT, inputPath, outputPath]);
      if (result.code === 0) {
        const buffer = await fs.readFile(outputPath);
        return buffer;
      }
      lastError = result.stderr.trim() || `exit ${result.code}`;
    }
    throw new Error(`PDF 渲染失败：${lastError.slice(0, 500)}。请安装 Python3 与 reportlab，或设置 PDF_PYTHON。`);
  } finally {
    await fs.unlink(inputPath).catch(() => {});
    await fs.unlink(outputPath).catch(() => {});
  }
}

