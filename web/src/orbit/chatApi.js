// The Chat tab's requests (server/lib/chat-routes.mjs). Every call carries the
// device cookie by itself (same origin, `credentials` defaults to same-origin), so
// nothing here holds a credential. A refusal's words become the error's message
// and its status its `status`: 401 means "not paired", which the hook turns into
// the pairing screen.
const JSON_HEADERS = { 'Content-Type': 'application/json' };

export class ChatError extends Error {
  constructor(status, message, body = null) { super(message); this.status = status; this.body = body; }
}

async function answer(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ChatError(res.status, body?.error ?? `HTTP ${res.status}`, body);
  return body;
}
const get = url => fetch(url, { cache: 'no-store' }).then(answer);
const post = (url, body) => fetch(url, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) }).then(answer);

// ---- pairing (§2.2) ----
export const pairStart = name => post('/api/pair/start', { name });
export const pairStatus = () => get('/api/pair/status');
export const pairApprove = code => post('/api/pair/approve', { code });

// ---- devices ----
export const listDevices = () => get('/api/devices');
export const revokeDevice = id => fetch(`/api/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(answer);

// ---- Shortcut keys (server/lib/shortcut-routes.mjs): the page makes the one-time
// code for a new key, lists the keys and revokes; the key itself goes only to the
// Shortcut that enters the code. A 404 means they are off. ----
export const listShortcutKeys = () => get('/api/shortcut/keys');
export const newShortcutCode = name => post('/api/shortcut/keys', { name });
export const revokeShortcutKey = id => fetch(`/api/shortcut/keys/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(answer);

// ---- the thread (§2.3) ----
export const chatStatus = () => get('/api/chat/status');
export const latestMessages = limit => get(`/api/chat/messages?limit=${limit}`);
export const messagesAfter = (seq, limit) => get(`/api/chat/messages?after=${seq}&limit=${limit}`);
export const messagesBefore = (id, limit) => get(`/api/chat/messages?before=${encodeURIComponent(id)}&limit=${limit}`);
export const sendMessage = ({ clientId, text, replyTo = null, attachmentIds = [] }) => post('/api/chat/messages', { clientId, text, replyTo, attachmentIds });
// `shown` is the sha256 of what the card showed (lib/orbit/chat.js, shownInput).
export const answerPermission = (requestId, behavior, shown) => post(`/api/chat/permission/${encodeURIComponent(requestId)}`, { behavior, shown });

// A photo's bytes, raw, with its type and name; the answer is `{id, name, type, bytes}`.
export const uploadAttachment = (blob, name) =>
  fetch(`/api/chat/attachments?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob }).then(answer);

export const attachmentUrl = id => `/api/chat/attachments/${encodeURIComponent(id)}`;

// The stream's address: EventSource sends Last-Event-ID on its own reconnects; a
// stream the page opens anew (after a sleep) says where to resume with `after`.
export const streamUrl = after => (Number.isInteger(after) && after > 0 ? `/api/chat/stream?after=${after}` : '/api/chat/stream');
