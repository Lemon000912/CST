import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { validateHeaderValue as httpValidateHeaderValue } from "node:http";
import { fileURLToPath } from "node:url";
import express from "express";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_ENV_PATH = path.resolve(__dirname, "..", ".env");
/** 无论从哪里启动 node，都先读项目根目录 .env，再读 cwd 下的 .env（可覆盖） */
dotenv.config({ path: ROOT_ENV_PATH });
dotenv.config();

// 调试：检查环境变量加载情况
const llmKey = process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
console.log("[env] LLM_API_KEY / OPENAI_API_KEY loaded:", llmKey ? "Yes (length: " + llmKey.length + ")" : "No");
console.log("[env] LLM key prefix:", llmKey ? llmKey.slice(0, 7) + "..." : "N/A");

const dbUrl = process.env.DATABASE_URL;
console.log("[env] DATABASE_URL loaded:", dbUrl ? "Yes" : "No");
console.log("[env] DATABASE_URL prefix:", dbUrl ? dbUrl.slice(0, 30) + "..." : "N/A");

import cors from "cors";
import {
  initDatabase,
  isDatabaseReady,
  isPostgres,
  logQuery,
  insertFeedback,
  getSqliteDb,
  pgPool,
} from "./db.js";
import { seedSimplePapersFromJson } from "./seedSimpleData.js";
import { seedDevAdminIfEnabled } from "./seedDevAdmin.js";
import { runPaperSearch } from "./searchService.js";
import { extractCoreSearchQuery, extractConversationContext } from "./searchQueryNormalize.js";
import { synthesizeDatabaseCombined } from "./synthesizeDatabase.js";
import {
  shouldUseAttachmentPrimarySynthesis,
  synthesizeFromAttachmentContext,
} from "./synthesizeAttachment.js";
import { synthesizeWebTriAnswer } from "./webTriAnswer.js";
import { getPersonaSkill, listPersonas, normalizePersonaId } from "./personaSkills.js";
import { getMcpWebSearchConfig } from "./mcpWebSearch.js";
import { getDataifyWebSearchConfig } from "./dataifyWebSearch.js";
import { getDataifyWebUnlockerConfig } from "./dataifyWebUnlocker.js";
import { getTavilyWebSearchConfig } from "./tavilyWebSearch.js";
import {
  getWebSourcesStatus,
  getWebSourceAllowlist,
  isBingWebEnabled,
  FREE_WEB_SEARCH_CATALOG,
} from "./mcpWebSearch.js";
import { getElsevierScopusConfig } from "./scopusElsevier.js";
import { lookupUnpaywallOa } from "./unpaywallOa.js";
import { rateLimitHit } from "./rateLimit.js";
import { uploadMiddleware, extractDocumentText, MAX_UPLOAD_MB } from "./extract.js";
import { buildProcessArtifacts } from "./processArtifacts.js";
import { buildPptxBuffer } from "./buildPptx.js";
import { extractBookTitles, isBookIntentQuery } from "./bookWebClues.js";
import {
  shouldUseBookClueSynthesis,
  synthesizeBookFromWebClues,
} from "./bookWebSynthesize.js";
import {
  handleLogin,
  handleMe,
  handleRegister,
  requireAdmin,
  requireAuthenticatedUser,
  resolveUserIdFromRequest,
} from "./auth.js";
import {
  BillingError,
  PRICING_CATALOG,
  beginBillableOperation,
  calculateCostUnits,
  completeBillableOperation,
  countUnicodeCodePoints,
  failBillableOperation,
  getBillableOperation,
  getPointBalance,
  stableRequestHash,
} from "./billing.js";
import { fetchPdfSecurely, PdfFulfillmentError } from "./pdfFulfillment.js";
import {
  saveUserSkill,
  getUserSkill,
  recordDownloadedPaper,
  getUserDownloadedPapers,
  recordAnswerFeedback,
  getUserAnswerFeedback,
  updateUserInfo,
  listAllUsers,
  getDatabaseStats,
  getSearchHistory,
  getUserChatSessions,
  saveUserChatSessions,
} from "./db.js";
import {
  extractChartSpecWithLlm,
  normalizeChartSpec,
  renderChartPngWithMatplotlib,
  buildFallbackChartSpecFromAbstracts,
} from "./paperChart.js";
import { extractDataTableByType } from "./dataTableExtract.js";
import { augmentQueryWithMatsci, isMatsciAugmentConfigured } from "./matsciNerAugment.js";
import { GStack, quickGStack } from "./gstack.js";
import { GBrain, getGBrain } from "./gbrain.js";
import { searchCache, rewriteCache } from "./cache.js";

const PORT = (() => {
  const n = Number.parseInt(String(process.env.PORT ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : 8787;
})();

// 初始化 GStack 和 GBrain
const gstack = new GStack();
const gbrain = getGBrain();

console.log("[GStack] 图融合引擎已初始化");
console.log("[GBrain] 知识图谱大脑已初始化");

// 启动时清除缓存（避免旧缓存数据污染）
searchCache.clear();
rewriteCache.clear();
console.log("[cache] 搜索缓存和改写缓存已清除");

function clientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length) return xf.split(",")[0].trim();
  return req.socket?.remoteAddress || "local";
}

class ApiRouteError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = "ApiRouteError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function sendStructuredError(res, error, fallback = {}) {
  if (error instanceof BillingError) {
    return res.status(error.status).json({
      error: error.message,
      code: error.code,
      ...(error.details === undefined ? {} : { details: error.details }),
    });
  }
  if (error instanceof ApiRouteError || error instanceof PdfFulfillmentError) {
    return res.status(error.status).json({
      error: error.message,
      code: error.code,
      ...(error.details === undefined ? {} : { details: error.details }),
    });
  }
  const status = Number.isInteger(fallback.status) ? fallback.status : 500;
  return res.status(status).json({
    error: fallback.message || error?.message || "服务器错误",
    ...(fallback.code ? { code: fallback.code } : {}),
    ...(fallback.extra || {}),
  });
}

function requireIdempotencyKey(req) {
  const value = String(req.headers["idempotency-key"] ?? "").trim();
  if (!value) {
    throw new BillingError("idempotency-key-required", "Idempotency-Key header is required", 400);
  }
  if (value.length > 200) {
    throw new BillingError("invalid-idempotency-key", "Idempotency-Key must not exceed 200 characters", 400);
  }
  return value;
}

async function failOperationBestEffort(operation, userId, error) {
  if (!operation?.id || !operation?.leaseToken) return;
  const rawCode = String(error?.code || "operation-failed").toLowerCase();
  const errorCode = rawCode.replace(/[^a-z0-9_-]/g, "-").slice(0, 100) || "operation-failed";
  try {
    await failBillableOperation({
      operationId: operation.id,
      userId,
      leaseToken: operation.leaseToken,
      errorCode,
    });
  } catch (billingFailure) {
    console.error("[billing/fail]", billingFailure?.message || billingFailure);
  }
}

function searchBillingDetails(payload) {
  const synthesisCharacterCount = countUnicodeCodePoints(payload?.synthesis);
  const deepSynthesisCharacterCount = countUnicodeCodePoints(payload?.deepSynthesis);
  const uniqueDeepPapers = new Set();
  for (const [index, paper] of (payload?.deepMine?.papers ?? []).entries()) {
    if (!Array.isArray(paper?.steps) || !paper.steps.includes("mineru:ok")) continue;
    const key = String(
      paper?.paper_id ?? paper?.paperId ?? paper?.id ?? paper?.doi ?? paper?.pdfUrl ?? paper?.title ?? index,
    ).trim().toLowerCase();
    uniqueDeepPapers.add(key || `index:${index}`);
  }
  const characterCount = synthesisCharacterCount + deepSynthesisCharacterCount;
  const deepPaperCount = uniqueDeepPapers.size;
  return {
    characterCount,
    synthesisCharacterCount,
    deepSynthesisCharacterCount,
    deepPaperCount,
    characterUnits: calculateCostUnits({ characterCount }),
    deepPaperUnits: calculateCostUnits({ pdfCount: deepPaperCount }),
  };
}

function getStoredSearchPapers(parentOperation) {
  if (parentOperation?.operationType !== "search" || parentOperation?.status !== "completed") {
    throw new ApiRouteError(409, "invalid-parent-operation", "Parent operation must be a completed search");
  }
  const papers = parentOperation?.result?.papers;
  if (!Array.isArray(papers)) {
    throw new ApiRouteError(409, "parent-result-unavailable", "Parent search has no stored paper result");
  }
  return papers;
}

function paperIdentity(paper, index) {
  return String(paper?.paper_id ?? paper?.paperId ?? paper?.id ?? paper?.doi ?? `index:${index}`).trim();
}

function selectStoredPapers(parentPapers, body, maxCount = 22) {
  const indices = Array.isArray(body?.paperIndices)
    ? body.paperIndices.filter((value) => Number.isInteger(value) && value >= 0 && value < parentPapers.length)
    : [];
  const ids = new Set(
    (Array.isArray(body?.paperIds) ? body.paperIds : [])
      .map((value) => String(value ?? "").trim())
      .filter(Boolean),
  );
  let selected = parentPapers;
  if (indices.length) selected = [...new Set(indices)].map((index) => parentPapers[index]);
  else if (ids.size) selected = parentPapers.filter((paper, index) => ids.has(paperIdentity(paper, index)));
  if (!selected.length) {
    throw new ApiRouteError(400, "papers-not-found", "No selected papers exist in the parent search result");
  }
  return selected.slice(0, maxCount);
}

const pdfArtifactCache = new Map();
const PDF_ARTIFACT_CACHE_MAX_ENTRIES = 8;
function cachePdfArtifact(operationId, artifact) {
  pdfArtifactCache.delete(operationId);
  pdfArtifactCache.set(operationId, artifact);
  while (pdfArtifactCache.size > PDF_ARTIFACT_CACHE_MAX_ENTRIES) {
    pdfArtifactCache.delete(pdfArtifactCache.keys().next().value);
  }
}

