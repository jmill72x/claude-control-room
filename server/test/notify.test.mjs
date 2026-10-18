import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getTopic, publish, publishDiscord, runPoster, sendAlert, DISCORD_POSTER } from '../notify.mjs';

// No test here may touch the real network or the real Keychain — `run` and
// `fetchImpl` are the injected seams that make that possible. Nor may one run
// the real Discord poster, which reads a webhook URL from the Keychain and
// posts: every publishDiscord call gets a fake `run`, and the runner itself is
// only ever pointed at system stand-ins.

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

// Stands in for the poster's runner: records each call and settles with `code`.
const fakeRun = (code = 0) => {
  const calls = [];
  const run = async (file, args, { input }) => { calls.push({ file, args, input }); return code; };
  return { run, calls };
};

test('publishDiscord passes pepper and the title', async () => {
  const { run, calls } = fakeRun(0);
  const result = await publishDiscord({ title: 'Control Room', message: 'Weekly · all models at 88%', run });
  assert.deepEqual(result, { sent: true, reason: null });
  // The message goes on stdin, never in argv.
  assert.deepEqual(calls, [{
    file: DISCORD_POSTER,
    args: ['--agent', 'pepper', '--title', 'Control Room'],
    input: 'Weekly · all models at 88%'
  }]);
  assert.equal(DISCORD_POSTER, join(homedir(), 'Projects', 'jarvis', 'bin', 'discord-post'));
});

test('publishDiscord failure is reported not thrown', async () => {
  const message = 'SENTINEL message text';
  const post = run => publishDiscord({ title: 'Control Room', message, run });
  // 2 is the poster refusing (no #pepper webhook stored yet, or a message that
  // looks like a secret); 3 is Discord or the network failing.
  for (const code of [2, 3]) {
    assert.deepEqual(await post(fakeRun(code).run), { sent: false, reason: `discord-post exited ${code}` });
  }
  // What execFile rejects with when there is no file at the path.
  const enoent = Object.assign(new Error(`spawn ${DISCORD_POSTER} ENOENT`), { code: 'ENOENT' });
  assert.deepEqual(await post(async () => { throw enoent; }),
    { sent: false, reason: `jarvis discord-post not found at ${DISCORD_POSTER}` });
  // A killed poster, and a runner that throws outright: still a result, and
  // neither error's text reaches the reason.
  const killed = Object.assign(new Error(`Command failed: ${message}`), { code: null, signal: 'SIGTERM' });
  assert.deepEqual(await post(async () => { throw killed; }), { sent: false, reason: 'discord-post failed (SIGTERM)' });
  const thrown = await post(() => { throw new TypeError(message); });
  assert.equal(thrown.sent, false);
  assert.doesNotMatch(thrown.reason, /SENTINEL/);
});

// sendAlert is the notifier's `send` in server.mjs: the one caller of both
// channels. Each case runs the real ntfy publish, with only its fetch faked.
test('the caller attempts both channels', async () => {
  const alert = { title: 'Control Room', message: 'Weekly · all models at 88%' };
  const attempt = async ({ topic, ntfyStatus, discordSent }) => {
    const tried = [];
    const result = await sendAlert({
      topic,
      ...alert,
      ntfy: args => {
        tried.push('ntfy');
        return publish({ ...args, fetchImpl: async () => { tried.push('ntfy request'); return { ok: ntfyStatus === 200, status: ntfyStatus }; } });
      },
      discord: async args => {
        tried.push('discord');
        assert.deepEqual(args, alert);
        return discordSent ? { sent: true, reason: null } : { sent: false, reason: 'discord-post exited 2' };
      }
    });
    return { tried, result };
  };

  // No ntfy topic: no request goes out, and Discord alone carries the alert.
  let { tried, result } = await attempt({ topic: null, discordSent: true });
  assert.deepEqual(tried, ['ntfy', 'discord']);
  assert.deepEqual(result, {
    sent: true, ntfy: { sent: false, reason: 'no topic configured' }, discord: { sent: true, reason: null }
  });

  // ntfy failing: Discord is still tried, and its delivery counts.
  ({ tried, result } = await attempt({ topic: 'topic', ntfyStatus: 500, discordSent: true }));
  assert.deepEqual(tried, ['ntfy', 'ntfy request', 'discord']);
  assert.equal(result.sent, true);
  assert.equal(result.ntfy.reason, 'HTTP 500');

  // The reverse: Discord failing takes nothing from ntfy's delivery.
  ({ tried, result } = await attempt({ topic: 'topic', ntfyStatus: 200, discordSent: false }));
  assert.deepEqual(tried, ['ntfy', 'ntfy request', 'discord']);
  assert.deepEqual(result, {
    sent: true, ntfy: { sent: true, reason: null }, discord: { sent: false, reason: 'discord-post exited 2' }
  });

  // Neither landed: not sent, so the notifier tries it again next run.
  ({ tried, result } = await attempt({ topic: 'topic', ntfyStatus: 500, discordSent: false }));
  assert.deepEqual(tried, ['ntfy', 'ntfy request', 'discord']);
  assert.equal(result.sent, false);
});

test('the default runner settles with the exit code, even when the poster leaves stdin unread', async () => {
  // System stand-ins, never the real poster: true and false exit without
  // reading stdin. A megabyte overfills the pipe, so the write fails with
  // EPIPE, and that must not take the service down.
  const input = 'x'.repeat(1 << 20);
  assert.equal(await runPoster('/usr/bin/true', [], { input }), 0);
  assert.equal(await runPoster('/usr/bin/false', [], { input }), 1);
  await assert.rejects(runPoster('/no/such/jarvis/bin/discord-post', [], { input }), { code: 'ENOENT' });
  // And publishDiscord reads the real runner's exit code as it reads a fake's.
  const viaFalse = (file, args, options) => runPoster('/usr/bin/false', args, options);
  assert.deepEqual(await publishDiscord({ title: 'Control Room', message: input, run: viaFalse }),
    { sent: false, reason: 'discord-post exited 1' });
});
