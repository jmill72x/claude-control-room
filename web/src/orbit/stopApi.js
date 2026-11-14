// The Stop button's requests (server/lib/agent-stop.mjs). Same origin, so the device
// cookie goes by itself; Face ID is the browser's own sheet (WebAuthn).
import { ChatError } from './chatApi.js';
import { creationOptions, requestOptions, registration, assertion } from '../lib/orbit/stop.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
async function answer(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ChatError(res.status, body?.error ?? `HTTP ${res.status}`, body);
  return body;
}
const post = (url, body = {}) => fetch(url, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) }).then(answer);

// { passkey, pending } for an approver device; a 401 or 403 means no Stop buttons here.
export const stepUpStatus = () => fetch('/api/stepup/status', { cache: 'no-store' }).then(answer);

// Make this device's passkey (Face ID), and get the code to confirm at the machine.
export async function setUpFaceId() {
  const { publicKey } = await post('/api/stepup/register/options');
  const cred = await navigator.credentials.create({ publicKey: creationOptions(publicKey) });
  return post('/api/stepup/register', registration(cred));
}

// Face ID, then the stop. Resolves with the server's note.
export async function stopRun(id) {
  const path = `/api/agents/${encodeURIComponent(id)}/stop`;
  const { publicKey } = await post(`${path}/challenge`);
  const cred = await navigator.credentials.get({ publicKey: requestOptions(publicKey) });
  return post(path, assertion(cred));
}
