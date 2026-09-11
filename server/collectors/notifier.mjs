import { buildAlerts } from '../lib/alerts.mjs';
import { pushableFrom, newKeys, prune, observableSources } from '../lib/push-alerts.mjs';

// Only push from panels that are actually current. A `stale` panel still holds
// its last good reading, which is right to keep showing on screen — but pushing
// "you are at 88%" from an hour-old number tells the user something about now
// that we do not know.
const okOnly = snapshot => {
  const out = {};
  for (const [k, v] of Object.entries(snapshot ?? {})) {
    out[k] = v?.status === 'ok' ? v : { ...v, data: undefined };
  }
  return out;
};

export async function runNotifier({ snapshot, config, now, readSent, writeSent, send }) {
  const alerts = buildAlerts(okOnly(snapshot), config ?? {}, now);
  // The raw snapshot, not okOnly(snapshot): observability is about whether a
  // source reported this run at all, which okOnly's blanking already erases.
  const alreadySent = prune((await readSent()) ?? {}, alerts, observableSources(snapshot));
  const unsentKeys = new Set(newKeys(alerts, alreadySent));

  let sent = 0, skipped = 0;
  for (const entry of pushableFrom(alerts)) {
    // A grouped cron entry carries several keys; it is new if ANY of them is.
    if (!entry.keys.some(k => unsentKeys.has(k))) { skipped++; continue; }
    let result;
    try {
      result = await send(entry);
    } catch (err) {
      result = { sent: false, reason: err.message };
    }
    if (result?.sent) {
      sent++;
      // Record only what actually landed, so a failed push retries next run
      // rather than being silently swallowed.
      for (const k of entry.keys) alreadySent[k] = now;
    }
  }

  await writeSent(alreadySent);
  return { alerts: alerts.length, sent, skipped };
}
