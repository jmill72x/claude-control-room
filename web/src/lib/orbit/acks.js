// Acknowledging a known miss (docs/design/2026-11-10-jarvis-os-home.md, §6): which
// alerts can be acked, the form's two choices and the request it sends. The server
// (server/lib/acks.mjs) decides `since` and the real expiry; the page only asks.
// Checked by web/test/orbit-acks.test.js.
import { when } from './health.js';

const HOUR = 3600e3;
export const WEEK_MS = 7 * 24 * HOUR;
// The server's default: the next run plus this. Here only for the label.
export const AFTER_NEXT_MS = 2 * HOUR;
export const ACKABLE = new Set(['cron', 'service']);
export const MAX_NOTE = 200;

export const canAck = alert => Boolean(alert) && ACKABLE.has(alert.kind) && typeof alert.key === 'string' && alert.key !== '';

// The form's choices: the server's default (its next run plus 2 h, or 24 hours
// when there is no next run), and 7 days. `until` undefined means "the default".
export function untilChoices(alert, now) {
  const next = Number.isFinite(alert?.nextRunAt) && alert.nextRunAt > now ? alert.nextRunAt : null;
  return [
    { id: 'next', label: next ? `Until its next run (${when(next + AFTER_NEXT_MS, now)})` : 'For 24 hours', until: undefined },
    { id: 'week', label: `For 7 days (${when(now + WEEK_MS, now)})`, until: now + WEEK_MS }
  ];
}

// The POST body: the key, a trimmed note when there is one, `until` for the
// 7-day choice only. `by` is left to the server, which reads the page as the owner.
export function ackBody(alert, { note = '', choice = 'next' } = {}, now) {
  const choices = untilChoices(alert, now);
  const picked = choices.find(c => c.id === choice) ?? choices[0];
  const body = { key: alert.key };
  const trimmed = String(note ?? '').trim().slice(0, MAX_NOTE);
  if (trimmed) body.note = trimmed;
  if (picked.until !== undefined) body.until = picked.until;
  return body;
}
