import { execFile } from 'node:child_process';
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
    const res = await fetchImpl(`https://ntfy.sh/${topic}`, {
      method: 'POST',
      headers: { Title: title, Priority: 'default' },
      body: message
    });
    return { sent: res.ok, reason: res.ok ? null : `HTTP ${res.status}` };
  } catch (err) {
    // A failed push must never fail the thing that triggered it. The dashboard
    // is the source of truth; this is a convenience on top of it.
    return { sent: false, reason: err.message };
  }
}
