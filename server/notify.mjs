import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { stampLines } from './lib/log-stamp.mjs';

const exec = promisify(execFile);

// The topic is the only access control on free ntfy.sh, so it lives in Keychain
// rather than in this public repo. Its own entry, not the one another project
// uses: a leaked topic should cost one service, not both.
export async function getTopic({ run } = {}) {
  const call = run ?? (async () => {
    const { stdout } = await exec('security', [
      'find-generic-password', '-a', 'claude-control-room', '-s', 'ntfy-topic', '-w'
    ]);
    return stdout;
  });
  try {
    const topic = (await call()).trim();
    return topic || null;
  } catch {
    return null; // not configured is a normal state, not an error
  }
}

// `priority` is ntfy's word for how loudly the phone says it: 'default' for an alert,
// 'low' (no sound or vibration) for an ack's notice (lib/acks.mjs).
const NTFY_PRIORITIES = new Set(['min', 'low', 'default', 'high', 'urgent']);

export async function publish({ topic, title, message, priority = 'default', fetchImpl = fetch }) {
  if (!topic) return { sent: false, reason: 'no topic configured' };
  try {
    // Encoded: an unencoded topic containing `/` or whitespace rewrites the
    // request target entirely.
    const res = await fetchImpl(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: { Title: title, Priority: NTFY_PRIORITIES.has(priority) ? priority : 'default' },
      body: message
    });
    return { sent: res.ok, reason: res.ok ? null : `HTTP ${res.status}` };
  } catch {
    // A failed push must never fail the thing that triggered it. The dashboard
    // is the source of truth; this is a convenience on top of it. Deliberately
    // opaque: a fetch error message can quote the whole URL, and the URL
    // contains the topic — which is the only access control there is.
    return { sent: false, reason: 'request failed' };
  }
}

// Every alert also goes to Pepper's Discord feed, #pepper, through the Jarvis
// toolkit's poster. The poster reads the feed's webhook URL from the Keychain
// itself, so that secret never passes through this public repo. It exits 0
// when it posted, 2 on a usage or configuration problem (no webhook stored, a
// message that looks like a secret) and 3 when Discord or the network failed.
export const DISCORD_POSTER = join(homedir(), 'Projects', 'jarvis', 'bin', 'discord-post');

// The feeds an alert may be posted to: #pepper, every alert's, and #jarvis, where
// the lead's own routines post and where the limit's full line goes
// (lib/limit-warnings.mjs). Any other name posts to #pepper.
export const FEEDS = Object.freeze(['pepper', 'jarvis']);
const feedOf = feed => (FEEDS.includes(feed) ? feed : 'pepper');

// One alert to #pepper, or to #jarvis with `feed: 'jarvis'`. Never rejects: like a
// failed push, a failed post must never fail the run that made it. A reason holds an
// exit status, an error code or the poster's path, never the message. One thing the
// poster refuses is a message that looks like a secret, and a reason quoting it would
// copy that text into the log.
export async function publishDiscord({ title, message, feed = 'pepper', run = runPoster }) {
  try {
    const code = await run(DISCORD_POSTER, ['--agent', feedOf(feed), '--title', title], { input: message });
    return code === 0 ? { sent: true, reason: null } : { sent: false, reason: `discord-post exited ${code}` };
  } catch (err) {
    // No poster is the normal state wherever Jarvis isn't installed, and this
    // repo is public, so that stays out of the log. A poster that could not run
    // at all (killed by the backstop, not executable) printed nothing of its
    // own, so it gets one line: the reason, value-free like the rest.
    if (err?.code === 'ENOENT') return { sent: false, reason: `jarvis discord-post not found at ${DISCORD_POSTER}` };
    const reason = `discord-post failed (${err?.signal ?? err?.code ?? err?.name ?? 'unknown error'})`;
    console.error(reason);
    return { sent: false, reason };
  }
}

