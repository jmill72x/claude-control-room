// Heads up's one request (server/lib/proactive-routes.mjs). The device cookie goes by
// itself (same origin), so nothing here holds a credential. A refusal's status rides
// on the error: 401 means this device isn't paired, 403 not the owner, 404 a server
// from before the check.
export class HeadsUpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function getHeadsUp() {
  const res = await fetch('/api/proactive', { cache: 'no-store' });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new HeadsUpError(res.status, body?.error ?? `HTTP ${res.status}`);
  return body;
}
