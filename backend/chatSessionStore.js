import { mergeChatSession } from "../shared/chatSessionMerge.js";
const args = (tx, pg, sqlite = pg) => tx.dialect === "postgres" ? pg : sqlite;
export async function lockChatOwner(tx, userId, edition, now) {
  await tx.run(args(tx,
    "INSERT INTO user_chat_sessions_by_edition(user_id,edition,sessions_json,updated_at,revision,schema_version) VALUES($1,$2,'[]',$3,0,3) ON CONFLICT(user_id,edition) DO NOTHING",
    "INSERT INTO user_chat_sessions_by_edition(user_id,edition,sessions_json,updated_at,revision,schema_version) VALUES(?,?,'[]',?,0,3) ON CONFLICT(user_id,edition) DO NOTHING"), [userId, edition, now]);
  return tx.get(args(tx,
    "SELECT * FROM user_chat_sessions_by_edition WHERE user_id=$1 AND edition=$2 FOR UPDATE",
    "SELECT * FROM user_chat_sessions_by_edition WHERE user_id=? AND edition=?"), [userId, edition]);
}
export async function chatDeletions(tx, userId, edition) {
  return (await tx.all(args(tx,"SELECT session_id FROM user_chat_session_deletions WHERE user_id=$1 AND edition=$2","SELECT session_id FROM user_chat_session_deletions WHERE user_id=? AND edition=?"), [userId, edition])).map(r => r.session_id);
}
export async function mergeChatItem(tx, userId, edition, session) {
  const deleted = await tx.get(args(tx,"SELECT session_id FROM user_chat_session_deletions WHERE user_id=$1 AND edition=$2 AND session_id=$3","SELECT session_id FROM user_chat_session_deletions WHERE user_id=? AND edition=? AND session_id=?"), [userId, edition, session.id]);
  if (deleted) return null;
  const row = await tx.get(args(tx,"SELECT session_json FROM user_chat_session_items WHERE user_id=$1 AND edition=$2 AND session_id=$3","SELECT session_json FROM user_chat_session_items WHERE user_id=? AND edition=? AND session_id=?"), [userId, edition, session.id]);
  let existing; try { existing = JSON.parse(row?.session_json || "null"); } catch { /* 历史损坏项可由新内容恢复。 */ }
  const merged = mergeChatSession(existing, session);
  const changed = JSON.stringify(merged) !== row?.session_json;
  if (changed) await tx.run(args(tx,
    "INSERT INTO user_chat_session_items(user_id,edition,session_id,session_json,updated_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,edition,session_id) DO UPDATE SET session_json=EXCLUDED.session_json,updated_at=EXCLUDED.updated_at",
    "INSERT INTO user_chat_session_items(user_id,edition,session_id,session_json,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id,edition,session_id) DO UPDATE SET session_json=excluded.session_json,updated_at=excluded.updated_at"), [userId, edition, merged.id, JSON.stringify(merged), Number(merged.updatedAt) || 0]);
  return {session:merged,changed};
}
export async function bumpChatRevision(tx, userId, edition, now) {
  await tx.run(args(tx,"UPDATE user_chat_sessions_by_edition SET revision=revision+1,updated_at=$1 WHERE user_id=$2 AND edition=$3","UPDATE user_chat_sessions_by_edition SET revision=revision+1,updated_at=? WHERE user_id=? AND edition=?"), [now,userId,edition]);
}
export function normalizeChatContext(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = {};
  for (const key of ["sessionId", "userMessageId", "assistantMessageId"]) {
    const value = String(raw[key] || "");
    if (!/^[\w:.-]{1,160}$/.test(value)) return null;
    out[key] = value;
  }
  return out;
}
// 与计费结果在同一个数据库事务内写入，关闭浏览器也不会失去终稿。
export async function persistSearchSession(tx, { userId, operationId, result, receipt, edition, now = Date.now(), completedAt = now, allowCreate = false }) {
  const question = String(result?.adminQa?.question || "");
  if (!question || (!result?.synthesis && !result?.papers?.length)) return null;
  edition = ["school","enterprise","finance"].includes(edition) ? edition : "school";
  await lockChatOwner(tx, userId, edition, now);
  let context = normalizeChatContext(result.chatSession);
  if (!context) {
    const rows = await tx.all(args(tx,"SELECT session_json FROM user_chat_session_items WHERE user_id=$1 AND edition=$2 AND session_json LIKE $3","SELECT session_json FROM user_chat_session_items WHERE user_id=? AND edition=? AND session_json LIKE ?"), [userId, edition, `%${operationId}%`]);
    for (const row of rows) {
      const session = JSON.parse(row.session_json);
      const index = session.messages?.findIndex(m => m.meta?.parentOperationId === operationId || m.meta?.billing?.operationId === operationId);
      if (index >= 0) { context = { sessionId: session.id, assistantMessageId: session.messages[index].id, userMessageId: session.messages[index-1]?.id || `${operationId}:user` }; break; }
    }
  }
  if(!context && !allowCreate)return null;
  context ||= { sessionId: `operation:${operationId}`, userMessageId: `${operationId}:user`, assistantMessageId: `${operationId}:assistant` };
  const existing = await tx.get(args(tx,"SELECT session_json FROM user_chat_session_items WHERE user_id=$1 AND edition=$2 AND session_id=$3","SELECT session_json FROM user_chat_session_items WHERE user_id=? AND edition=? AND session_id=?"), [userId, edition, context.sessionId]);
  let title = question.slice(0,28);try{title=JSON.parse(existing?.session_json || 'null')?.title || title;}catch{}
  const { adminQa, chatSession, papers, ...meta } = result;
  const session = { id: context.sessionId, title, updatedAt: completedAt, messages: [
    { id: context.userMessageId, role: "user", content: question },
    { id: context.assistantMessageId, role: "assistant", content: "", papers: papers || [], meta: { ...meta, parentOperationId: operationId, billing: receipt, synthesisNote: result.paused ? "synth:paused" : result.synthesisNote || "synth:completed", ...(!result.paused ? { finalizedAt: completedAt } : {}) } },
  ] };
  const saved = await mergeChatItem(tx, userId, edition, session);
  if (saved?.changed) await bumpChatRevision(tx, userId, edition, now);
  return saved?.session || null;
}
