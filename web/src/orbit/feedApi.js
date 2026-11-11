// The Feed tab's one request (server/lib/feed-routes.mjs). The device cookie goes by
// itself (same origin), so nothing here holds a credential. A refusal's status rides
// on the error: 401 means this device isn't paired, 403 not the owner.
export class FeedError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function getFeed() {
  const res = await fetch('/api/feed', { cache: 'no-store' });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new FeedError(res.status, body?.error ?? `HTTP ${res.status}`);
  return body;
}