function pdfContentDisposition(rawTitle) {
  const unicodeName = `${String(rawTitle || "paper")
    .replace(/[\x00-\x1f\x7f\\/]/g, "_")
    .trim()
    .slice(0, 120) || "paper"}.pdf`;
  const asciiStem = unicodeName
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\/;=]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 120) || "paper.pdf";
  const asciiName = asciiStem.toLowerCase().endsWith(".pdf") ? asciiStem : `${asciiStem}.pdf`;
  const attrSafe = /^[A-Za-z0-9!#$&+.^_`|~-]$/;
  const encodedName = [...Buffer.from(unicodeName, "utf8")]
    .map((byte) => {
      const character = String.fromCharCode(byte);
      return attrSafe.test(character) ? character : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`;
}

const QUERY_SYNTAX_HELP = `## 查询语法（摘录）

- **默认**：分词式关键词检索；若启用 LLM，会将任意语言（含中文整句）理解为研究意图并输出**单行英文关键词**再检索。服务端使用 **OpenAI 兼容** Chat Completions（默认 URL 可为 DeepSeek 官方或其它网关），环境变量 \`LLM_CHAT_COMPLETIONS_URL\`、\`LLM_API_KEY\`（或 \`OPENAI_API_KEY\`）与侧栏 Key 一致即可；模型名见 \`LLM_MODEL\` / \`defaultModel()\`。
- **自建数据库**：在 \`.env\` 设置 \`DATABASE_URL=postgresql://用户:密码@主机:5432/数据库名\` 后重启 API，应用会使用 **PostgreSQL** 中的 \`papers\` 等表（启动时自动 \`CREATE TABLE IF NOT EXISTS\`）。\`papers\` 字段与 SQLite 一致：\`paper_id, doi, title, abstract, year, venue, oa_status, source_batch, created_at, updated_at, arxiv_id, authors_json, abs_url, pdf_url\`。**数据库优先**渠道仅检索该表。未设置 \`DATABASE_URL\` 时使用项目内 **SQLite**（\`backend/data/app.sqlite\`）。\`POST /api/v1/search\` 的 JSON \`max\` 为**上限**（数据库默认约 48、上限 80；网页默认约 28、上限 55）；实际条数由**与问题及用户喜好词的相关度**过滤决定，弱相关会被剔除，故可多可少。可选 \`preferenceKeywords\` 字符串数组（与账号侧栏「收藏关键词」同源）以收紧命中。
- **可选演示种子**：仅当 \`SIMPLE_SEED=1\` 时，启动会从 \`backend/data/simple-papers.json\`（若存在）及 \`simple datas/*.json\` 合并导入；默认**不**导入。检索词含 DOI 时本地按 DOI 列匹配（**数据库优先**渠道）。
- **网页全网（Dataify，可选）**：在 \`.env\` 设置 \`DATAIFY_API_KEY\` 后，「网页」渠道会**优先**调用 Dataify 搜索引擎 API 拉取链接；无结果或失败时再回退到 MCP Brave 或 DuckDuckGo。路径与鉴权可用 \`DATAIFY_API_BASE\`、\`DATAIFY_WEB_PATH\`、\`DATAIFY_AUTH_PREFIX\` 等与控制台文档对齐。
- **MCP 网页搜索（可选）**：配置 \`MCP_WEB_COMMAND\`、\`MCP_WEB_ARGS_JSON\` 后，在无 Dataify 结果时作为网页来源之一。详见 \`GET /api/v1/mcp/status\`。请求体 \`"useMcpWeb": false\` 将**跳过**专利与全网网页（DDG/Dataify/MCP）外呼，其它检索不变。
- **网页渠道（网页+专利）**：选择「网页」时**不检索** arXiv、Crossref、OpenAlex 论文、Semantic Scholar、Scopus、Europe PMC 等；仅 **并行** 拉取 **全网网页**（Dataify / MCP Brave / DuckDuckGo，每条须带 **http(s) 链接**）与 **专利**（OpenAlex 专利 + 专利网页检索）；并对网页条目**尽量抓取正文**（\`webFetchNote: fetched\`）写入 \`summary\`。**响应同时含**：\`synthesis\`（三模型联网综合回答）、\`papers[].summary\`（检索摘录，界面分块展示）。查论文库请用「**数据库优先**」；Scopus 仅数据库渠道（可选 \`ELSEVIER_API_KEY\`）。可配 \`SYNTHESIS_API_KEY_A/B/C\` 或单 Key + \`LLM_MODEL_B\` / \`LLM_MODEL_C\`；摘录长度见 \`WEB_FETCH_MAX_CHARS\`、\`WEB_SYNTH_EXCERPT_*\`。
- **文献综述**：已配置 LLM Key 时，\`POST /api/v1/search\` 默认在检索完成后基于返回文献的**摘要摘录**再调用一次模型，生成中文综述；引用处须带 \`(DOI: …)\` 或 \`(arXiv: …)\`（由模型按摘录中的标识书写）。**若用户问题或摘录涉及工艺链、工序、产线/SOP 等**，综述中的「方案说明」会要求包含 **\`### 工序流程\`** 有序步骤，且与响应 JSON 字段 \`synthesisPlan.steps\` 对齐。请求体 \`"includeSynthesis": false\` 可关闭以节省 token。**双模型共识**：请求头 \`X-Model-B\` 或 JSON \`"modelB": "…"\`（或 \`LLM_MODEL_B\`）指定第二模型时，主模型与模型 B **并行**生成综述后，再调用一次主 Key 的模型仅保留两份综述的**共享部分**（见响应 \`synthesisModels\` 与 \`synthesisNote\`）。**三密钥 A/B 写、C 仲裁**：在服务端 \`.env\` 同时配置 \`SYNTHESIS_API_KEY_A\`、\`SYNTHESIS_API_KEY_B\`、\`SYNTHESIS_API_KEY_C\` 时，综述由 A、B 各用独立 Key 并行生成，再由 C 的 Key 调用模型输出**唯一终稿**（\`synthesisModels.mode\` 为 \`tri_arbitration\`）；可选 \`SYNTHESIS_MODEL_A\` / \`_B\` / \`_C\`、\`SYNTHESIS_CHAT_URL_A\` / \`_B\` / \`_C\` 指定模型名与兼容接口 URL（未设则沿用 \`LLM_CHAT_COMPLETIONS_URL\` 与默认模型名）。
- **身份 / 用途（Skill）**：请求头 \`X-Persona\` 或 JSON 体 \`persona\` 填内置 id（见 \`GET /api/v1/personas\`）。服务端在**检索式 LLM 改写**与**文献综述**前会先拼接对应 Skill 再调用模型；未传时默认为 \`researcher\`。
- **上传**：支持 PDF、Markdown、TXT、Word（.docx / .doc），解析后的正文会并入检索上下文（见 \`POST /api/v1/extract\`）。
- **无命中扩检**：\`POST /api/v1/search\` 在首次检索返回文献 **≤12 条**时，会自动再跑一轮放宽检索（arXiv 字段固定为全文综合 \`all\`、关闭检索式 LLM 改写或附带扩检提示再改写），仍无结果时会在 \`rewriteNote\` 中带 \`expand2:still_zero\`。
- **材料 MatSciBERT（身份 skill）**：侧栏身份选 **「材料 MatSciBERT（NER）」**（id: \`materials_matsci\`）时，服务端会用本机 Python 加载 \`MATSCI_PIPELINE_ROOT\`（默认 \`E:\\15w\`）下的 \`pipeline.py\` + MatSciBERT NER，在用户检索句后追加材料实体短语，再进入 LLM 检索式改写与多源检索。需已安装与 \`E:\\15w\` 管线相同的 PyTorch / transformers / nltk 等；可用 \`MATSCI_PYTHON\` 指定解释器，\`MATSCI_NER_DISABLE=1\` 关闭。
- **短语**：用英文双引号包裹，例如 \`"deep learning"\`。
- **作者**：\`author:Einstein\` 或 \`author:"Yann LeCun"\`（映射 arXiv \`au:\`）。
- **年份**：\`year:2023\`（映射 arXiv 提交时间区间）。

更多字段组合可在后续版本扩展。`;

const app = express();
const AGENT_DEBUG_LOG_PATH = path.join(__dirname, "..", ".cursor", "debug-ef7a54.log");
// #region agent log
function agentDbgChartBackend(location, hypothesisId, message, data) {
  const payload = {
    sessionId: "ef7a54",
    hypothesisId,
    location,
    message,
    data,
    timestamp: Date.now(),
  };
  try {
    fs.mkdirSync(path.dirname(AGENT_DEBUG_LOG_PATH), { recursive: true });
    fs.appendFileSync(AGENT_DEBUG_LOG_PATH, `${JSON.stringify(payload)}\n`);
  } catch {
    /* ignore */
  }
  fetch("http://127.0.0.1:7467/ingest/0e8c1981-4719-4a28-ab2f-2d5a4ae28120", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "ef7a54" },
    body: JSON.stringify(payload),
  }).catch(() => {});
}
// #endregion
app.use(cors({ origin: true }));
/** 文献作图等接口会携带多篇摘录 + 综述，4MB 易触发 entity.too.large，body-parser 默认返回 HTML 导致前端「非 JSON」 */
app.use(express.json({ limit: "24mb" }));

/** 浏览器直接打开根路径时避免 Express 默认 “Cannot GET /” */
app.get("/", (_req, res) => {
  res.json({
    service: "quantum-pinnacle-api",
    hint: "本端口为 API 服务，无网页首页。开发中前端请访问 Vite：http://127.0.0.1:5173/",
    links: {
      health: "/api/health",
      admin: "/admin/",
    },
  });
});

// ==================== 管理端静态文件 ====================
const adminDir = path.resolve(__dirname, "..", "admin");
const adminExists = fs.existsSync(adminDir);
if (adminExists) {
  app.use("/admin", express.static(adminDir));
  console.log(`[admin] 管理端静态文件已挂载: /admin → ${adminDir}`);
} else {
  console.warn(`[admin] 管理端目录不存在: ${adminDir}`);
}

// 数据库就绪检查中间件（仅对 /api/ 路由生效，不影响静态文件和管理端）
app.use("/api", (req, res, next) => {
  if (!isDatabaseReady()) {
    console.error("[db] 未初始化");
    return res.status(503).json({ error: "数据库尚未就绪" });
  }
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "quantum-pinnacle",
    version: "1",
    /** 前端可据此判断当前 8787 是否为带图表路由的新版 API */
    features: {
      chartFromPapers: true,
      matsciNerAugment: isMatsciAugmentConfigured(),
      deepPaperMine: true,
    },
  });
});

app.post("/api/v1/auth/register", async (req, res) => {
  await handleRegister(req, res);
});

// Deny every current and future management endpoint by default unless the
// request has a valid token for a server-configured administrator.
app.use("/api/v1/admin", requireAdmin);

app.post("/api/v1/auth/login", async (req, res) => {
  await handleLogin(req, res);
});

app.get("/api/v1/auth/me", async (req, res) => {
  await handleMe(req, res);
});

app.get("/api/v1/billing/balance", requireAuthenticatedUser, async (req, res) => {
  try {
    const balance = await getPointBalance(req.auth.userId);
    return res.json({ balance, pricing: PRICING_CATALOG });
  } catch (error) {
    return sendStructuredError(res, error, { message: "Unable to read point balance" });
  }
});

app.get("/api/v1/billing/operations/:id", requireAuthenticatedUser, async (req, res) => {
  try {
    const operation = await getBillableOperation({
      operationId: req.params.id,
      userId: req.auth.userId,
    });
    return res.json({ operation, pricing: PRICING_CATALOG });
  } catch (error) {
    return sendStructuredError(res, error, { message: "Unable to read billing operation" });
  }
});

/** 聊天会话：服务端持久化（后端重启/更新不丢记录） */
app.get("/api/v1/chat/sessions", async (req, res) => {
  try {
    const userId = await resolveUserIdFromRequest(req);
    if (!userId || userId === "anonymous") {
      return res.status(401).json({ error: "未登录" });
    }
    const row = await getUserChatSessions(userId);
    if (!row?.sessionsJson) {
      return res.json({ sessions: [], updatedAt: 0 });
    }
    let sessions = [];
    try {
      const parsed = JSON.parse(row.sessionsJson);
      sessions = Array.isArray(parsed) ? parsed : [];
    } catch {
      sessions = [];
    }
    return res.json({ sessions, updatedAt: row.updatedAt });
  } catch (e) {
    console.error("[chat/sessions GET]", e);
    return res.status(500).json({ error: e?.message || "读取会话失败" });
  }
});

app.put("/api/v1/chat/sessions", async (req, res) => {
  const ip = clientIp(req);
  if (!rateLimitHit(ip, { max: 60, windowMs: 60_000 })) {
    return res.status(429).json({ error: "保存过于频繁，请稍后再试" });
  }
  try {
    const userId = await resolveUserIdFromRequest(req);
    if (!userId || userId === "anonymous") {
      return res.status(401).json({ error: "未登录" });
    }
    const sessions = req.body?.sessions;
    if (!Array.isArray(sessions)) {
      return res.status(400).json({ error: "sessions 须为数组" });
    }
    const updatedAt = Number(req.body?.updatedAt) || Date.now();
    const json = JSON.stringify(sessions);
    if (json.length > 6_000_000) {
      return res.status(413).json({ error: "会话数据过大，请导出后清理部分旧对话" });
    }
    const ok = await saveUserChatSessions(userId, json, updatedAt);
    if (!ok) return res.status(500).json({ error: "保存失败" });
    return res.json({ ok: true, updatedAt, count: sessions.length });
  } catch (e) {
    console.error("[chat/sessions PUT]", e);
    return res.status(500).json({ error: e?.message || "保存会话失败" });
  }
});

// ==================== 用户特征Skill API ====================

/** 获取当前用户的Skill */
app.get("/api/v1/user/skill", async (req, res) => {
  try {
    const userId = await resolveUserIdFromRequest(req);
    if (!userId || userId === "anonymous") {
      return res.status(401).json({ error: "未登录" });
    }
    const skill = await getUserSkill(userId);
    if (!skill) {
      // 返回默认skill
      return res.json({
        personaId: "researcher",
        favoriteKeywords: [],
        downloadedPapers: [],
        answerFeedback: [],
      });
    }
    res.json({
      personaId: skill.persona_id,
      favoriteKeywords: skill.favorite_keywords ? JSON.parse(skill.favorite_keywords) : [],
      downloadedPapers: skill.downloaded_papers ? JSON.parse(skill.downloaded_papers) : [],
      answerFeedback: skill.answer_feedback ? JSON.parse(skill.answer_feedback) : [],
      updatedAt: skill.updated_at,
    });
  } catch (e) {
    console.error("[user/skill]", e);
    res.status(500).json({ error: "获取用户Skill失败" });
  }
});

