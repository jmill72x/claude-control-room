// War room slice 2: the Stop button's conversions and the live rows' stop mark
// (src/lib/orbit/stop.js, src/lib/orbit/live.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { toBuf, toB64, creationOptions, requestOptions, registration, assertion, stopQuestion, faceIdError } from '../src/lib/orbit/stop.js';
import { liveRows } from '../src/lib/orbit/live.js';

test('base64url round trip, padding and the url alphabet', () => {
  for (const bytes of [[], [0], [251, 255], [1, 2, 3, 4, 5], Array.from({ length: 65 }, (_, i) => i * 3)]) {
    const b = toB64(new Uint8Array(bytes).buffer);
    assert.doesNotMatch(b, /[+/=]/);
    assert.deepEqual([...new Uint8Array(toBuf(b))], bytes);
  }
});

test('options become buffers; a made passkey and an answer become base64url', () => {
  const c = creationOptions({ challenge: 'AQID', user: { id: 'BAU', name: 'iPhone' }, excludeCredentials: [{ type: 'public-key', id: 'Bg' }], rp: { id: 'x' } });
  assert.deepEqual([...new Uint8Array(c.challenge)], [1, 2, 3]);
  assert.deepEqual([...new Uint8Array(c.user.id)], [4, 5]);
  assert.deepEqual([...new Uint8Array(c.excludeCredentials[0].id)], [6]);
  const r = requestOptions({ challenge: 'AQID', allowCredentials: [{ type: 'public-key', id: 'Bg' }], userVerification: 'required' });
  assert.equal(r.userVerification, 'required');
  assert.deepEqual([...new Uint8Array(r.allowCredentials[0].id)], [6]);
  const buf = a => new Uint8Array(a).buffer;
  assert.deepEqual(registration({ rawId: buf([1]), response: { clientDataJSON: buf([2]), getAuthenticatorData: () => buf([3]), getPublicKey: () => buf([4]) } }), { credentialId: 'AQ', clientDataJSON: 'Ag', authenticatorData: 'Aw', publicKey: 'BA' });
  assert.throws(() => registration({ rawId: buf([1]), response: { clientDataJSON: buf([2]) } }), /Safari/);
  assert.deepEqual(assertion({ rawId: buf([1]), response: { clientDataJSON: buf([2]), authenticatorData: buf([3]), signature: buf([4]) } }), { credentialId: 'AQ', clientDataJSON: 'Ag', authenticatorData: 'Aw', signature: 'BA' });
});

test('the sheet\'s words and Face ID refusals', () => {
  assert.deepEqual(stopQuestion({ name: 'Pepper', task: 'Build war room slice 2', running: '42 min' }), { title: 'Stop Pepper?', detail: 'Build war room slice 2, running 42 min.' });
  assert.match(faceIdError({ name: 'NotAllowedError' }), /Nothing was sent/);
  assert.match(faceIdError({}), /Nothing was sent/);
});

test('a live row is stoppable only on the server\'s mark with an id', () => {
  const now = 1794380000000;
  const live = { runs: [
    { id: 'a1b2c3d4e5f60718', agent: 'pepper', start: now - 60e3, last: now, stoppable: true },
    { id: 'b1b2c3d4e5f60718', agent: 'pepper', start: now - 60e3, last: now },
    { agent: 'pepper', start: now - 60e3, last: now, stoppable: true }
  ] };
  const rows = liveRows({ live, roster: { agents: [{ key: 'pepper', name: 'Pepper' }] }, now });
  assert.deepEqual(rows.map(r => r.stoppable), [true, false, false]);
  assert.equal(rows[0].id, 'a1b2c3d4e5f60718');
});