// execFile with `input` on stdin, settling with the exit code. It rejects only
// when the poster never started (ENOENT, EACCES) or was killed. The timeout is
// a backstop: a child that never exited would hold the notifier's run open,
// and the registry skips every later run while one is in flight, ntfy's pushes
// included. Six minutes matches the poster's own worst case, about five and a
// half: a 20 s Keychain read, then up to 10 messages at 30 s each, a second
// apart. So a long body is never cut off mid-post and then posted again whole
// on the retry. The poster prints neither the webhook URL nor the message, so
// its output goes on to this service's log.
export function runPoster(file, args, { input }) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout: 6 * 60 * 1000 }, (err, stdout, stderr) => {
      // Written as is, apart from the time at the start of each line: the
      // poster's lines keep their own newlines, which console.log would double.
      process.stdout.write(stampLines(stdout));
      process.stderr.write(stampLines(stderr));
      if (err && typeof err.code !== 'number') reject(err);
      else resolve(err ? err.code : 0);
    });
    // A poster that exits without reading stdin (a usage error, say) fails
    // this write with EPIPE, and an unhandled stream error would take the
    // whole service down. The exit code already says what happened.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

// The notifier's `send`: one alert to both channels, ntfy first, and neither
// one's failure skips the other. Landing on either counts as sent: the notifier
// stops retrying an alert once it is sent, so requiring both would let a
// channel that is down make every five-minute run post it again on the one
// that works. Each channel's own result is attached for callers; runNotifier
// reads only `sent`.
// `ntfyMessage`, when given, is what ntfy gets in place of `message`: ntfy shows on a
// lock screen, so the chat's alerts send it generic words and keep the details for
// #pepper (approvals, Ultron L10).
// `priority` is ntfy's (a heal's page is 'high'); #pepper has no such thing.
// A #pepper copy the poster refused or couldn't post (it exited 2 or 3) is logged with
// that reason, never the message (Ultron's 11-12 low): exit 2 is what the poster does
// with secret-shaped text, which a job's name or a label can look like, and with ntfy
// carrying the alert the run reads as sent, so nothing else would say #pepper missed it.
// A poster that could not start logs its own line, and one that isn't installed is the
// normal state elsewhere.
// `feed` is the Discord feed (FEEDS): #pepper unless the alert names #jarvis.
const POSTER_EXIT_WORDS = Object.freeze({ 2: 'refused: secret-shaped text, or no webhook stored', 3: 'Discord or the network failed' });
export async function sendAlert({ topic, title, message, ntfyMessage = null, priority = 'default', feed = 'pepper', ntfy = publish, discord = publishDiscord, logError = console.error }) {
  const viaNtfy = await ntfy({ topic, title, message: ntfyMessage ?? message, priority });
  const viaDiscord = await discord({ title, message, feed: feedOf(feed) });
  // A sent post has no reason, so only a failed one matches.
  const exit = /^discord-post exited (\d+)$/.exec(String(viaDiscord?.reason ?? ''));
  if (exit) logError(`push: the #${feedOf(feed)} copy of an alert was not sent (discord-post exited ${exit[1]}${Object.hasOwn(POSTER_EXIT_WORDS, exit[1]) ? `: ${POSTER_EXIT_WORDS[exit[1]]}` : ''})`);
  return { sent: Boolean(viaNtfy.sent || viaDiscord.sent), ntfy: viaNtfy, discord: viaDiscord };
}

// An ack's notice (lib/acks.mjs, ackNotice: `{ message, ntfyMessage, priority }`) goes
// out in two halves, each through its own limit (lib/ack-notice-limit.mjs): the details
// to #pepper, titled like an alert, and the generic words to ntfy. A post that fails is
// logged with its reason, which never holds the message or the topic. ntfy with no topic
// is a normal state (getTopic), so that one is not logged.
export async function sendAckPepper(notice, { discord = publishDiscord, logError = console.error } = {}) {
  const result = await discord({ title: 'Control Room', message: notice.message });
  if (!result.sent) logError(`ack: the #pepper notice was not sent (${result.reason ?? 'unknown'})`);
  return result;
}

export async function sendAckNtfy({ message, priority }, { topic = getTopic, ntfy = publish, logError = console.error } = {}) {
  const result = await ntfy({ topic: await topic(), title: 'Control Room', message, priority });
  if (!result.sent && result.reason !== 'no topic configured') logError(`ack: the ntfy notice was not sent (${result.reason ?? 'unknown'})`);
  return result;
}