/** 更新当前用户的Skill */
app.post("/api/v1/user/skill", async (req, res) => {
  try {
    const userId = await resolveUserIdFromRequest(req);
    if (!userId || userId === "anonymous") {
      return res.status(401).json({ error: "未登录" });
    }
    const { personaId, favoriteKeywords, downloadedPapers, answerFeedback } = req.body || {};
    await saveUserSkill(userId, {
      personaId,
      favoriteKeywords: favoriteKeywords ? JSON.stringify(favoriteKeywords) : null,
      downloadedPapers: downloadedPapers ? JSON.stringify(downloadedPapers) : null,
      answerFeedback: answerFeedback ? JSON.stringify(answerFeedback) : null,
    });
    res.json({ ok: true });
  } catch (e) {
    console.error("[user/skill]", e);
    res.status(500).json({ error: "保存用户Skill失败" });
  }
});

/** 记录用户下载的论文 */
app.post("/api/v1/user/downloaded-paper", async (req, res) => {
  try {
    const userId = await resolveUserIdFromRequest(req);
    if (!userId || userId === "anonymous") {
      return res.status(401).json({ error: "未登录" });
    }
    const { paperId, title, doi, source } = req.body || {};
    if (!paperId) return res.status(400).json({ error: "缺少paperId" });
    await recordDownloadedPaper(userId, { paperId, title, doi, source });
    res.json({ ok: true });
  } catch (e) {
    console.error("[user/downloaded-paper]", e);
    res.status(500).json({ error: "记录下载失败" });
  }
});

/** 获取用户下载的论文列表 */
app.get("/api/v1/user/downloaded-papers", async (req, res) => {
  try {
    const userId = await resolveUserIdFromRequest(req);
    if (!userId || userId === "anonymous") {
      return res.status(401).json({ error: "未登录" });
    }
    const limit = Math.min(100, Math.max(1, Number(req.query?.limit) || 50));
    const papers = await getUserDownloadedPapers(userId, limit);
    res.json({ papers });
  } catch (e) {
    console.error("[user/downloaded-papers]", e);
    res.status(500).json({ error: "获取下载列表失败" });
  }
});

/** 记录用户对答案的反馈 (good=1, bad=-1) */
app.post("/api/v1/user/answer-feedback", async (req, res) => {
  try {
    const userId = await resolveUserIdFromRequest(req);
    if (!userId || userId === "anonymous") {
      return res.status(401).json({ error: "未登录" });
    }
    const { query, answer, value } = req.body || {};
    if (value !== 1 && value !== -1) {
      return res.status(400).json({ error: "value须为1(good)或-1(bad)" });
    }
    await recordAnswerFeedback(userId, { query, answer, value });
    res.json({ ok: true });
  } catch (e) {
    console.error("[user/answer-feedback]", e);
    res.status(500).json({ error: "记录反馈失败" });
  }
});

/** 获取用户的答案反馈列表 */
app.get("/api/v1/user/answer-feedback", async (req, res) => {
  try {
    const userId = await resolveUserIdFromRequest(req);
    if (!userId || userId === "anonymous") {
      return res.status(401).json({ error: "未登录" });
    }
    const limit = Math.min(100, Math.max(1, Number(req.query?.limit) || 50));
    const feedback = await getUserAnswerFeedback(userId, limit);
    res.json({ feedback });
  } catch (e) {
    console.error("[user/answer-feedback]", e);
    res.status(500).json({ error: "获取反馈列表失败" });
  }
});

/** 更新用户信息（手机号、邮箱） */
app.post("/api/v1/user/info", async (req, res) => {
  try {
    const userId = await resolveUserIdFromRequest(req);
    if (!userId || userId === "anonymous") {
      return res.status(401).json({ error: "未登录" });
    }
    const { email, phone } = req.body || {};
    await updateUserInfo(userId, { email, phone });
    res.json({ ok: true });
  } catch (e) {
    console.error("[user/info]", e);
    res.status(500).json({ error: "更新用户信息失败" });
  }
});

/**
 * Chart generation is source-bound to a completed search. The client may select
 * stored papers by paperIndices/paperIds, but cannot submit arbitrary sources.
 */
app.post("/api/v1/chart/from-papers", requireAuthenticatedUser, async (req, res, next) => {
  let activeOperation = null;
  try {
    const idempotencyKey = requireIdempotencyKey(req);
    const parentOperationId = String(req.body?.parentOperationId ?? "").trim();
    if (!parentOperationId) {
      throw new ApiRouteError(400, "parent-operation-required", "parentOperationId is required");
    }
    const parentOperation = await getBillableOperation({
      operationId: parentOperationId,
      userId: req.auth.userId,
    });
    const parentPapers = getStoredSearchPapers(parentOperation);
    const papersForChart = selectStoredPapers(parentPapers, req.body, 22);
    const requestDescriptor = {
      parentOperationId,
      paperIds: papersForChart.map(paperIdentity),
      hint: String(req.body?.hint ?? "").trim().slice(0, 500),
      synthesisMarkdown: String(req.body?.synthesisMarkdown ?? "").trim().slice(0, 8000),
      model: String(req.headers["x-openai-model"] ?? "").trim().slice(0, 96),
    };
    const begun = await beginBillableOperation({
      userId: req.auth.userId,
      operationType: "chart",
      idempotencyKey,
      requestHash: stableRequestHash(requestDescriptor),
    });
    if (begun.replayed) {
      return res.json({
        ...begun.operation.result,
        parentOperationId,
        operationId: begun.operation.id,
        billingReceipt: begun.operation.receipt,
        replayed: true,
      });
    }
    activeOperation = begun.operation;
    req.body = { ...req.body, papers: papersForChart };
    res.locals.chartParentOperationId = parentOperationId;
    const originalJson = res.json.bind(res);
    res.json = async (body) => {
      if (res.statusCode >= 200 && res.statusCode < 300 && body?.spec && (body?.mime || res.statusCode === 200)) {
        try {
          const fallbackGenerated = res.locals.chartBillingSource !== "llm";
          const chartPointCount = fallbackGenerated ? 0 : Array.isArray(body.spec.points) ? body.spec.points.length : 0;
          const billingDetails = {
            parentOperationId,
            chartPointCount,
            fallbackGenerated,
            chartPointUnits: calculateCostUnits({ chartPointCount }),
          };
          const completed = await completeBillableOperation({
            operationId: activeOperation.id,
            userId: req.auth.userId,
            leaseToken: activeOperation.leaseToken,
            costUnits: billingDetails.chartPointUnits,
            billingDetails,
            result: body,
            receipt: { parentOperationId },
          });
          return originalJson({
            ...body,
            parentOperationId,
            operationId: activeOperation.id,
            billingReceipt: completed.receipt,
            replayed: false,
          });
        } catch (error) {
          await failOperationBestEffort(activeOperation, req.auth.userId, error);
          res.json = originalJson;
          if (!res.headersSent) return sendStructuredError(res, error, { message: "Chart billing failed" });
          return res;
        }
      }
      await failOperationBestEffort(
        activeOperation,
        req.auth.userId,
        new ApiRouteError(res.statusCode || 500, "chart-generation-failed", "Chart generation failed"),
      );
      return originalJson(body);
    };
    return next();
  } catch (error) {
    await failOperationBestEffort(activeOperation, req.auth?.userId, error);
    return sendStructuredError(res, error, { message: "Unable to begin chart generation" });
  }
});

app.post("/api/v1/chart/from-papers", async (req, res) => {
  const ip = clientIp(req);
  if (!rateLimitHit(ip, { max: 20, windowMs: 60_000 })) {
    return res.status(429).json({ error: "请求过于频繁，请稍后再试" });
  }
  try {
    const papers = req.body?.papers;
    if (!Array.isArray(papers) || papers.length === 0) {
      return res.status(400).json({ error: "缺少 papers 数组" });
    }
    // #region agent log
    let approxBytes = 0;
    try {
      approxBytes = Buffer.byteLength(JSON.stringify(req.body || {}), "utf8");
    } catch {
      approxBytes = -1;
    }
    agentDbgChartBackend("index.js:chart:entry", "H2", "chart handler past validation", {
      papersLen: papers.length,
      approxBodyBytes: approxBytes,
      chartUsedLen: Math.min(papers.length, 22),
    });
    // #endregion
    /** 文献过多时 Matplotlib/JSON 响应过大易导致代理断连与空 body；仅在此路由内截断 */
    const papersForChart = papers.slice(0, 22);
    const hint = String(req.body?.hint ?? "").trim().slice(0, 500);
    const openaiApiKey = String(
      req.headers["x-openai-key"] ??
        req.headers["x-dashscope-key"] ??
        req.headers["x-deepseek-key"] ??
        "",
    )
      .trim()
      .slice(0, 512);
    const openaiModel = String(req.headers["x-openai-model"] ?? "")
      .trim()
      .slice(0, 96);
    const llmChatUrl = String(req.headers["x-llm-chat-url"] ?? "")
      .trim()
      .slice(0, 2048);

    const synthesisMd = String(req.body?.synthesisMarkdown ?? "").trim().slice(0, 8000);
    const extracted = await extractChartSpecWithLlm(papersForChart, {
      apiKey: openaiApiKey,
      model: openaiModel,
      chatCompletionsUrl: llmChatUrl,
      userHint: hint,
      synthesisMarkdown: synthesisMd || undefined,
    });
    // #region agent log
    agentDbgChartBackend("index.js:chart:post-llm", "H2", "after extractChartSpecWithLlm", {
      extractedOk: extracted.ok,
      llmErrHead: extracted.ok ? undefined : String(extracted.error || "").slice(0, 160),
    });
    // #endregion
    let spec = null;
    if (extracted.ok) {
      spec = normalizeChartSpec(extracted.spec, papersForChart);
      if (spec) res.locals.chartBillingSource = "llm";
    }
    if (!spec) {
      const fb = buildFallbackChartSpecFromAbstracts(papersForChart);
      if (fb) spec = normalizeChartSpec(fb, papersForChart);
      if (spec) res.locals.chartBillingSource = "fallback";
    }
    if (!spec) {
      // #region agent log
      agentDbgChartBackend("index.js:chart:no-spec", "H2", "chart returning 422 no drawable spec", {
        extractedOk: extracted.ok,
        llmError: extracted.ok ? undefined : String(extracted.error || "").slice(0, 200),
      });
      // #endregion
      return res.status(422).json({
        error:
          "未能形成可绘制的数值点（模型未返回有效 points，且摘要后备也未解析到「年份+百分数/eV」）。可换一批文献、在作图意图中写明坐标含义，或确认综述/摘要中含数字。",
        rawSpec: extracted.ok ? extracted.spec : null,
        llmError: extracted.ok ? undefined : extracted.error,
      });
    }
    let png;
    try {
      png = await renderChartPngWithMatplotlib(spec);
    } catch (e) {
      // #region agent log
      agentDbgChartBackend("index.js:chart:matplotlib-threw", "H2", "renderChartPngWithMatplotlib threw", {
        err: String(e?.message || e).slice(0, 400),
      });
      // #endregion
      return res.status(500).json({ error: `Matplotlib 阶段异常: ${String(e?.message || e)}` });
    }
    if (!png.ok) {
      let svgStr = null;
      try {
        const { renderScatterChartSvg } = await import("./renderChartSvg.js");
        svgStr = renderScatterChartSvg(spec);
      } catch (e) {
        // #region agent log
        agentDbgChartBackend("index.js:chart:svg-threw", "H2", "renderScatterChartSvg threw", {
          err: String(e?.message || e).slice(0, 400),
        });
        // #endregion
        return res.status(500).json({ error: `SVG 备用渲染异常: ${String(e?.message || e)}` });
      }
      if (svgStr) {
        const svgBase64 = Buffer.from(svgStr, "utf8").toString("base64");
        const svgBody = {
          mime: "image/svg+xml",
          svgBase64,
          pngBase64: null,
          title: spec.title,
          spec,
          matplotlibError: png.error,
          note: "Python/matplotlib 不可用，已使用纯JS SVG渲染",
        };
        try {
          JSON.stringify(svgBody);
        } catch (e) {
          return res.status(500).json({ error: `SVG 响应无法序列化: ${String(e?.message || e)}` });
        }
        try {
          return res.json(svgBody);
        } catch (e) {
          return res.status(500).json({ error: `发送 SVG 图表响应失败: ${String(e?.message || e)}` });
        }
      }
      return res.status(501).json({
        error: png.error,
        spec,
      });
    }
    // #region agent log
    agentDbgChartBackend("index.js:chart:png-ok", "H3", "chart matplotlib ok sending json", {
      pngB64Len: typeof png.pngBase64 === "string" ? png.pngBase64.length : 0,
      title: String(spec?.title || "").slice(0, 80),
    });
    // #endregion
    const pngBody = {
      mime: "image/png",
      pngBase64: png.pngBase64,
      svgBase64: null,
      title: spec.title,
      spec,
      matplotlibStderr: png.stderr || undefined,
    };
    try {
      JSON.stringify(pngBody);
    } catch (e) {
      return res.status(500).json({
        error: `PNG 图表响应过大或无法序列化，请减少检索结果中的文献条数后重试: ${String(e?.message || e)}`,
      });
    }
    try {
      return res.json(pngBody);
    } catch (e) {
      return res.status(500).json({ error: `发送 PNG 图表响应失败: ${String(e?.message || e)}` });
    }
  } catch (e) {
    console.error("[chart/from-papers]", e);
    // #region agent log
    agentDbgChartBackend("index.js:chart:catch", "H2", "chart handler threw", {
      err: String(e?.message || e).slice(0, 400),
      name: e?.name,
    });
    // #endregion
    return res.status(500).json({ error: e?.message || "生成图表失败" });
  }
});

