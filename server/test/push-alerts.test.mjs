import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushableFrom, newKeys, prune, observableKinds } from '../lib/push-alerts.mjs';

const cron = (key, text) => ({ kind: 'cron', key, text });
const limit = (key, text) => ({ kind: 'limit', key, text });
const isCounted = msg => /needs? attention/i.test(msg);

test('a limit alert pushes its real text', () => {
  const out = pushableFrom([limit('limit:W', 'Weekly · all models at 88%')]);
  assert.equal(out.length, 1);
  assert.match(out[0].message, /Weekly · all models at 88%/);
});

test('a cron alert never sends the job name or its exit status', () => {
  const out = pushableFrom([cron('cron:net.example.secret-job', 'secret-job cron Failed · 429')]);
  assert.equal(out.length, 1);
  const blob = `${out[0].title} ${out[0].message}`;
  assert.ok(!blob.includes('secret-job'), 'job name must not leave the machine');
  assert.ok(!blob.includes('429'), 'exit status must not leave the machine');
  assert.match(blob, /needs? attention/i);
});

test('several failing crons collapse into one counted message', () => {
  const out = pushableFrom([cron('cron:a', 'a failed'), cron('cron:b', 'b failed'), cron('cron:c', 'c failed')]);
  const crons = out.filter(o => isCounted(o.message));
  assert.equal(crons.length, 1);
  assert.match(crons[0].message, /3/);
});

test('the collapsed cron entry still carries every cron key, so each is deduped separately', () => {
  const out = pushableFrom([cron('cron:a', 'a failed'), cron('cron:b', 'b failed')]);
  const entry = out.find(o => isCounted(o.message));
  assert.deepEqual([...entry.keys].sort(), ['cron:a', 'cron:b']);
});

// The allowlist is the point: a kind that is missing, misspelled, or invented
// later by someone who has not read the comment must still be counted, never
// quoted — a denylist would disclose it by default instead.
test('an alert of an unrecognized kind is counted, never quoted', () => {
  const out = pushableFrom([{ kind: 'session', key: 'session:x', text: '/Users/jeff/private/path leaked' }]);
  assert.equal(out.length, 1);
  assert.ok(!out[0].message.includes('/Users/jeff/private/path'), 'unknown kinds must not be disclosed by default');
  assert.match(out[0].message, /needs? attention/i);
});

test('newKeys returns only alerts not already notified', () => {
  const alerts = [limit('limit:A', 'A at 90%'), limit('limit:B', 'B at 91%')];
  assert.deepEqual(newKeys(alerts, { 'limit:A': 1 }), ['limit:B']);
});

test('newKeys on an empty notified set returns everything', () => {
  const alerts = [limit('limit:A', 'A at 90%')];
  assert.deepEqual(newKeys(alerts, {}), ['limit:A']);
});

test('prune forgets a key whose condition has cleared, when its kind is observable', () => {
  const pruned = prune({ 'limit:A': 1, 'limit:B': 2 }, [limit('limit:A', 'A at 90%')], new Set(['limit']));
  assert.deepEqual(Object.keys(pruned), ['limit:A']);
});

test('prune keeps a key whose kind is not observable this run, even though the alert is absent', () => {
  // No observable set passed at all — the safe default is "nothing is observable",
  // so nothing is forgotten. This is the cold-start case: a restart where the
  // usage collector has not written yet must not look like every limit clearing.
  const pruned = prune({ 'limit:A': 1 }, []);
  assert.deepEqual(pruned, { 'limit:A': 1 });
});

test('prune keeps a key of one kind while forgetting a cleared key of an observable kind', () => {
  const pruned = prune(
    { 'limit:A': 1, 'cron:x': 2 },
    [],
    new Set(['limit']) // only limit is observable this run; cron is not
  );
  assert.deepEqual(pruned, { 'cron:x': 2 }, 'limit:A cleared and was observable, so it is forgotten; cron:x was not observable, so it is kept');
});

test('a cleared then returning condition notifies again, once its kind is observable', () => {
  const a = [limit('limit:A', 'A at 90%')];
  let sent = { 'limit:A': 1 };
  sent = prune(sent, [], new Set(['limit']));  // condition cleared, and we could see that
  assert.deepEqual(newKeys(a, sent), ['limit:A']); // and returns
});

test('an alert with no key is dropped rather than pushed unkeyed', () => {
  assert.deepEqual(pushableFrom([{ kind: 'limit', text: 'no key' }]), []);
});

test('observableKinds reports usage-backed kinds only when the usage panel is ok', () => {
  assert.deepEqual([...observableKinds({ usage: { status: 'ok' } })].sort(),
    ['credits', 'limit', 'projection']);
  assert.deepEqual([...observableKinds({ usage: { status: 'stale' } })].sort(), ['credits']);
});

test('observableKinds reports cron as observable when either cron source is ok', () => {
  assert.ok(observableKinds({ crons: { status: 'ok' } }).has('cron'));
  assert.ok(observableKinds({ ingestCrons: { status: 'ok' } }).has('cron'));
  assert.ok(!observableKinds({ crons: { status: 'unavailable' }, ingestCrons: { status: 'stale' } }).has('cron'));
});

test('observableKinds always reports credits, since it is config-backed rather than panel-backed', () => {
  assert.ok(observableKinds({}).has('credits'));
  assert.ok(observableKinds(undefined).has('credits'));
});
