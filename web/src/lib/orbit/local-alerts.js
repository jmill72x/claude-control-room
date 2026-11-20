// A local script's alert (server/lib/local-alerts.mjs; board 5f892918): kind `local`,
// with the script's own title (`text`), `body`, `severity` (info, warning, critical),
// `about` ("jarvis-down" or "other") and `at`. The strip draws the title and the time
// it was raised, so an old one reads as old; Needs you draws a card whose chip says
// what kind it is and whose text is the body. Plain text throughout: React escapes it.
// Checked by web/test/orbit-local-alerts.test.js.
import { clock } from './page.js';
import { RECOVER_WHAT } from './recover.js';

export const isLocalAlert = alert => alert?.kind === 'local';

const SEVERITY_CHIPS = { critical: 'Critical', warning: 'Warning', info: 'Notice' };

// The card's chip: "Jarvis down" for the lead's start script, else the severity.
export function localChip(alert) {
  if (alert?.about === 'jarvis-down') return 'Jarvis down';
  return SEVERITY_CHIPS[alert?.severity] ?? 'Alert';
}

// What the card says to do: the script's own body, then how to put it away.
// A "jarvis-down" one also says how to bring him back (recover.js, RECOVER_WHAT).
export function localWhat(alert) {
  const body = typeof alert?.body === 'string' ? alert.body.trim() : '';
  const away = 'Once it is handled, acknowledge it; it leaves on its own 24 hours after it was raised.';
  const back = alert?.about === 'jarvis-down' ? `${RECOVER_WHAT}\n\n` : '';
  return body ? `${body}\n\n${back}${away}` : `${back}${away}`;
}

// The card's meta line: who raised it and when.
export const localMeta = alert => `a local script · raised ${clock(alert?.at)}`;

// The strip's words for an alert: a local one adds the time it was raised.
export const stripText = alert => (isLocalAlert(alert) && Number.isFinite(alert.at) ? `${alert.text} · ${clock(alert.at)}` : alert?.text ?? '');