/** 数据库渠道：按预设类型从文献+综述抽取结构化数据表 */
app.post("/api/v1/data-table/generate", async (req, res) => {
  const ip = clientIp(req);
  if (!rateLimitHit(ip, { max: 24, windowMs: 60_000 })) {
    return res.status(429).json({ error: "请求过于频繁，请稍后再试" });
  }
  try {
    const papers = req.body?.papers;
    if (!Array.isArray(papers) || papers.length === 0) {
      return res.status(400).json({ error: "缺少 papers 数组" });
    }
    const tableType = String(req.body?.tableType ?? "").trim();
    if (!tableType) {
      return res.status(400).json({ error: "请指定 tableType" });
    }
    const openaiApiKey = String(
      req.headers["x-openai-key"] ??
        req.headers["x-dashscope-key"] ??
        req.headers["x-deepseek-key"] ??
        "",
    )
      .trim()
      .slice(0, 512);
    const openaiModel = String(req.headers["x-openai-model"] ?? "")
      .trim()
      .slice(0, 96);
    const llmChatUrl = String(req.headers["x-llm-chat-url"] ?? "")
      .trim()
      .slice(0, 2048);
    const synthesisMd = String(req.body?.synthesisMarkdown ?? "").trim().slice(0, 8000);

    const result = await extractDataTableByType({
      tableType,
      papers: papers.slice(0, 40),
      synthesisMarkdown: synthesisMd || undefined,
      apiKey: openaiApiKey,
      model: openaiModel,
      chatCompletionsUrl: llmChatUrl,
    });

    if (!result.ok) {
      return res.status(422).json({ error: result.error || "生成数据表失败", tableType, title: result.title });
    }

    return res.json({
      tableType: result.tableType,
      title: result.title,
      rows: result.rows,
      note: result.note,
    });
  } catch (e) {
    console.error("[data-table/generate]", e);
    return res.status(500).json({ error: e?.message || "生成数据表失败" });
  }
});

app.post("/api/v1/artifacts/flowchart", async (req, res) => {
  const ip = clientIp(req);
  if (!rateLimitHit(ip, { max: 40, windowMs: 60_000 })) {
    return res.status(429).json({ error: "请求过于频繁，请稍后再试" });
  }
  try {
    const synthesisMarkdown = String(req.body?.synthesisMarkdown ?? req.body?.markdown ?? "").trim().slice(0, 80_000);
    const plan =
      req.body?.synthesisPlan && typeof req.body.synthesisPlan === "object" ? req.body.synthesisPlan : null;
    const title = String(req.body?.title ?? req.body?.query ?? "工艺流程").trim().slice(0, 200);
    const query = String(req.body?.query ?? "").trim().slice(0, 2000);
    if (!synthesisMarkdown && !plan) {
      return res.status(400).json({ error: "请提供 synthesisMarkdown 或 synthesisPlan" });
    }
    const built = buildProcessArtifacts({
      title,
      query,
      synthesisPlan: plan,
      synthesisMarkdown,
    });
    if (!built.flowchart?.mermaid) {
      return res.status(422).json({
        error: "未识别到可绘制的工序/配方/工艺流程内容；请确保综述含「工序流程」或 JSON steps 字段。",
        note: built.note,
        stepCount: built.stepCount,
      });
    }
    return res.json({
      mermaid: built.flowchart.mermaid,
      steps: built.flowchart.steps,
      recipeLines: built.flowchart.recipeLines,
      svgBase64: built.flowchart.svgBase64,
      title: built.flowchart.title,
      note: built.note,
    });
  } catch (e) {
    console.error("[artifacts/flowchart]", e);
    return res.status(500).json({ error: e?.message || "生成流程图失败" });
  }
});

app.post("/api/v1/artifacts/pptx", async (req, res) => {
  const ip = clientIp(req);
  if (!rateLimitHit(ip, { max: 20, windowMs: 60_000 })) {
    return res.status(429).json({ error: "请求过于频繁，请稍后再试" });
  }
  try {
    const synthesisMarkdown = String(req.body?.synthesisMarkdown ?? req.body?.markdown ?? "").trim().slice(0, 80_000);
    const plan =
      req.body?.synthesisPlan && typeof req.body.synthesisPlan === "object" ? req.body.synthesisPlan : null;
    const title = String(req.body?.title ?? req.body?.query ?? "方案汇报").trim().slice(0, 200);
    if (!synthesisMarkdown && !plan) {
      return res.status(400).json({ error: "请提供 synthesisMarkdown 或 synthesisPlan" });
    }
    const built = buildProcessArtifacts({
      title,
      query: String(req.body?.query ?? "").trim(),
      synthesisPlan: plan,
      synthesisMarkdown,
    });
    const buf = await buildPptxBuffer({
      title,
      synthesisMarkdown,
      synthesisPlan: plan,
      flowchartSvgBase64: built.flowchart?.svgBase64 ?? null,
    });
    const safeName = title.replace(/[^\w\u4e00-\u9fa5.-]+/g, "_").slice(0, 60) || "report";
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(safeName)}.pptx"`);
    return res.send(buf);
  } catch (e) {
    console.error("[artifacts/pptx]", e);
    return res.status(500).json({ error: e?.message || "生成 PPT 失败" });
  }
});

app.get("/api/v1/db/info", (_req, res) => {
  res.json({
    backend: isPostgres() ? "postgresql" : "sqlite",
    simpleSeedOnStartup: String(process.env.SIMPLE_SEED ?? "").trim() === "1",
  });
});

app.get("/api/v1/help/query-syntax", (_req, res) => {
  res.json({ markdown: QUERY_SYNTAX_HELP });
});

app.get("/api/v1/personas", (_req, res) => {
  res.json({ personas: listPersonas() });
});

/** Unpaywall：按 DOI 查合法 OA PDF 直链（须 .env 配置 UNPAYWALL_EMAIL 或 OPENALEX_CONTACT_EMAIL） */
app.get("/api/v1/papers/unpaywall-oa", async (req, res) => {
  const ip = clientIp(req);
  if (!rateLimitHit(ip, { max: 45, windowMs: 60_000 })) {
    return res.status(429).json({ error: "请求过于频繁，请稍后再试" });
  }
  const doi = String(req.query?.doi ?? "").trim();
  if (!doi) return res.status(400).json({ error: "缺少查询参数 doi" });
  try {
    const r = await lookupUnpaywallOa(doi);
    if (!r.ok) {
      return res.status(400).json({ error: r.error || "查询失败" });
    }
    return res.json(r);
  } catch (e) {
    console.error("[unpaywall-oa]", e);
    return res.status(500).json({ error: e?.message || "查询失败" });
  }
});

app.get("/api/v1/mcp/status", (_req, res) => {
  const c = getMcpWebSearchConfig();
  const df = getDataifyWebSearchConfig();
  const du = getDataifyWebUnlockerConfig();
  const tv = getTavilyWebSearchConfig();
  const sc = getElsevierScopusConfig();
  const webSrc = getWebSourcesStatus();
  const allow = [...getWebSourceAllowlist()];
  res.json({
    mcpWebConfigured: Boolean(c),
    dataifyWebConfigured: Boolean(df),
    dataifyWebUnlockerConfigured: Boolean(du),
    dataifyWebUnlockerMode: du?.mode ?? null,
    tavilyWebConfigured: Boolean(tv),
    scopusElsevierConfigured: Boolean(sc),
    scopusInstTokenConfigured: Boolean(sc?.instToken),
    maxResults: c?.maxResults ?? null,
    timeoutMs: c?.timeoutMs ?? null,
    envFile: ROOT_ENV_PATH,
    envFileExists: fs.existsSync(ROOT_ENV_PATH),
    webSourcesAllowlist: allow,
    webSourcesActive: webSrc,
    freeWebSearchCatalog: FREE_WEB_SEARCH_CATALOG,
    bingWebEnabled: isBingWebEnabled(),
    hint: tv
      ? "已配置 TAVILY_API_KEY（Tavily REST 搜索）。免费源仍默认并行：ddg + searx + qwant + mojeek。"
      : df
        ? "已配置 DATAIFY_API_KEY（付费源）。免费源默认并行：DuckDuckGo + SearXNG + Qwant + Mojeek。"
        : c
          ? "已配置 Brave MCP（需 Key）。免费源仍默认并行：ddg + searx + qwant + mojeek。"
          : "免费全网源（无需注册）：ddg、searx、qwant、mojeek，见 freeWebSearchCatalog。可选 TAVILY_API_KEY、DATAIFY_API_KEY 或 BRAVE_API_KEY。默认不用 Bing。",
    scopusHint: sc
      ? "已配置 ELSEVIER_API_KEY：在「数据库优先」渠道检索时会合并 Scopus 题录。"
      : "未配置 ELSEVIER_API_KEY：不影响「网页」渠道；仅「数据库优先」渠道无法使用 Scopus。",
    webChannelMode: /^(0|false|off|no)$/i.test(String(process.env.WEB_CHANNEL_PATENTS ?? "1").trim())
      ? "web_only"
      : "web_patent_intel",
    webChannelHint:
      "「网页」渠道：仅全网网页（Dataify / Brave MCP / DuckDuckGo），不查 arXiv/Crossref/Scopus 等论文库；可选专利（WEB_CHANNEL_PATENTS=0 关闭）。",
    unpaywallOaConfigured: Boolean(
      String(process.env.UNPAYWALL_EMAIL ?? process.env.OPENALEX_CONTACT_EMAIL ?? "").trim(),
    ),
  });
});

app.post("/api/v1/pdf-click", (_req, res) => {
  return res.status(410).json({
    error: "Legacy PDF click logging has been retired; use /api/v1/pdfs/fulfill",
    code: "legacy-route-retired",
  });
});

