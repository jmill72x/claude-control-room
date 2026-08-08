import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushableFrom, newKeys, prune } from '../lib/push-alerts.mjs';

const cron = (key, text) => ({ kind: 'cron', key, text });
const limit = (key, text) => ({ kind: 'limit', key, text });

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
  assert.match(blob, /scheduled job/i);
});

test('several failing crons collapse into one counted message', () => {
  const out = pushableFrom([cron('cron:a', 'a failed'), cron('cron:b', 'b failed'), cron('cron:c', 'c failed')]);
  const crons = out.filter(o => /scheduled job/i.test(o.message));
  assert.equal(crons.length, 1);
  assert.match(crons[0].message, /3/);
});

test('the collapsed cron entry still carries every cron key, so each is deduped separately', () => {
  const out = pushableFrom([cron('cron:a', 'a failed'), cron('cron:b', 'b failed')]);
  const entry = out.find(o => /scheduled job/i.test(o.message));
  assert.deepEqual([...entry.keys].sort(), ['cron:a', 'cron:b']);
});

test('newKeys returns only alerts not already notified', () => {
  const alerts = [limit('limit:A', 'A at 90%'), limit('limit:B', 'B at 91%')];
  assert.deepEqual(newKeys(alerts, { 'limit:A': 1 }), ['limit:B']);
});

test('newKeys on an empty notified set returns everything', () => {
  const alerts = [limit('limit:A', 'A at 90%')];
  assert.deepEqual(newKeys(alerts, {}), ['limit:A']);
});

test('prune forgets a key whose condition has cleared', () => {
  const pruned = prune({ 'limit:A': 1, 'limit:B': 2 }, [limit('limit:A', 'A at 90%')]);
  assert.deepEqual(Object.keys(pruned), ['limit:A']);
});

test('a cleared then returning condition notifies again', () => {
  const a = [limit('limit:A', 'A at 90%')];
  let sent = { 'limit:A': 1 };
  sent = prune(sent, []);                       // condition cleared
  assert.deepEqual(newKeys(a, sent), ['limit:A']); // and returns
});

test('an alert with no key is dropped rather than pushed unkeyed', () => {
  assert.deepEqual(pushableFrom([{ kind: 'limit', text: 'no key' }]), []);
});
