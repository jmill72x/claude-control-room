import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getTopic, publish } from '../notify.mjs';

// No test here may touch the real network or the real Keychain — `run` and
// `fetchImpl` are the injected seams that make that possible.

test('getTopic returns the trimmed topic from the injected run', async () => {
  const topic = await getTopic({ run: async () => '  my-topic-abc123  \n' });
  assert.equal(topic, 'my-topic-abc123');
});

test('getTopic returns null when the injected run throws', async () => {
  const topic = await getTopic({ run: async () => { throw new Error('item not found in keychain'); } });
  assert.equal(topic, null);
});

test('getTopic returns null for empty output', async () => {
  assert.equal(await getTopic({ run: async () => '' }), null);
  assert.equal(await getTopic({ run: async () => '   \n' }), null);
});

test('publish returns sent:false with no topic and makes no network call', async () => {
  let called = false;
  const result = await publish({
    topic: null,
    title: 'Control Room',
    message: 'hi',
    fetchImpl: async () => { called = true; return { ok: true }; }
  });
  assert.equal(result.sent, false);
  assert.equal(called, false, 'no topic means no request should ever be attempted');
});

test('publish posts the body and the Title header to the topic URL, encoded', async () => {
  let seenUrl, seenOptions;
  const result = await publish({
    topic: 'a/b c',
    title: 'Control Room',
    message: 'Weekly · all models at 88%',
    fetchImpl: async (url, options) => { seenUrl = url; seenOptions = options; return { ok: true, status: 200 }; }
  });
  assert.equal(result.sent, true);
  assert.equal(seenUrl, 'https://ntfy.sh/a%2Fb%20c', 'a topic containing / or space must not rewrite the request target');
  assert.equal(seenOptions.method, 'POST');
  assert.equal(seenOptions.headers.Title, 'Control Room');
  assert.equal(seenOptions.body, 'Weekly · all models at 88%');
});

test('publish reports not-sent on a non-2xx response', async () => {
  const result = await publish({
    topic: 'sometopic',
    title: 'Control Room',
    message: 'hi',
    fetchImpl: async () => ({ ok: false, status: 500 })
  });
  assert.equal(result.sent, false);
  assert.match(result.reason, /500/);
});

test('publish returns an opaque reason that does not contain the topic when fetchImpl throws an error quoting the URL', async () => {
  const secretTopic = 'jeffs-very-secret-topic-2026';
  const result = await publish({
    topic: secretTopic,
    title: 'Control Room',
    message: 'hi',
    fetchImpl: async () => {
      throw new Error(`Failed to parse URL from https://ntfy.sh/${secretTopic}`);
    }
  });
  assert.equal(result.sent, false);
  assert.ok(!String(result.reason).includes(secretTopic), 'the failure reason must never quote the topic');
  assert.equal(result.reason, 'request failed');
});