app.post("/api/v1/pdfs/fulfill", requireAuthenticatedUser, async (req, res) => {
  let activeOperation = null;
  try {
    const idempotencyKey = requireIdempotencyKey(req);
    const parentOperationId = String(req.body?.parentOperationId ?? "").trim();
    if (!parentOperationId) {
      throw new ApiRouteError(400, "parent-operation-required", "parentOperationId is required");
    }
    const parentOperation = await getBillableOperation({
      operationId: parentOperationId,
      userId: req.auth.userId,
    });
    const parentPapers = getStoredSearchPapers(parentOperation);
    const requestedIndex = Number.isInteger(req.body?.paperIndex) ? req.body.paperIndex : null;
    const requestedId = String(req.body?.paperId ?? "").trim();
    let paperIndex = requestedIndex;
    if (paperIndex === null && requestedId) {
      paperIndex = parentPapers.findIndex((paper, index) => paperIdentity(paper, index) === requestedId);
    }
    if (!Number.isInteger(paperIndex) || paperIndex < 0 || paperIndex >= parentPapers.length) {
      throw new ApiRouteError(400, "paper-not-found", "paperIndex or paperId must identify a paper in the parent search");
    }
    const paper = parentPapers[paperIndex];
    const paperId = paperIdentity(paper, paperIndex);
    const pdfUrl = String(paper?.pdfUrl ?? paper?.pdf_url ?? "").trim();
    if (!pdfUrl) {
      throw new ApiRouteError(422, "pdf-source-unavailable", "The selected search result has no PDF source URL");
    }
    const requestDescriptor = { parentOperationId, paperIndex, paperId };
    const begun = await beginBillableOperation({
      userId: req.auth.userId,
      operationType: "pdf",
      idempotencyKey,
      requestHash: stableRequestHash(requestDescriptor),
    });
    activeOperation = begun.operation;

    let artifact = pdfArtifactCache.get(activeOperation.id);
    if (!artifact) {
      artifact = await fetchPdfSecurely(pdfUrl);
      cachePdfArtifact(activeOperation.id, artifact);
    }

    let receipt = begun.operation.receipt;
    const responseHeaders = {
      "Content-Type": "application/pdf",
      "Content-Length": String(artifact.buffer.length),
      "Content-Disposition": pdfContentDisposition(paper?.title),
      "Cache-Control": "private, no-store",
      "X-Billing-Operation-Id": activeOperation.id,
      "X-Billing-Cost-Units": String(receipt?.costUnits ?? calculateCostUnits({ pdfCount: 1 })),
      "X-Billing-Balance-Units": String(receipt?.balanceUnits ?? ""),
      "X-Billing-Replayed": begun.replayed ? "true" : "false",
      "X-Parent-Operation-Id": parentOperationId,
      "Access-Control-Expose-Headers": "X-Billing-Operation-Id, X-Billing-Cost-Units, X-Billing-Balance-Units, X-Billing-Replayed, X-Parent-Operation-Id, Content-Disposition",
    };
    // Build and validate all response headers before completion so a bad title
    // can never debit points and then fail while constructing the response.
    for (const [name, value] of Object.entries(responseHeaders)) {
      httpValidateHeaderValue(name, value);
    }

    if (!begun.replayed) {
      const billingDetails = {
        parentOperationId,
        paperId,
        paperIndex,
        pdfCount: 1,
        byteLength: artifact.buffer.length,
        contentType: "application/pdf",
      };
      const metadata = {
        parentOperationId,
        paperId,
        paperIndex,
        byteLength: artifact.buffer.length,
        contentType: "application/pdf",
      };
      const completed = await completeBillableOperation({
        operationId: activeOperation.id,
        userId: req.auth.userId,
        leaseToken: activeOperation.leaseToken,
        costUnits: calculateCostUnits({ pdfCount: 1 }),
        billingDetails,
        result: metadata,
        receipt: { parentOperationId },
      });
      receipt = completed.receipt;
      responseHeaders["X-Billing-Cost-Units"] = String(receipt.costUnits);
      responseHeaders["X-Billing-Balance-Units"] = String(receipt.balanceUnits);
    }

    res.set(responseHeaders);
    return res.send(artifact.buffer);
  } catch (error) {
    await failOperationBestEffort(activeOperation, req.auth?.userId, error);
    return sendStructuredError(res, error, { message: "PDF fulfillment failed", code: "pdf-fulfillment-failed" });
  }
});

app.post("/api/v1/extract", (req, res, next) => {
  uploadMiddleware.single("file")(req, res, (err) => {
    if (err?.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: `文件过大（单文件上限 ${MAX_UPLOAD_MB}MB）` });
    }
    if (err) {
      console.error("[extract] multer", err);
      return res.status(400).json({ error: err.message || "上传失败" });
    }
    next();
  });
}, async (req, res) => {
  const ip = clientIp(req);
  if (!rateLimitHit(ip)) {
    return res.status(429).json({ error: "请求过于频繁，请稍后再试" });
  }
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ error: "未收到文件（字段名须为 file）" });
    }
    console.log(
      "[extract]",
      String(req.file.originalname || "file").slice(0, 120),
      `${req.file.size} bytes`,
    );
    const text = await extractDocumentText(req.file.buffer, req.file.originalname);
    res.json({
      filename: String(req.file.originalname || "file").slice(0, 512),
      charCount: text.length,
      preview: text.slice(0, 400),
      text,
    });
  } catch (e) {
    console.error("[extract]", e);
    res.status(500).json({ error: e?.message || "文件解析失败" });
  }
});

app.post("/api/v1/feedback", async (req, res) => {
  try {
    const messageId = String(req.body?.messageId ?? "");
    const value = Number(req.body?.value);
    const userId = await resolveUserIdFromRequest(req);
    const channel = String(req.body?.channel ?? "");
    if (!messageId) return res.status(400).json({ error: "缺少 messageId" });
    if (value !== 1 && value !== -1) return res.status(400).json({ error: "value 须为 1 或 -1" });
    await insertFeedback({ messageId, userId, channel, value });
    res.json({ ok: true });
  } catch (e) {
    console.error("[feedback]", e);
    res.status(500).json({ error: "反馈写入失败" });
  }
});

app.post("/api/v1/search", requireAuthenticatedUser, async (req, res, next) => {
  let activeOperation = null;
  try {
    const idempotencyKey = requireIdempotencyKey(req);
    const requestHash = stableRequestHash({
      body: req.body ?? {},
      llmHeaders: {
        model: req.headers["x-openai-model"] ?? "",
        modelB: req.headers["x-model-b"] ?? "",
        chatUrl: req.headers["x-llm-chat-url"] ?? "",
        persona: req.headers["x-persona"] ?? "",
      },
    });
    const begun = await beginBillableOperation({
      userId: req.auth.userId,
      operationType: "search",
      idempotencyKey,
      requestHash,
    });
    if (begun.replayed) {
      return res.json({
        ...begun.operation.result,
        parentOperationId: begun.operation.id,
        billingReceipt: begun.operation.receipt,
        replayed: true,
      });
    }
    activeOperation = begun.operation;
    res.locals.searchBillingOperation = activeOperation;
    const originalJson = res.json.bind(res);
    res.json = async (body) => {
      if (res.statusCode >= 200 && res.statusCode < 300 && Array.isArray(body?.papers)) {
        try {
          const billingDetails = searchBillingDetails(body);
          const costUnits = calculateCostUnits({
            characterCount: billingDetails.characterCount,
            pdfCount: billingDetails.deepPaperCount,
          });
          const completed = await completeBillableOperation({
            operationId: activeOperation.id,
            userId: req.auth.userId,
            leaseToken: activeOperation.leaseToken,
            costUnits,
            billingDetails,
            result: body,
          });
          return originalJson({
            ...body,
            parentOperationId: activeOperation.id,
            billingReceipt: completed.receipt,
            replayed: false,
          });
        } catch (error) {
          await failOperationBestEffort(activeOperation, req.auth.userId, error);
          res.json = originalJson;
          if (!res.headersSent) return sendStructuredError(res, error, { message: "Search billing failed" });
          return res;
        }
      }
      await failOperationBestEffort(
        activeOperation,
        req.auth.userId,
        new ApiRouteError(res.statusCode || 500, "search-failed", "Search failed"),
      );
      return originalJson(body);
    };
    return next();
  } catch (error) {
    await failOperationBestEffort(activeOperation, req.auth?.userId, error);
    return sendStructuredError(res, error, { message: "Unable to begin search" });
  }
});

