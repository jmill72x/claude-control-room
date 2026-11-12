// The chat's events in words, for the service log and the pushed alerts (moved out
// of server.mjs on 2026-11-11 so the path is tested: test/chat-events.test.mjs).
//
// Every event is one log line, `chat: <words>`. The kinds in ALERTED_KINDS also push:
// #pepper gets the same words, ntfy only NTFY_WORDS, since ntfy shows on a lock
// screen (Ultron's L10). A verdict from the page (Deny or Allow) is one of them, and
// its words name the device that tapped and the tool (Ultron's 11-10 condition 4,
// board e8d3ef26).
//
// One event can never make two lines (Ultron, same item): a device name is cleaned
// when it pairs (chat-devices.mjs, cleanName), but a name read back from
// devices.json, a tool name from the channel (capField keeps its line breaks) or any
// other field is not, so the whole line goes through `oneLine` last. A line break,
// another control character or a direction or invisible character becomes a visible
// ⟦U+XXXX⟧, a tab a space, and a line longer than LINE_MAX code points is cut with
// a marker. Built with code points, never typed escapes (a typed one has turned into
// the real character in this repo before).

import { createAlertLimiter } from './chat-alert-limit.mjs';

export const LINE_MAX = 600;
export const NTFY_WORDS = 'A chat security event on the Control Room: details in #pepper';

// C0 and C1 controls (tab aside), DEL, the line and paragraph separators, and the
// direction and invisible characters approvals.mjs reveals in a card.
const isUnsafe = c => (c < 0x20 && c !== 0x09) || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 ||
  c === 0x061c || (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2060 && c <= 0x2069) || c === 0xfeff;

export function oneLine(s, max = LINE_MAX) {
  const out = [];
  for (const ch of String(s ?? '')) {
    const c = ch.codePointAt(0);
    if (c === 0x09) out.push(' ');
    else if (isUnsafe(c)) out.push(`⟦U+${c.toString(16).toUpperCase().padStart(4, '0')}⟧`);
    else out.push(ch);
  }
  if (out.length <= max) return out.join('');
  return out.slice(0, max).join('') + ` ⋯ ${out.length - max} more cut`;
}

// The kinds that push as well as log.
export const ALERTED_KINDS = Object.freeze(['client-refused', 'client-replaced', 'channel-silent', 'paired', 'revoked', 'pairing-failed', 'verdict', 'pairing-started', 'push-forbidden',
  'approver-changed', 'approvals-mode', 'approvals-relay', 'approvals-test-channel', 'approvals-kill', 'approvals-lockout', 'approvals-anonymous', 'approvals-burst', 'approvals-flood', 'approvals-exact-conflict']);

// The words for one event, made safe for one line.
export function chatEventLine(event) {
  const words = {
    'client-refused': 'a second chat channel tried to connect and was refused',
    'client-replaced': event.unverified
      ? `a process tried to take the chat channel's place after its bye and was refused (${event.unverified})`
      : `the chat channel was taken over by another process after its heartbeat went stale (${Math.round((event.staleFor ?? 0) / 1000)} s)`,
    'channel-silent': `the chat channel said bye and has not come back in ${Math.round((event.after ?? 0) / 60e3)} minutes`,
    'pairing-started': `a device asked to pair with the chat (${event.name || 'unnamed'})`,
    'pairing-approved': `a chat pairing was approved by ${event.by}`,
    paired: `a device was paired with the chat: ${event.device?.name ?? '?'} (by ${event.by})`,
    revoked: `a chat device was revoked: ${event.device?.name ?? '?'}`,
    'pairing-failed': 'a chat pairing failed on three wrong codes',
    'permission-opened': `the lead asked for a permission (${event.tool ?? 'a tool'})`,
    verdict: `a permission was ${event.behavior} from ${event.device ?? 'a device'} (${event.tool ?? 'a tool'})`,
    'push-forbidden': `Apple's push service refused the chat's notification key (403) for ${event.device ?? 'a device'}`,
    'approver-changed': `${event.device?.name ?? 'a device'} ${event.on ? 'may now allow' : 'may no longer allow'} permissions (by ${event.by})`,
    'approvals-mode': `chat approvals are ${event.mode === 'on' ? 'on (Deny and Allow once)' : event.mode === 'deny' ? 'on, Deny only' : 'off'} at this start${event.previous && event.previous !== event.mode ? ` (were ${event.previous})` : ''}`,
    'approvals-relay': `the channel now says its permission relay is ${event.relay === 'allow' ? 'allow (Deny and Allow)' : event.relay === 'deny' ? 'Deny only' : event.relay === 'off' ? 'off' : 'not stated (the page offers Deny only)'}; it was ${event.previous ?? 'unknown'}`,
    'approvals-test-channel': 'a chat channel said hello in test mode: page approvals are Deny only while it holds the socket (the lead\'s own channel never runs that way; look for JARVIS_CHANNEL_TEST in a settings env block)',
    'approvals-kill': `the approvals kill file was ${event.on ? 'created: page approvals are off' : 'removed: page approvals follow config again'}`,
    'approvals-lockout': `${event.device ?? 'a device'} was locked out of approvals for 10 minutes after 10 refused taps`,
    'approvals-anonymous': `${event.count ?? 'many'} verdicts with no paired device were refused in 10 minutes`,
    'approvals-burst': `${event.count ?? 'several'} permissions were allowed from the page in 5 minutes`,
    'approvals-flood': `${event.open ?? 'many'} permission requests were open at once: page approvals are Deny only for 10 minutes`,
    'approvals-exact-conflict': 'two different exact-command reports matched one Bash request: its card is Deny only (a doubled or forged hook report)'
  };
  const line = words[event.kind] ?? `chat event ${event.kind}`;
  return oneLine(line);
}

// What server.mjs hands every chat module as `onEvent`. `send(message)` pushes one
// alert (sendAlert with NTFY_WORDS for ntfy); a refused channel and a takeover push
// at most once per kind per 10 minutes (lib/chat-alert-limit.mjs). Never throws: a
// failed push is logged.
export function createChatEventHandler({ send, log = console.log, logError = console.error }) {
  const alerts = createAlertLimiter({ send, onError: err => logError('chat: alert failed', err?.message ?? err) });
  return async event => {
    const line = chatEventLine(event ?? {});
    log(`chat: ${line}`);
    if (!ALERTED_KINDS.includes(event?.kind)) return;
    try {
      const { sent, held } = await alerts.alert(event.kind, line);
      if (!sent) log(`chat: alert held back (${held} ${event.kind} in this window)`);
    } catch (err) { logError('chat: alert failed', err?.message ?? err); }
  };
}
