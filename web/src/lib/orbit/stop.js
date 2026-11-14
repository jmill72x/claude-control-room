// Stop with Face ID (war room slice 2; server/lib/agent-stop.mjs, server/lib/stepup.mjs):
// the plain conversions between the server's JSON and WebAuthn's buffers, and the
// sheet's words. Checked by web/test/orbit-stop.test.js.

export function toBuf(b64url) {
  const s = String(b64url).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}
export function toB64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// The server's creation options, with the ids and challenge as buffers.
export function creationOptions(o) {
  return {
    ...o,
    challenge: toBuf(o.challenge),
    user: { ...o.user, id: toBuf(o.user.id) },
    excludeCredentials: (o.excludeCredentials ?? []).map(c => ({ ...c, id: toBuf(c.id) }))
  };
}
export function requestOptions(o) {
  return { ...o, challenge: toBuf(o.challenge), allowCredentials: (o.allowCredentials ?? []).map(c => ({ ...c, id: toBuf(c.id) })) };
}

// A made passkey as the server takes it: the key as SPKI (getPublicKey), never CBOR.
export function registration(cred) {
  const r = cred.response;
  const key = typeof r.getPublicKey === 'function' ? r.getPublicKey() : null;
  const auth = typeof r.getAuthenticatorData === 'function' ? r.getAuthenticatorData() : null;
  if (!key || !auth) throw new Error('this browser can\'t hand over the passkey\'s key; set up Face ID in Safari on the iPhone or iPad');
  return { credentialId: toB64(cred.rawId), clientDataJSON: toB64(r.clientDataJSON), authenticatorData: toB64(auth), publicKey: toB64(key) };
}
export function assertion(cred) {
  const r = cred.response;
  return { credentialId: toB64(cred.rawId), clientDataJSON: toB64(r.clientDataJSON), authenticatorData: toB64(r.authenticatorData), signature: toB64(r.signature) };
}

// The confirm sheet's question, from the row the page already shows.
export function stopQuestion(row) {
  return { title: `Stop ${row.name}?`, detail: `${row.task}, running ${row.running}.` };
}
// A WebAuthn refusal in words: the user closed Face ID, or it timed out.
export function faceIdError(err) {
  if (err?.name === 'NotAllowedError') return 'Face ID was cancelled or timed out. Nothing was sent.';
  if (err?.name === 'InvalidStateError') return 'This device already has a passkey for stops.';
  return err?.message ?? 'Face ID failed. Nothing was sent.';
}
