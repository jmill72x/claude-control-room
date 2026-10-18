import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

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

export async function publish({ topic, title, message, fetchImpl = fetch }) {
  if (!topic) return { sent: false, reason: 'no topic configured' };
  try {
    // Encoded: an unencoded topic containing `/` or whitespace rewrites the
    // request target entirely.
    const res = await fetchImpl(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: { Title: title, Priority: 'default' },
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

// One alert to #pepper. Never rejects: like a failed push, a failed post must
// never fail the run that made it. A reason holds an exit status, an error code
// or the poster's path, never the message. One thing the poster refuses is a
// message that looks like a secret, and a reason quoting it would copy that
// text into the log.
export async function publishDiscord({ title, message, run = runPoster }) {
  try {
    const code = await run(DISCORD_POSTER, ['--agent', 'pepper', '--title', title], { input: message });
    return code === 0 ? { sent: true, reason: null } : { sent: false, reason: `discord-post exited ${code}` };
  } catch (err) {
    if (err?.code === 'ENOENT') return { sent: false, reason: `jarvis discord-post not found at ${DISCORD_POSTER}` };
    return { sent: false, reason: `discord-post failed (${err?.signal ?? err?.code ?? err?.name ?? 'unknown error'})` };
  }
}

// execFile with `input` on stdin, settling with the exit code. It rejects only
// when the poster never started (ENOENT, EACCES) or was killed. The poster
// bounds its own Keychain read (20 s) and each request (30 s), so the timeout
// is only a backstop: a child that never exited would hold the notifier's run
// open, and the registry skips every later run while one is in flight, ntfy's
// pushes included. The poster prints neither the webhook URL nor the message,
// so its output goes on to this service's log.
export function runPoster(file, args, { input }) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout: 2 * 60 * 1000 }, (err, stdout, stderr) => {
      process.stdout.write(stdout);
      process.stderr.write(stderr);
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
// that works. Each channel's own result comes back too, for logging; the
// notifier itself reads only `sent`.
export async function sendAlert({ topic, title, message, ntfy = publish, discord = publishDiscord }) {
  const viaNtfy = await ntfy({ topic, title, message });
  const viaDiscord = await discord({ title, message });
  return { sent: Boolean(viaNtfy.sent || viaDiscord.sent), ntfy: viaNtfy, discord: viaDiscord };
}