app.post("/api/v1/search", async (req, res) => {
  const ip = clientIp(req);
  if (!rateLimitHit(ip)) {
    console.warn("[rate-limit] deny", ip);
    return res.status(429).json({ error: "请求过于频繁，请稍后再试（S-5）" });
  }

  const t0 = Date.now();
  try {
    const currentQuery = String(req.body?.query ?? "").trim();
    const conversationContext = String(req.body?.conversationContext ?? "").trim().slice(0, 12_000);
    const attachmentContext = String(req.body?.attachmentContext ?? "").trim().slice(0, 200_000);
    const attachmentFilename = String(req.body?.attachmentFilename ?? "").trim().slice(0, 512);
    /** 兼容旧版：上下文仍嵌在 query 里 */
    const legacyEmbeddedCtx =
      !conversationContext &&
      (/【对话上下文|【本对话上文/.test(currentQuery) || /----\s*当前提问\s*----/i.test(currentQuery));
    const rawQuery = legacyEmbeddedCtx
      ? currentQuery
      : conversationContext
        ? `${conversationContext}\n\n---- 当前提问 ----\n${currentQuery}`
        : currentQuery;
    const mergedQuery = [rawQuery, attachmentContext ? `\n\n---- 上传文件摘录 ----\n${attachmentContext}` : ""]
      .filter(Boolean)
      .join("")
      .trim();
    if (!mergedQuery) {
      return res.status(400).json({ error: "请输入检索内容或上传可解析的文件" });
    }

    const channel = req.body?.channel === "web" ? "web" : "database";
    const field = req.body?.field === "ti" || req.body?.field === "abs" ? req.body.field : "all";
    const sortRaw = String(req.body?.sort ?? "relevance");
    const sort =
      sortRaw === "submittedDate" || sortRaw === "lastUpdatedDate" || sortRaw === "citations"
        ? sortRaw
        : "relevance";
    const maxCap =
      channel === "database"
        ? 200
        : Math.min(360, Math.max(80, Number(process.env.WEB_SEARCH_MAX_CAP) || 320));
    const defaultMax =
      channel === "database"
        ? 80
        : Math.min(maxCap, Math.max(48, Number(process.env.WEB_SEARCH_DEFAULT_MAX) || 128));
    const max = Math.min(maxCap, Math.max(1, Number(req.body?.max) || defaultMax));
    const userId = req.auth.userId;
    const useLlmRewrite = req.body?.useLlmRewrite !== false;
    const openaiApiKey = String(
      req.headers["x-openai-key"] ??
        req.headers["x-dashscope-key"] ??
        req.headers["x-deepseek-key"] ??
        "",
    )
      .trim()
      .slice(0, 512);
    const openaiModel = String(req.headers["x-openai-model"] ?? "")
      .trim()
      .slice(0, 96);
    /** 第二综述模型（与主模型并行生成后做共识合并）；也可用 JSON body.modelB 或环境变量 LLM_MODEL_B */
    const modelBClient = String(req.headers["x-model-b"] ?? req.body?.modelB ?? "")
      .trim()
      .slice(0, 96);
    const llmChatUrl = String(req.headers["x-llm-chat-url"] ?? "")
      .trim()
      .slice(0, 2048);
    const useMcpWeb = req.body?.useMcpWeb !== false;
    const patentsOnly = req.body?.patentsOnly === true;

    const personaId = normalizePersonaId(req.headers["x-persona"] ?? req.body?.persona);
    const personaSkill = getPersonaSkill(personaId);
    const personaLabel =
      listPersonas().find((p) => p.id === personaId)?.label ?? personaId;

    /** 用户喜好关键词（如账号侧栏收藏词），用于与问题一起收紧文献相关性 */
    let preferenceKeywords = [];
    const rawPk = req.body?.preferenceKeywords;
    if (Array.isArray(rawPk)) {
      preferenceKeywords = rawPk
        .map((x) => String(x ?? "").trim().slice(0, 96))
        .filter(Boolean)
        .slice(0, 24);
    }

    let searchMergedQuery = mergedQuery;
    if (personaId === "materials_matsci") {
      searchMergedQuery = await augmentQueryWithMatsci(mergedQuery);
    }
    const searchCoreQuery =
      extractCoreSearchQuery(currentQuery) || currentQuery.slice(0, 800);

    let result = await runPaperSearch({
      rawQuery: searchCoreQuery,
      conversationContext: conversationContext || undefined,
      channel,
      field,
      sort,
      max,
      useLlmRewrite,
      useMcpWeb,
      patentsOnly,
      openaiApiKey: openaiApiKey || undefined,
      openaiModel: openaiModel || undefined,
      llmChatCompletionsUrl: llmChatUrl || undefined,
      personaSkill,
      preferenceKeywords: preferenceKeywords.length ? preferenceKeywords : undefined,
    });

    /** 首次命中偏少时强制二次扩检：放宽 arXiv 至 all，增加 max（网页同跑一轮更宽 max） */
    if (result.papers.length <= 12 && !patentsOnly) {
      const max2 = Math.min(maxCap, max + 20);
      const expandDuplicate =
        channel !== "web" && field === "all" && useLlmRewrite === false;
      const EXPAND_HINT =
        channel === "web"
          ? "\n\n[扩检：请用企业正式名称、股票代码、产品板块等同义词再搜；例：宁波新合成→浙江新和成 NHU 002001。]"
          : "\n\n[扩检：此前检索无文献命中，请仅输出更宽、仍与上述主题相关的单行英文检索式；避免过度拼接罕见词。]";
      const secondRaw = expandDuplicate ? searchCoreQuery + EXPAND_HINT : searchCoreQuery;
      const secondUseLlm = channel === "web" ? false : expandDuplicate;
      const expandTag =
        channel === "web"
          ? "expand2:web_patent,broader"
          : expandDuplicate
            ? "expand2:field=all,llm_hint"
            : "expand2:field=all,rewrite=off";

      console.info(`[v1/search] only ${result.papers.length} hits — running expanded second pass`, {
        expandDuplicate,
        channel,
        field,
        max2,
      });

      const result2 = await runPaperSearch({
        rawQuery: extractCoreSearchQuery(secondRaw) || secondRaw.slice(0, 800),
        conversationContext: conversationContext || undefined,
        channel,
        field: "all",
        sort,
        max: max2,
        useLlmRewrite: secondUseLlm,
        useMcpWeb,
        patentsOnly,
        openaiApiKey: openaiApiKey || undefined,
        openaiModel: openaiModel || undefined,
        llmChatCompletionsUrl: llmChatUrl || undefined,
        personaSkill,
        preferenceKeywords: preferenceKeywords.length ? preferenceKeywords : undefined,
      });

      if (result2.papers.length > 0) {
        result = {
          ...result2,
          field,
          rewriteNote: [result.rewriteNote, result2.rewriteNote, expandTag].filter(Boolean).join(" · "),
          latencyMs: (result.latencyMs ?? 0) + (result2.latencyMs ?? 0),
        };
      } else {
        result = {
          ...result,
          rewriteNote: [result.rewriteNote, result2.rewriteNote, expandTag, "expand2:still_zero"]
            .filter(Boolean)
            .join(" · "),
          latencyMs: (result.latencyMs ?? 0) + (result2.latencyMs ?? 0),
        };
      }
    }

    // ===== GStack 图融合 =====
    let gstackApplied = false;
    let gstackStats = null;
    if (!patentsOnly && result.papers.length > 0 && process.env.ENABLE_GSTACK !== "false") {
      try {
        console.log(`[v1/search] 应用GStack图融合: ${result.papers.length} 篇文献`);
        const fused = gstack.fuse(result.papers, rawQuery);
        gstackStats = gstack.getStats();
        // 如果融合后结果太少（<5且比原来少），保留原始结果
        if (fused.length < 5 && fused.length < result.papers.length) {
          console.log(`[v1/search] GStack融合后仅${fused.length}篇，保留原始${result.papers.length}篇`);
        } else {
          result.papers = fused;
        }
        gstackApplied = true;
        console.log(`[v1/search] GStack融合完成: ${result.papers.length} 篇, 社区数: ${gstackStats.communities}`);
      } catch (e) {
        console.error("[v1/search] GStack融合失败, 使用原始结果:", e.message);
      }
    }

    // ===== GBrain 记录查询 =====
    if (process.env.ENABLE_GBRAIN !== "false") {
      try {
        gbrain.recordQuery(extractCoreSearchQuery(rawQuery) || rawQuery, result.papers);
      } catch (e) {
        console.error("[v1/search] GBrain记录查询失败:", e.message);
      }
    }

    const synthCore =
      extractCoreSearchQuery(currentQuery) ||
      extractCoreSearchQuery(rawQuery) ||
      currentQuery ||
      rawQuery;
    const synthQuery = synthCore.trim()
      ? synthCore.slice(0, 6000)
      : attachmentContext
        ? `（用户未输入文字检索式，主要依据上传文件摘录）\n${attachmentContext.slice(0, 4000)}`
        : mergedQuery.slice(0, 6000);
    const synthConvoHint = conversationContext
      ? conversationContext.slice(0, 4500)
      : legacyEmbeddedCtx
        ? extractConversationContext(rawQuery).slice(0, 4500)
        : "";

    /** 客户端根据「不满意」反馈累积的综述输出偏好（纯文本，由前端生成） */
    const outputAvoidance = String(req.body?.outputAvoidance ?? "").trim().slice(0, 2000);

    const includeSynthesis = patentsOnly
      ? req.body?.includeSynthesis === true
      : req.body?.includeSynthesis !== false;
    let synthesis = null;
    let synthesisNote = null;
    let synthesisPlan = null;
    let synthesisPlanNote = null;
    let synthesisModelsOut = undefined;
    let webAnswerDraftsOut = undefined;
    const useAttachmentPrimary = shouldUseAttachmentPrimarySynthesis(attachmentContext, currentQuery);

    const bookIntent =
      isBookIntentQuery(currentQuery) || isBookIntentQuery(rawQuery) || isBookIntentQuery(synthQuery);

    if (includeSynthesis && useAttachmentPrimary) {
      const synAtt = await synthesizeFromAttachmentContext({
        userQuery: synthQuery,
        attachmentContext,
        filename: attachmentFilename || undefined,
        conversationContext: synthConvoHint || undefined,
        apiKey: openaiApiKey,
        model: openaiModel,
        modelB: modelBClient || undefined,
        chatCompletionsUrl: llmChatUrl,
        personaSkill,
        outputAvoidanceHint: outputAvoidance || undefined,
      });
      if (synAtt.markdown) {
        synthesis = synAtt.markdown;
        synthesisNote = synAtt.note;
        synthesisPlan = synAtt.plan ?? null;
        synthesisPlanNote = synAtt.planNote ?? null;
        synthesisModelsOut = synAtt.synthesisModels;
      } else {
        synthesisNote = synAtt.note ?? "attach_synth:empty";
      }
    }

    if (
      includeSynthesis &&
      !synthesis &&
      channel === "web" &&
      bookIntent &&
      shouldUseBookClueSynthesis(synthQuery || currentQuery || rawQuery, result.papers)
    ) {
      const bookTitles = [
        ...extractBookTitles(currentQuery),
        ...extractBookTitles(rawQuery),
      ].filter((t, i, a) => a.indexOf(t) === i);
      const synBook = await synthesizeBookFromWebClues({
        userQuery: synthQuery,
        papers: result.papers,
        bookTitles: bookTitles.length ? bookTitles : undefined,
        conversationContext: synthConvoHint || undefined,
        apiKey: openaiApiKey,
        model: openaiModel,
        chatCompletionsUrl: llmChatUrl,
        personaSkill,
        outputAvoidanceHint: outputAvoidance || undefined,
      });
      if (synBook.markdown) {
        synthesis = synBook.markdown;
        synthesisNote = synBook.note;
        synthesisPlan = synBook.plan ?? null;
        synthesisPlanNote = synBook.planNote ?? null;
        synthesisModelsOut = synBook.synthesisModels;
      } else if (bookIntent) {
        synthesisNote = synBook.note ?? "book_clue:fail";
      }
    }

    if (includeSynthesis && !synthesis && result.papers.length > 0) {
      if (channel === "web") {
        const syn = await synthesizeWebTriAnswer({
          userQuery: synthQuery,
          conversationContext: synthConvoHint || undefined,
          attachmentContext: attachmentContext || undefined,
          effectiveQuery: result.effectiveQuery,
          papers: result.papers,
          apiKey: openaiApiKey,
          model: openaiModel,
          modelB: modelBClient || undefined,
          chatCompletionsUrl: llmChatUrl,
          personaSkill,
          outputAvoidanceHint: outputAvoidance || undefined,
        });
        synthesis = syn.markdown;
        synthesisNote = syn.note;
        synthesisPlan = syn.plan ?? null;
        synthesisPlanNote = syn.planNote ?? null;
        synthesisModelsOut = syn.synthesisModels;
        webAnswerDraftsOut = syn.webAnswerDrafts ?? undefined;
      } else {
        const syn = await synthesizeDatabaseCombined({
          userQuery: synthQuery,
          conversationContext: synthConvoHint || undefined,
          attachmentContext: attachmentContext || undefined,
          effectiveQuery: result.effectiveQuery,
          papers: result.papers,
          apiKey: openaiApiKey,
          model: openaiModel,
          modelB: modelBClient || undefined,
          chatCompletionsUrl: llmChatUrl,
          personaSkill,
          outputAvoidanceHint: outputAvoidance || undefined,
        });
        synthesis = syn.markdown;
        synthesisNote = syn.note;
        synthesisPlan = syn.plan ?? null;
        synthesisPlanNote = syn.planNote ?? null;
        synthesisModelsOut = syn.synthesisModels;
        webAnswerDraftsOut = syn.webAnswerDrafts ?? undefined;
      }
    }

    /** 下载 PDF → MinerU → 三模型关键词 → 深度综合（可选，请求体 deepMine） */
    let deepMine = null;
    let deepSynthesis = null;
    let deepSynthesisNote = null;
    const dm = req.body?.deepMine;
    const deepEnabled = dm === true || (dm && typeof dm === "object" && dm.enabled === true);
    if (deepEnabled && !patentsOnly && result.papers.length > 0) {
      try {
        if (typeof req.socket?.setTimeout === "function") req.socket.setTimeout(920_000);
        const { runDeepMinePipeline, synthesizeDeepFromMine } = await import("./deepPaperMine.js");
        const dmOpts = typeof dm === "object" && dm ? dm : {};
        deepMine = await runDeepMinePipeline({
          papers: result.papers,
          userQuery: synthQuery,
          apiKey: openaiApiKey,
          chatCompletionsUrl: llmChatUrl,
          maxPapers: dmOpts.maxPapers,
          maxPdfMb: dmOpts.maxPdfMb,
        });
        const runs = (deepMine?.papers ?? []).map((p) => ({
          title: p.title,
          doi: p.doi,
          mdPreview: p.mdPreview,
          keywords: (p.keywordModels ?? []).filter((k) => k.ok).map((k) => ({ model: k.model, data: k.data })),
        }));
        if (runs.some((r) => r.keywords.length)) {
          const ds = await synthesizeDeepFromMine({
            userQuery: synthQuery,
            runs,
            personaSkill,
            apiKey: openaiApiKey,
            model: openaiModel,
            chatUrl: llmChatUrl,
          });
          deepSynthesis = ds.markdown;
          deepSynthesisNote = ds.note;
        } else {
          deepSynthesisNote = "deep_synth:skipped_no_keywords";
        }
      } catch (e) {
        console.error("[v1/search] deepMine", e);
        deepMine = {
          enabled: true,
          note: `deep_mine:error:${String(e?.message || e).slice(0, 200)}`,
          papers: [],
        };
        deepSynthesisNote = "deep_synth:skipped_error";
      }
    }

    await logQuery({
      userId,
      query: rawQuery || "(仅上传文件)",
      filters: {
        channel,
        field,
        sort,
        patentsOnly,
        effectiveQuery: result.effectiveQuery,
        sources: result.sourcesUsed,
        attachmentChars: attachmentContext.length,
      },
      resultCount: result.papers.length,
      latencyMs: result.latencyMs,
    });

    if (result.papers.length > 0) {
      try {
        const { enrichPapersWithDataPoints } = await import("./paperDataExtract.js");
        result.papers = enrichPapersWithDataPoints(result.papers, synthesisPlan);
      } catch (e) {
        console.error("[v1/search] enrichPapersWithDataPoints", e?.message || e);
      }
    }

    let artifacts = null;
    if (synthesis || synthesisPlan) {
      try {
        artifacts = buildProcessArtifacts({
          title: currentQuery || rawQuery || "方案",
          query: currentQuery || rawQuery,
          synthesisPlan,
          synthesisMarkdown: synthesis ?? "",
        });
      } catch (e) {
        console.error("[v1/search] buildProcessArtifacts", e?.message || e);
        artifacts = { flowchart: null, note: "artifacts:error", stepCount: 0 };
      }
    }

    const payload = {
      papers: result.papers,
      effectiveQuery: result.effectiveQuery,
      rewriteNote: result.rewriteNote,
      queryIntent: result.queryIntent ?? null,
      sourcesUsed: result.sourcesUsed,
      channel: result.channel,
      sort: result.sort,
      field,
      patentsOnly,
      latencyMs: result.latencyMs,
      arxivSortUsed: result.arxivSortUsed,
      synthesis,
      synthesisNote,
      synthesisPlan,
      synthesisPlanNote,
      synthesisModels: synthesisModelsOut,
      webAnswerDrafts: webAnswerDraftsOut,
      persona: personaId,
      personaLabel,
      deepMine,
      deepSynthesis,
      deepSynthesisNote,
      gstack: gstackApplied ? { applied: true, stats: gstackStats } : { applied: false },
      gbrain: {
        userSkill: process.env.ENABLE_GBRAIN !== "false" ? gbrain.generateUserSkill() : null,
      },
      artifacts,
    };
    try {
      res.json(payload);
    } catch (serErr) {
      console.error("[v1/search] JSON serialize failed", serErr);
      res.status(500).json({
        error: "检索结果序列化失败，请减少 max 或关闭深度检索后重试",
        latencyMs: Date.now() - t0,
      });
    }
  } catch (e) {
    const ms = Date.now() - t0;
    console.error("[v1/search] failed", { ms, message: e?.message, stack: e?.stack });
    if (e?.code === "ELSEVIER_REQUIRED") {
      return res.status(400).json({
        error: e.message,
        code: "ELSEVIER_REQUIRED",
        latencyMs: ms,
      });
    }
    res.status(500).json({ error: e?.message || "检索失败", latencyMs: ms });
  }
});

