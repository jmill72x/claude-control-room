// The two requests of an acknowledgement (server/lib/acks.mjs): POST /api/acks and
// DELETE /api/acks/<key>. Both answer the list of active acks; a refusal's words
// become the error's message.
const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function failure(res) {
  const body = await res.json().catch(() => ({}));
  return new Error(body?.error ?? `HTTP ${res.status}`);
}

// A save with no answer in ACK_TIMEOUT_MS fails with words that say so, so the form
// never sits on "Saving…" (board e7427be1's scope add, 11-26: Jeff's Save "doesn't
// actually do anything", and the server never heard it).
export const ACK_TIMEOUT_MS = 15e3;
export async function ack(body, { fetchImpl = fetch, timeoutMs = ACK_TIMEOUT_MS } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl('/api/acks', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body), signal: ctl.signal });
  } catch (err) {
    throw new Error(ctl.signal.aborted ? `no answer from the server in ${Math.round(timeoutMs / 1000)} s` : `the request did not reach the server (${err?.message ?? err})`);
  } finally { clearTimeout(timer); }
  if (!res.ok) throw await failure(res);
  return res.json();
}

export async function unack(key) {
  const res = await fetch(`/api/acks/${encodeURIComponent(key)}`, { method: 'DELETE' });
  if (!res.ok) throw await failure(res);
  return res.json();
}
