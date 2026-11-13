import { buildAlerts } from '../lib/alerts.mjs';
import { pushableFrom, newKeys, prune, observableSources } from '../lib/push-alerts.mjs';
import { applyAcks } from '../lib/acks.mjs';

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

// The alerts a heal loop is checking (`holdUntil` still ahead; lib/heal-runner.mjs),
// unless their key was pushed before: Jeff already knows of those, and holding one
// would only make the event hook forget it and wake Jarvis again once the hold ends.
export function heldAlerts(alerts, alreadySent, now) {
  return new Set((alerts ?? [])
    .filter(a => Number.isFinite(a?.holdUntil) && a.holdUntil > now && !Object.hasOwn(alreadySent ?? {}, a.key))
    .map(a => a.key));
}

// `events` (optional): `(alerts, { observable }) => Promise`, the event
// hook (lib/events.mjs), given the alerts after acks. It keeps a ledger of its own and
// runs in its own try, so a failed push and a failed event never block each other.
export async function runNotifier({ snapshot, config, now, readSent, writeSent, send, acks = [], events = null, log = console.error }) {
  // An acknowledged alert (lib/acks.mjs) is not pushed. Its key is then forgotten
  // by the rule below, so when the ack lapses with the condition still live, the
  // alert is new again and pushed again: an expiry re-notifies, which is its job.
  const { alerts } = applyAcks(buildAlerts(okOnly(snapshot), config ?? {}, now), acks, now);
  // The raw snapshot, not okOnly(snapshot): observability is about whether a
  // source reported this run at all, which okOnly's blanking already erases.
  const observable = observableSources(snapshot);
  // Pruned with every live alert, held ones included, so a hold never forgets a key.
  const alreadySent = prune((await readSent()) ?? {}, alerts, observable);
  // A held alert gets no push and no event this pass (self-healing loop 1).
  const held = heldAlerts(alerts, alreadySent, now);
  const told = held.size ? alerts.filter(a => !held.has(a.key)) : alerts;
  let eventsOut = null;
  if (events) {
    try {
      eventsOut = await events(told, { observable });
    } catch (err) {
      log(`events: the pass failed (${err?.message ?? err})`);
      eventsOut = { error: true };
    }
  }
  const unsentKeys = new Set(newKeys(alerts, alreadySent));

  let sent = 0, skipped = 0;
  for (const entry of pushableFrom(told)) {
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
  return { alerts: alerts.length, sent, skipped, ...(held.size ? { held: held.size } : {}), ...(eventsOut ? { events: eventsOut } : {}) };
}