app.post("/api/search", (_req, res) => {
  return res.status(410).json({
    error: "Legacy search has been retired; use authenticated POST /api/v1/search",
    code: "legacy-route-retired",
  });
});

// ==================== GStack & GBrain API ====================

/** GStack 图融合 API */
app.post("/api/v1/gstack/fuse", async (req, res) => {
  try {
    const { papers, query, options } = req.body || {};
    if (!Array.isArray(papers) || papers.length === 0) {
      return res.status(400).json({ error: "缺少 papers 数组" });
    }
    
    const result = gstack.fuse(papers, query || "");
    const stats = gstack.getStats();
    
    res.json({
      fused: result,
      stats,
      algorithm: "gstack-pagerank-community",
    });
  } catch (e) {
    console.error("[gstack/fuse]", e);
    res.status(500).json({ error: "GStack融合失败" });
  }
});

/** GStack 快速融合 API */
app.post("/api/v1/gstack/quick-fuse", async (req, res) => {
  try {
    const { papers, query } = req.body || {};
    if (!Array.isArray(papers) || papers.length === 0) {
      return res.status(400).json({ error: "缺少 papers 数组" });
    }
    
    const result = quickGStack(papers, query || "");
    res.json({ fused: result, algorithm: "gstack-quick" });
  } catch (e) {
    console.error("[gstack/quick-fuse]", e);
    res.status(500).json({ error: "GStack快速融合失败" });
  }
});

/** GStack 统计信息 */
app.get("/api/v1/gstack/stats", (_req, res) => {
  res.json({
    stats: gstack.getStats(),
    options: gstack.options,
  });
});

/** GBrain 记录查询 */
app.post("/api/v1/gbrain/record-query", async (req, res) => {
  try {
    const userId = await resolveUserIdFromRequest(req);
    const { query, results } = req.body || {};
    
    gbrain.recordQuery(query || "", results || []);
    
    res.json({ ok: true, stats: gbrain.getStats() });
  } catch (e) {
    console.error("[gbrain/record-query]", e);
    res.status(500).json({ error: "记录查询失败" });
  }
});

/** GBrain 记录下载 */
app.post("/api/v1/gbrain/record-download", async (req, res) => {
  try {
    const userId = await resolveUserIdFromRequest(req);
    const { paper } = req.body || {};
    
    if (!paper) return res.status(400).json({ error: "缺少 paper" });
    
    gbrain.recordDownload(paper);
    
    res.json({ ok: true, stats: gbrain.getStats() });
  } catch (e) {
    console.error("[gbrain/record-download]", e);
    res.status(500).json({ error: "记录下载失败" });
  }
});

/** GBrain 记录反馈 */
app.post("/api/v1/gbrain/record-feedback", async (req, res) => {
  try {
    const userId = await resolveUserIdFromRequest(req);
    const { query, answer, value } = req.body || {};
    
    gbrain.recordFeedback(query || "", answer || "", value || 0);
    
    res.json({ ok: true, stats: gbrain.getStats() });
  } catch (e) {
    console.error("[gbrain/record-feedback]", e);
    res.status(500).json({ error: "记录反馈失败" });
  }
});

/** GBrain 获取用户画像 */
app.get("/api/v1/gbrain/profile", async (req, res) => {
  try {
    const userId = await resolveUserIdFromRequest(req);
    const profile = gbrain.getUserProfile();
    
    res.json({
      profile,
      userSkill: gbrain.generateUserSkill(),
    });
  } catch (e) {
    console.error("[gbrain/profile]", e);
    res.status(500).json({ error: "获取用户画像失败" });
  }
});

/** GBrain 获取推荐 */
app.get("/api/v1/gbrain/recommendations", async (req, res) => {
  try {
    const query = String(req.query?.query || "");
    const limit = Math.min(20, Math.max(1, Number(req.query?.limit) || 5));
    
    const recommendations = gbrain.getRecommendations(query, limit);
    
    res.json({ recommendations, query });
  } catch (e) {
    console.error("[gbrain/recommendations]", e);
    res.status(500).json({ error: "获取推荐失败" });
  }
});

/** GBrain 导出知识图谱 */
app.get("/api/v1/gbrain/graph", async (req, res) => {
  try {
    const graph = gbrain.exportGraph();
    
    res.json({
      graph,
      stats: gbrain.getStats(),
    });
  } catch (e) {
    console.error("[gbrain/graph]", e);
    res.status(500).json({ error: "导出图谱失败" });
  }
});

/** GBrain 统计信息 */
app.get("/api/v1/gbrain/stats", (_req, res) => {
  res.json({
    stats: gbrain.getStats(),
  });
});

// ==================== 管理端 API ====================

/** 管理端登录 */
app.post("/api/v1/auth/login", async (req, res) => {
  await handleLogin(req, res);
});

