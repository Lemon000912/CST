import crypto from "node:crypto";
import multer from "multer";
import { generateText } from "./llmClient.js";
import { resolveProviderSlot } from "./llmProviders.js";

export const STUDENT_CARD_MAX_BYTES = 12 * 1024 * 1024;
export const studentCardUploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: STUDENT_CARD_MAX_BYTES, files: 1 },
});
const ACCEPTED_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

function verificationError(message, code, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function stripJsonFence(value) {
  return String(value ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

export function parseStudentCardDecision(text) {
  const raw = stripJsonFence(text);
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const confidence = Number(value.confidence);
    return {
      isStudentCard: value.is_student_card === true || value.isStudentCard === true,
      confidence: Number.isFinite(confidence) ? confidence : 0,
      school: String(value.school ?? value.school_name ?? "").trim().slice(0, 200),
      name: String(value.name ?? "").trim().slice(0, 100),
      studentId: String(value.student_id ?? value.studentId ?? "").trim().slice(0, 100),
      reason: String(value.reason ?? "").trim().slice(0, 500),
    };
  } catch {
    return null;
  }
}

export function isStudentCardAccepted(decision) {
  return Boolean(
    decision?.isStudentCard === true &&
    Number(decision.confidence) >= 0.75 && Number(decision.confidence) <= 1 &&
    decision.school &&
    (decision.studentId || decision.name),
  );
}

function imageSignatureMatches(buffer, mime) {
  if (mime === "image/jpeg") return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mime === "image/png") return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  if (mime === "image/webp") return buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  if (mime === "image/gif") return buffer.length >= 6 && /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString("ascii"));
  return false;
}

function normalizeImage(file) {
  if (!file?.buffer?.length) throw verificationError("未收到学生证图片", "student-image-required", 400);
  if (file.buffer.length > STUDENT_CARD_MAX_BYTES) throw verificationError("图片过大，单张学生证图片上限 12MB", "student-image-too-large", 400);
  const mime = String(file.mimetype ?? "").toLowerCase();
  if (!ACCEPTED_MIME.has(mime)) throw verificationError("仅支持 JPG、PNG、WEBP 或 GIF 学生证图片", "student-image-type-invalid", 400);
  if (!imageSignatureMatches(file.buffer, mime)) throw verificationError("图片内容与文件格式不匹配，请重新选择原始照片", "student-image-content-invalid", 400);
  return { mime, base64: Buffer.from(file.buffer).toString("base64"), sha256: crypto.createHash("sha256").update(file.buffer).digest("hex") };
}

export async function recognizeStudentCard(file) {
  const image = normalizeImage(file);
  const provider = resolveProviderSlot("A");
  if (!provider) {
    throw verificationError("模型 A 尚未配置，暂时无法进行学生证认证", "student-verification-model-unavailable", 503);
  }
  const prompt = [
    "你是严格的学生证认证审核器。请识别这张图片是否为真实、清晰可读的高校学生证/校园卡。",
    "只有同时看到学生证版式或明确校园卡标识，且能读到学校名称以及姓名或学号时，才判定为 true。",
    "身份证、工作证、录取通知书、课程卡、截图、模糊或明显篡改图片都判定为 false。",
    "只输出 JSON，不要 Markdown：{\"is_student_card\":boolean,\"confidence\":0到1之间数字,\"school\":\"学校名\",\"name\":\"姓名（可脱敏）\",\"student_id\":\"学号（可脱敏）\",\"reason\":\"简短理由\"}",
  ].join("\n");
  const response = await generateText(provider, {
    maxTokens: 300,
    temperature: 0,
    timeoutMs: 90_000,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: `data:${image.mime};base64,${image.base64}` } },
      ],
    }],
  });
  if (!response.ok) {
    throw verificationError("模型 A 识别失败，请稍后重试", "student-verification-model-failed", 502);
  }
  const decision = parseStudentCardDecision(response.text);
  if (!decision) {
    throw verificationError("模型 A 返回结果无法解析，请重试", "student-verification-invalid-model-response", 502);
  }
  return { decision, accepted: isStudentCardAccepted(decision), model: response.responseModel || provider.model, sha256: image.sha256 };
}
