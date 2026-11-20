// Restart Jarvis's requests (server/lib/jarvis-recover.mjs). Same origin, so the device
// cookie goes by itself; Face ID is the browser's own sheet (WebAuthn), with the passkey
// a Stop uses (stopApi.js sets it up).
import { ChatError } from './chatApi.js';
import { requestOptions, assertion } from '../lib/orbit/stop.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
async function answer(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ChatError(res.status, body?.error ?? `HTTP ${res.status}`, body);
  return body;
}
const post = (url, body = {}) => fetch(url, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) }).then(answer);

// { on, passkey, pending, running, last, blocked, nextAt, command } for an approver
// device; a 401, 403 or 404 means no Restart button on this device.
export const recoverStatus = () => fetch('/api/recover/status', { cache: 'no-store' }).then(answer);

// Face ID, then the restart. Resolves with the server's answer ({ run, note }).
export async function restartJarvis() {
  const { publicKey } = await post('/api/recover/challenge');
  const cred = await navigator.credentials.get({ publicKey: requestOptions(publicKey) });
  return post('/api/recover', assertion(cred));
}
