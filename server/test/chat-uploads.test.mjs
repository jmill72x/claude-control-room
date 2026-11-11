// Two lows from the 2026-11-11 re-read of the Chat tab: a long name cut inside an
// emoji must not break the PDF download (L1), and an upload never sent with a
// message must not stay on disk for 90 days nor pile up without limit (L2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { makeChatEnv } from './helpers/chat-env.mjs';
import { dispositionFor, PENDING_UPLOADS_MAX } from '../lib/chat-routes.mjs';

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), Buffer.alloc(64, 0x20)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const exists = p => access(p).then(() => true, () => false);
const HOUR = 3600e3, MIN = 60e3;

test('a name of 119 characters and an emoji keeps the whole emoji, and the PDF downloads (no 500)', async () => {
  const env = await makeChatEnv();
  try {
    const phone = await env.pair('phone');
    const name = `${'a'.repeat(119)}\u{1F600}.pdf`;
    const up = await env.call({ method: 'POST', path: `/api/chat/attachments?name=${encodeURIComponent(name)}`, headers: { cookie: phone.cookie, 'content-type': 'application/pdf' }, body: PDF });
    assert.equal(up.status, 200, up.text);
    assert.equal(up.json.name, `${'a'.repeat(119)}\u{1F600}`, 'cut at 120 code points, the emoji whole');
    assert.ok(up.json.name.isWellFormed());
    const got = await env.call({ path: `/api/chat/attachments/${up.json.id}`, headers: { cookie: phone.cookie } });
    assert.equal(got.status, 200, got.text);
    assert.match(got.headers['content-disposition'], /^attachment; filename="a{119}_"; filename\*=UTF-8''a{119}%F0%9F%98%80$/);
  } finally { await env.close(); }
});

test('dispositionFor never throws on a lone surrogate', () => {
  const d = dispositionFor({ type: 'application/pdf', name: `x\uD83D.pdf` });
  assert.equal(d, `attachment; filename="x_.pdf"; filename*=UTF-8''x%EF%BF%BD.pdf`);
});

test('a pending upload that expires after an hour loses its file; a sent one keeps it', async () => {
  const env = await makeChatEnv();
  try {
    const phone = await env.pair('phone');
    const up = async () => (await env.call({ method: 'POST', path: '/api/chat/attachments?name=p.jpg', headers: { cookie: phone.cookie, 'content-type': 'image/jpeg' }, body: JPEG })).json.id;
    const unsent = await up();
    const sent = await up();
    const m = await env.call({ method: 'POST', path: '/api/chat/messages', headers: { cookie: phone.cookie }, body: { clientId: 'c1', text: '', attachmentIds: [sent] } });
    assert.equal(m.status, 200, m.text);
    env.clock.t += 59 * MIN;
    assert.equal(await env.routes.sweepUploads(), 0, 'not yet an hour');
    assert.ok(await exists(env.store.attachmentPath(unsent)));
    env.clock.t += 2 * MIN;
    assert.equal(await env.routes.sweepUploads(), 1);
    assert.equal(await exists(env.store.attachmentPath(unsent)), false, 'the unsent file is gone');
    assert.ok(await exists(env.store.attachmentPath(sent)), 'the sent file stays');
    const late = await env.call({ method: 'POST', path: '/api/chat/messages', headers: { cookie: phone.cookie }, body: { clientId: 'c2', text: 'x', attachmentIds: [unsent] } });
    assert.equal(late.status, 400, 'an expired upload can no longer be sent');
  } finally { await env.close(); }
});

test('an upload sweeps the expired ones first', async () => {
  const env = await makeChatEnv();
  try {
    const phone = await env.pair('phone');
    const body = { headers: { cookie: phone.cookie, 'content-type': 'image/jpeg' }, body: JPEG };
    const first = (await env.call({ method: 'POST', path: '/api/chat/attachments', ...body })).json.id;
    env.clock.t += HOUR + 1;
    assert.equal((await env.call({ method: 'POST', path: '/api/chat/attachments', ...body })).status, 200);
    assert.equal(await exists(env.store.attachmentPath(first)), false);
  } finally { await env.close(); }
});

test(`at most ${PENDING_UPLOADS_MAX} uploads wait per device (429 past it, nothing written); another device and an expiry free room`, async () => {
  const env = await makeChatEnv();
  try {
    const phone = await env.pair('phone');
    const pad = await env.pair('pad');
    const up = who => env.call({ method: 'POST', path: '/api/chat/attachments', headers: { cookie: who.cookie, 'content-type': 'image/jpeg' }, body: JPEG });
    for (let i = 0; i < PENDING_UPLOADS_MAX; i++) assert.equal((await up(phone)).status, 200, `upload ${i + 1}`);
    const files = async () => (await readdir(dirname(env.store.attachmentPath('0'.repeat(32))))).length;
    const before = await files();
    const refused = await up(phone);
    assert.equal(refused.status, 429);
    assert.equal(await files(), before, 'nothing written');
    assert.match(refused.json.error, /at most 8 files/);
    assert.equal((await up(pad)).status, 200, 'the cap is per device');
    env.clock.t += HOUR + 1;
    assert.equal((await up(phone)).status, 200, 'room again once the old ones expire');
  } finally { await env.close(); }
});

test('a pending upload sent with a message frees its place under the cap', async () => {
  const env = await makeChatEnv();
  try {
    const phone = await env.pair('phone');
    const up = () => env.call({ method: 'POST', path: '/api/chat/attachments', headers: { cookie: phone.cookie, 'content-type': 'image/jpeg' }, body: JPEG });
    const ids = [];
    for (let i = 0; i < PENDING_UPLOADS_MAX; i++) ids.push((await up()).json.id);
    assert.equal((await env.call({ method: 'POST', path: '/api/chat/messages', headers: { cookie: phone.cookie }, body: { clientId: 'c1', text: '', attachmentIds: ids.slice(0, 4) } })).status, 200);
    assert.equal((await up()).status, 200);
  } finally { await env.close(); }
});

test('the store never removes a file a message carries', async () => {
  const env = await makeChatEnv();
  try {
    const a = await env.store.putAttachment({ name: 'p.jpg', type: 'image/jpeg', data: JPEG });
    const b = await env.store.putAttachment({ name: 'q.jpg', type: 'image/jpeg', data: JPEG });
    await env.store.append({ from: 'jeff', kind: 'chat', text: '', clientId: 'c1', attachments: [a] });
    assert.equal(await env.store.removeAttachment(a.id), false);
    assert.ok(await exists(env.store.attachmentPath(a.id)));
    assert.equal(await env.store.removeAttachment(b.id), true);
    assert.equal(await exists(env.store.attachmentPath(b.id)), false);
    assert.equal(await env.store.removeAttachment('../x'), false);
  } finally { await env.close(); }
});