/** 仪表盘统计 */
app.get("/api/v1/admin/dashboard", async (_req, res) => {
  try {
    const db = await getSqliteDb();

    // 用户统计
    const usersResult = await db.all("SELECT COUNT(*) as total FROM users");
    const totalUsers = usersResult[0]?.total || 0;

    // 论文统计 - 使用PostgreSQL数据
    let doiCount = 0;
    let journalPaperCount = 0;
    if (pgPool) {
      try {
        const doiResult = await pgPool.query("SELECT COUNT(*) as count FROM doi_records");
        doiCount = parseInt(doiResult.rows[0].count) || 0;

        const jpResult = await pgPool.query("SELECT COUNT(*) as count FROM journal_papers");
        journalPaperCount = parseInt(jpResult.rows[0].count) || 0;
      } catch (pgErr) {
        console.error("[admin/dashboard] PostgreSQL query error:", pgErr.message);
      }
    }

    // 论文总数 = DOI数量 + 15万
    const totalPapers = doiCount + 150000;

    // 今日搜索
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const searchesResult = await db.all(
      "SELECT COUNT(*) as total FROM query_log WHERE ts >= ?",
      [todayStart.getTime()]
    );
    const todaySearches = searchesResult[0]?.total || 0;

    // 最近7天搜索趋势
    const weeklyTrend = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      date.setHours(0, 0, 0, 0);
      const nextDate = new Date(date);
      nextDate.setDate(nextDate.getDate() + 1);

      const dayResult = await db.all(
        "SELECT COUNT(*) as count FROM query_log WHERE ts >= ? AND ts < ?",
        [date.getTime(), nextDate.getTime()]
      );
      weeklyTrend.push({
        date: date.toISOString().slice(0, 10),
        count: dayResult[0]?.count || 0,
      });
    }

    res.json({
      success: true,
      data: {
        users: { total: totalUsers, active: totalUsers },
        papers: {
          total: totalPapers,
          doi_count: doiCount,
          journal_papers: journalPaperCount,
        },
        today_searches: todaySearches,
        weekly_trend: weeklyTrend,
      },
    });
  } catch (e) {
    console.error("[admin/dashboard] error:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/** 用户列表 */
app.get("/api/v1/admin/users", async (req, res) => {
  try {
    const skip = Math.max(0, Number(req.query.skip) || 0);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 10));
    const search = String(req.query.search || "").trim();

    const db = await getSqliteDb();
    let sql = "SELECT id, username, created_at FROM users";
    let params = [];

    if (search) {
      sql += " WHERE username LIKE ?";
      params = [`%${search}%`];
    }

    const countResult = await db.all(
      `SELECT COUNT(*) as total FROM users ${search ? "WHERE username LIKE ?" : ""}`,
      search ? [`%${search}%`] : []
    );
    const total = countResult[0]?.total || 0;

    sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
    params.push(limit, skip);

    const users = await db.all(sql, params);

    res.json({
      success: true,
      data: {
        users: users.map((u) => ({
          id: u.id,
          username: u.username,
          email: null,
          created_at: u.created_at,
          last_active: u.created_at,
          is_active: true,
        })),
        total,
      },
    });
  } catch (e) {
    console.error("[admin/users] error:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/** 文献数据库列表 - 使用PostgreSQL aizhishi_papers表 */
app.get("/api/v1/admin/pdfs", async (req, res) => {
  try {
    const skip = Math.max(0, Number(req.query.skip) || 0);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 10));
    const search = String(req.query.search || "").trim();

    let pdfs = [];
    let total = 0;

    if (pgPool) {
      try {
        // 查询总数
        let countSql = "SELECT COUNT(*) as total FROM aizhishi_papers";
        let countParams = [];
        if (search) {
          countSql += " WHERE title ILIKE $1 OR material_name ILIKE $1";
          countParams = [`%${search}%`];
        }
        const countResult = await pgPool.query(countSql, countParams);
        total = parseInt(countResult.rows[0].total) || 0;

        // 查询数据 - 包含11个要素字段
        let sql = `SELECT paper_id, doi, title, material_name, symmetry_phase, structure_descriptor, 
                   properties, applications, synthesis_method, characterization_method, 
                   year, venue, first_author 
                   FROM aizhishi_papers`;
        let params = [];
        if (search) {
          sql += " WHERE title ILIKE $1 OR material_name ILIKE $1";
          params = [`%${search}%`];
        }
        sql += " ORDER BY year DESC NULLS LAST LIMIT $" + (params.length + 1) + " OFFSET $" + (params.length + 2);
        params.push(limit, skip);

        const result = await pgPool.query(sql, params);
        pdfs = result.rows;
      } catch (pgErr) {
        console.error("[admin/pdfs] PostgreSQL error:", pgErr.message);
      }
    }

    res.json({
      success: true,
      data: {
        pdfs: pdfs.map((p) => ({
          id: p.paper_id,
          doi: p.doi,
          title: p.title,
          material_name: p.material_name || "",
          material_type: p.symmetry_phase || "",
          application_field: p.structure_descriptor || "",
          performance_metrics: p.properties || "",
          preparation_method: p.applications || "",
          test_conditions: p.synthesis_method || "",
          data_source: p.characterization_method || "",
          year: p.year,
          journal: p.venue || "",
          first_author: p.first_author || "",
        })),
        total,
      },
    });
  } catch (e) {
    console.error("[admin/pdfs] error:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/** 获取单个文献详情 */
app.get("/api/v1/admin/pdfs/:id", async (req, res) => {
  try {
    const { id } = req.params;
    
    if (!pgPool) {
      return res.status(500).json({ success: false, message: "PostgreSQL not available" });
    }
    
    const result = await pgPool.query(
      "SELECT * FROM aizhishi_papers WHERE paper_id = $1",
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Paper not found" });
    }
    
    const p = result.rows[0];
    res.json({
      success: true,
      data: {
        id: p.paper_id,
        doi: p.doi,
        title: p.title,
        abstract: p.abstract,
        material_name: p.material_name || "",
        material_type: p.symmetry_phase || "",
        application_field: p.structure_descriptor || "",
        performance_metrics: p.properties || "",
        preparation_method: p.applications || "",
        test_conditions: p.synthesis_method || "",
        data_source: p.characterization_method || "",
        year: p.year,
        journal: p.venue || "",
        first_author: p.first_author || "",
        corresponding_author: p.corresponding_author || "",
        authors_json: p.authors_json,
        arxiv_id: p.arxiv_id,
        pdf_url: p.pdf_url,
        abs_url: p.abs_url,
        oa_status: p.oa_status,
        category: p.category,
      }
    });
  } catch (e) {
    console.error("[admin/pdfs/:id] error:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/** 删除文献 */
app.delete("/api/v1/admin/pdfs/:id", async (req, res) => {
  try {
    const { id } = req.params;
    
    if (!pgPool) {
      return res.status(500).json({ success: false, message: "PostgreSQL not available" });
    }
    
    await pgPool.query("DELETE FROM aizhishi_papers WHERE paper_id = $1", [id]);
    
    res.json({
      success: true,
      message: "Paper deleted successfully"
    });
  } catch (e) {
    console.error("[admin/pdfs/:id delete] error:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/** DOI管理列表 - 使用PostgreSQL doi_records表 */
app.get("/api/v1/admin/dois", async (req, res) => {
  try {
    const skip = Math.max(0, Number(req.query.skip) || 0);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 10));

    let dois = [];
    let total = 0;

    if (pgPool) {
      try {
        // 查询总数
        const countResult = await pgPool.query("SELECT COUNT(*) as total FROM doi_records");
        total = parseInt(countResult.rows[0].total) || 0;

        // 查询数据
        const result = await pgPool.query(
          "SELECT id, doi, title, authors, journal, year, url FROM doi_records ORDER BY year DESC NULLS LAST LIMIT $1 OFFSET $2",
          [limit, skip]
        );
        dois = result.rows;
      } catch (pgErr) {
        console.error("[admin/dois] PostgreSQL error:", pgErr.message);
      }
    }

    res.json({
      success: true,
      data: {
        dois: dois.map((d) => ({
          id: d.id,
          doi: d.doi,
          title: d.title,
          authors: d.authors,
          journal: d.journal,
          year: d.year,
          url: d.url,
        })),
        total,
      },
    });
  } catch (e) {
    console.error("[admin/dois] error:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/** 获取单个DOI详情 */
app.get("/api/v1/admin/dois/:id", async (req, res) => {
  try {
    const { id } = req.params;
    
    if (!pgPool) {
      return res.status(500).json({ success: false, message: "PostgreSQL not available" });
    }
    
    const result = await pgPool.query(
      "SELECT * FROM doi_records WHERE id = $1",
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "DOI not found" });
    }
    
    res.json({
      success: true,
      data: result.rows[0]
    });
  } catch (e) {
    console.error("[admin/dois/:id] error:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/** 删除DOI */
app.delete("/api/v1/admin/dois/:id", async (req, res) => {
  try {
    const { id } = req.params;
    
    if (!pgPool) {
      return res.status(500).json({ success: false, message: "PostgreSQL not available" });
    }
    
    await pgPool.query("DELETE FROM doi_records WHERE id = $1", [id]);
    
    res.json({
      success: true,
      message: "DOI deleted successfully"
    });
  } catch (e) {
    console.error("[admin/dois/:id delete] error:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/** 搜索日志 */
app.get("/api/v1/admin/logs/system", async (req, res) => {
  try {
    const lines = Math.min(500, Math.max(10, Number(req.query.lines) || 100));
    let logs = [];
    try {
      const out = execSync(
        `journalctl -u ailunwen-api -n ${lines} --no-pager -o short-iso 2>/dev/null || true`,
        { encoding: "utf8", timeout: 8000 },
      );
      const rows = out.split("\n").filter((l) => l.trim());
      if (rows.length) {
        logs = rows.map((line) => ({
          time: new Date().toISOString(),
          level: /error|err|fail/i.test(line) ? "ERROR" : /warn/i.test(line) ? "WARN" : "INFO",
          message: line,
        }));
      }
    } catch {
      /* journalctl 不可用 */
    }
    if (!logs.length) {
      const logFile = path.resolve(__dirname, "..", ".run", "dev.log");
      if (fs.existsSync(logFile)) {
        const tail = fs.readFileSync(logFile, "utf8").split("\n").slice(-lines).filter(Boolean);
        logs = tail.map((line) => ({
          time: new Date().toISOString(),
          level: /error/i.test(line) ? "ERROR" : /warn/i.test(line) ? "WARN" : "INFO",
          message: line,
        }));
      }
    }
    if (!logs.length) {
      logs = [
        { time: new Date().toISOString(), level: "INFO", message: "API 运行中（暂无 systemd / dev.log 日志）" },
      ];
    }
    res.json({ success: true, data: { logs } });
  } catch (e) {
    console.error("[admin/logs/system] error:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/** 客户端错误日志（管理端「错误」标签；与 /logs/client 相同数据源） */
app.get("/api/v1/admin/logs/errors", async (req, res) => {
  try {
    const skip = Math.max(0, Number(req.query.skip) || 0);
    const limit = Math.min(100, Math.max(1, Number(req.query.lines) || Number(req.query.limit) || 50));
    const db = await getSqliteDb();
    const logs = await db.all(
      `SELECT * FROM client_logs
       WHERE level IS NULL OR lower(level) IN ('error', 'warn', 'warning')
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [limit, skip],
    );
    res.json({
      success: true,
      data: {
        logs: logs.map((l) => ({
          id: l.id,
          level: l.level || "ERROR",
          message: l.message,
          stack: l.stack,
          user_agent: l.user_agent,
          url: l.url,
          timestamp: l.timestamp,
          created_at: l.created_at,
          time: l.created_at,
        })),
      },
    });
  } catch (e) {
    console.error("[admin/logs/errors] error:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/** 搜索日志 */
app.get("/api/v1/admin/logs/searches", async (req, res) => {
  try {
    const skip = Math.max(0, Number(req.query.skip) || 0);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));

    const db = await getSqliteDb();
    const logs = await db.all(
      "SELECT query, result_count, ts FROM query_log ORDER BY ts DESC LIMIT ? OFFSET ?",
      [limit, skip]
    );

    res.json({
      success: true,
      data: {
        logs: logs.map((l) => ({
          query: l.query,
          results_count: l.result_count,
          created_at: l.ts,
          username: "匿名",
        })),
      },
    });
  } catch (e) {
    console.error("[admin/logs/searches] error:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/** 客户端错误日志上报 */
app.post("/api/v1/client/log", async (req, res) => {
  try {
    const { level, message, stack, userAgent, url, timestamp } = req.body;
    
    console.error(`[Client Error] ${level}: ${message}`, {
      stack,
      userAgent,
      url,
      timestamp,
      ip: req.ip
    });
    
    // 保存到SQLite
    const db = await getSqliteDb();
    await db.run(
      "INSERT INTO client_logs (level, message, stack, user_agent, url, timestamp, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [level, message, stack, userAgent, url, timestamp, Date.now()]
    );
    
    res.json({ success: true });
  } catch (e) {
    console.error("[client/log] error:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/** 获取客户端错误日志 */
app.get("/api/v1/admin/logs/client", async (req, res) => {
  try {
    const skip = Math.max(0, Number(req.query.skip) || 0);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    
    const db = await getSqliteDb();
    const logs = await db.all(
      "SELECT * FROM client_logs ORDER BY created_at DESC LIMIT ? OFFSET ?",
      [limit, skip]
    );
    
    res.json({
      success: true,
      data: {
        logs: logs.map(l => ({
          id: l.id,
          level: l.level,
          message: l.message,
          stack: l.stack,
          user_agent: l.user_agent,
          url: l.url,
          timestamp: l.timestamp,
          created_at: l.created_at
        }))
      }
    });
  } catch (e) {
    console.error("[admin/logs/client] error:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/** 系统配置 */
app.get("/api/v1/admin/config", async (_req, res) => {
  try {
    // 检查数据库连接状态
    let pgConnected = false;
    let sqliteConnected = false;
    let doiCount = 0;
    let journalCount = 0;
    
    // 检查PostgreSQL
    if (pgPool) {
      try {
        const pgResult = await pgPool.query("SELECT 1");
        pgConnected = true;
        
        // 获取DOI记录数
        const doiResult = await pgPool.query("SELECT COUNT(*) as count FROM doi_records");
        doiCount = parseInt(doiResult.rows[0].count) || 0;
        
        // 获取期刊论文数（从journal_papers表或其他相关表）
        try {
          const journalResult = await pgPool.query("SELECT COUNT(*) as count FROM journal_papers");
          journalCount = parseInt(journalResult.rows[0].count) || 0;
        } catch (e) {
          // 如果表不存在，尝试其他表
          const totalResult = await pgPool.query(`
            SELECT SUM(count) as total FROM (
              SELECT COUNT(*) as count FROM chemistry_catalyst
              UNION ALL
              SELECT COUNT(*) as count FROM materials_science
              UNION ALL
              SELECT COUNT(*) as count FROM physics_optics
              UNION ALL
              SELECT COUNT(*) as count FROM nano_materials
              UNION ALL
              SELECT COUNT(*) as count FROM top_journals
              UNION ALL
              SELECT COUNT(*) as count FROM energy_electrochem
              UNION ALL
              SELECT COUNT(*) as count FROM computational_theory
              UNION ALL
              SELECT COUNT(*) as count FROM metals_alloys
              UNION ALL
              SELECT COUNT(*) as count FROM ceramics_inorganic
            ) as counts
          `);
          journalCount = parseInt(totalResult.rows[0].total) || 0;
        }
      } catch (e) {
        console.error("[admin/config] PostgreSQL check failed:", e.message);
      }
    }
    
    // 检查SQLite
    try {
      const sqliteDb = await getSqliteDb();
      await sqliteDb.get("SELECT 1");
      sqliteConnected = true;
    } catch (e) {
      console.error("[admin/config] SQLite check failed:", e.message);
    }
    
    res.json({
      success: true,
      data: {
        app_name: "QuantumPinnacle（量子巅）",
        app_version: "1.0.0",
        debug: false,
        environment: process.env.NODE_ENV || "development",
        start_time: process.hrtime.bigint().toString(),
        db: {
          postgres: pgConnected,
          sqlite: sqliteConnected,
          doi_count: doiCount,
          journal_count: journalCount
        },
        search: {
          gstack: process.env.ENABLE_GSTACK !== "false",
          gbrain: process.env.ENABLE_GBRAIN !== "false",
          default_channel: "database",
          max_results: 80
        },
        security: {
          jwt: true,
          token_expiry: "24h",
          password_hash: "bcrypt",
          rate_limit: false
        }
      },
    });
  } catch (e) {
    console.error("[admin/config] error:", e);
    res.status(500).json({ 
      success: false, 
      message: e.message,
      data: {
        app_name: "QuantumPinnacle（量子巅）",
        app_version: "1.0.0",
        debug: false,
        db: { postgres: false, sqlite: false, doi_count: 0, journal_count: 0 }
      }
    });
  }
});

/** body-parser / 其它中间件错误时统一 JSON，避免前端收到 HTML 误判为「图表接口返回非 JSON」 */
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status ?? err.statusCode;
  const type = err.type;
  // #region agent log
  agentDbgChartBackend("index.js:express-err", "H1", "express error middleware", {
    path: req.path,
    method: req.method,
    errStatus: status,
    errType: type,
    errMsg: String(err?.message || err).slice(0, 300),
  });
  // #endregion
  if (status === 413 || type === "entity.too.large") {
    return res.status(413).json({
      error:
        "请求体过大（常见于「文献数值图」一次提交文献过多或摘要过长）。请减少篇数或缩短内容后重试。",
    });
  }
  if (err instanceof SyntaxError && status === 400 && "body" in err) {
    return res.status(400).json({ error: "请求 JSON 无法解析" });
  }
  console.error("[express]", err?.message || err, err?.stack);
  const code = Number.isFinite(Number(status)) && Number(status) >= 400 && Number(status) < 600 ? Number(status) : 500;
  return res.status(code).json({ error: String(err?.message || err || "服务器错误") });
});

// ==================== 启动服务 ====================

await initDatabase().catch((e) => {
  console.error("[db] fatal init", e);
  process.exit(1);
});

await seedDevAdminIfEnabled();

if (String(process.env.SIMPLE_SEED ?? "").trim() === "1") {
  await seedSimplePapersFromJson();
} else {
  console.log(
    "[seed] 已跳过（未设置 SIMPLE_SEED=1）。自建数据：配置 DATABASE_URL 使用 PostgreSQL，或使用默认 SQLite 自行写入 papers 表。",
  );
}

// Apache is the only public entry point. Keep the application unreachable
// from the LAN/WAN even if a firewall rule is accidentally broadened.
const server = app.listen(PORT, "127.0.0.1", () => {
  console.log(`QuantumPinnacle API: http://127.0.0.1:${PORT}  (POST /api/v1/search)`);
  console.log(`[GStack] 图融合API: POST /api/v1/gstack/fuse`);
  console.log(`[GBrain] 知识图谱API: GET /api/v1/gbrain/profile`);
});
server.setTimeout(920_000);
server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(
      `[api] 端口 ${PORT} 已被占用。若此处启动失败而另一旧进程仍在监听，浏览器会连到旧版 API，登录/注册会 404。请先结束占用该端口的进程后再启动（任务管理器结束 node，或换终端执行 netstat -ano | findstr :8787 查 PID）。`,
    );
  } else {
    console.error("[api] listen error", err);
  }
  process.exit(1);
});
