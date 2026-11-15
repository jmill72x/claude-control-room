// The taps on a heal card (server/lib/heal-routes.mjs): POST /api/loops/<id>/approve
// with the action, or /decline. Same origin, so the device cookie goes by itself; the
// server checks the device, the Origin and the card. A refusal's words become the
// error's message, for the line under the buttons.
const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function answer(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body;
}

export const approveHeal = (id, action) =>
  fetch(`/api/loops/${encodeURIComponent(id)}/approve`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ action }) }).then(answer);

export const declineHeal = id =>
  fetch(`/api/loops/${encodeURIComponent(id)}/decline`, { method: 'POST', headers: JSON_HEADERS, body: '{}' }).then(answer);
