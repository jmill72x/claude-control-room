// The two requests of an acknowledgement (server/lib/acks.mjs): POST /api/acks and
// DELETE /api/acks/<key>. Both answer the list of active acks; a refusal's words
// become the error's message.
const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function failure(res) {
  const body = await res.json().catch(() => ({}));
  return new Error(body?.error ?? `HTTP ${res.status}`);
}

export async function ack(body) {
  const res = await fetch('/api/acks', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
  if (!res.ok) throw await failure(res);
  return res.json();
}

export async function unack(key) {
  const res = await fetch(`/api/acks/${encodeURIComponent(key)}`, { method: 'DELETE' });
  if (!res.ok) throw await failure(res);
  return res.json();
}
