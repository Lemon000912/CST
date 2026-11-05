const object = x => x && typeof x === "object" && !Array.isArray(x) ? x : {};
const stamp = x => Number(x?.updatedAt) || 0;
const operation = m => m?.meta?.parentOperationId || m?.meta?.billing?.operationId || "";
function quality(m) {
  const meta = object(m?.meta);
  if (meta.finalizedAt) return 4;
  if (meta.billing && meta.synthesis && !/^synth:(requesting|pending|streaming|interrupted|paused)/i.test(meta.synthesisNote || "")) return 3;
  return meta.synthesis || m?.content ? 1 : 0;
}

export function mergeChatSession(a, b) {
  if (!a) return b;
  if (!b) return a;
  const newer = stamp(b) >= stamp(a) ? b : a;
  const older = newer === a ? b : a;
  if (!Array.isArray(a.messages) && !Array.isArray(b.messages)) return newer;
  const messages = new Map();
  for (const m of [...(older.messages || []), ...(newer.messages || [])]) {
    if (!m?.id) continue;
    const prev = messages.get(m.id);
    if (!prev) { messages.set(m.id, m); continue; }
    const sameOperation = !operation(prev) || !operation(m) || operation(prev) === operation(m);
    const winner = m.role === 'user' && prev.role === 'user'
      ? (String(prev.content || '').length >= String(m.content || '').length ? prev : m)
      : sameOperation && quality(prev) > quality(m) ? prev : m;
    const loser = winner === prev ? m : prev;
    messages.set(m.id, { ...loser, ...winner, meta: { ...object(loser.meta), ...object(winner.meta) } });
  }
  const ordered = [...messages.values()].map((m, order) => ({ m, order }));
  ordered.sort((a, b) => {
    const x = Number(String(a.m.id).match(/^\d{10,13}/)?.[0]);
    const y = Number(String(b.m.id).match(/^\d{10,13}/)?.[0]);
    return x && y ? x - y || a.order - b.order : a.order - b.order;
  });
  return { ...older, ...newer, messages: ordered.map(x => x.m), updatedAt: Math.max(stamp(a), stamp(b)) };
}

export function mergeChatSessionLists(a, b) {
  const map = new Map();
  for (const session of [...(a || []), ...(b || [])]) if (session?.id) map.set(session.id, mergeChatSession(map.get(session.id), session));
  return [...map.values()].sort((x, y) => stamp(y) - stamp(x));
}
