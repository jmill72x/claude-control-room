import { buildAlerts } from '../lib/alerts.mjs';
import { pushableFrom, newKeys, prune, observableSources } from '../lib/push-alerts.mjs';
import { applyAcks } from '../lib/acks.mjs';
import { limitWarnings, keyParts, mayTell, ruleFor, backFrom, fullNow, DAY_MS, DEVICE_RETRIES, DEVICE_RETRY_GAP_MS, RESET_BELOW_PCT, FULL_STEP, BACK_TEXT } from '../lib/limit-warnings.mjs';
import { oneLine } from '../lib/chat-events.mjs';

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
// unless their key was pushed before, or is in the events ledger (`eventKnown`, Ultron's
// L4, 11-13: the lead was told, though the push may not have gone): someone already
// knows of those, and holding one would only make the event hook forget it and wake
// Jarvis again once the hold ends.
export function heldAlerts(alerts, alreadySent, now, eventKnown = () => false) {
  const known = key => { try { return eventKnown(key) === true; } catch { return false; } };
  return new Set((alerts ?? [])
    .filter(a => Number.isFinite(a?.holdUntil) && a.holdUntil > now && !Object.hasOwn(alreadySent ?? {}, a.key) && !known(a.key))
    .map(a => a.key));
}

// A device id as limitWarning names one it missed (lib/chat-devices.mjs writes 16 hex).
const isDeviceId = id => typeof id === 'string' && /^[0-9a-f]{1,64}$/.test(id);
// What limitWarning answered, as counts and ids only; anything else is "none tried".
const deviceLeg = r => ({
  tried: Number.isInteger(r?.tried) && r.tried > 0 ? r.tried : 0,
  reached: Number.isInteger(r?.reached) && r.reached > 0 ? r.reached : 0,
  missed: Array.isArray(r?.missed) ? r.missed.filter(isDeviceId) : []
});

// The server's `send`: every entry goes out as an alert (`alert`: ntfy and #pepper,
// notify.mjs), and a limit warning (`entry.devices`, lib/push-alerts.mjs) goes first
// to the paired devices as a Web Push (`devices`: lib/chat-push.mjs's limitWarning,
// absent while the chat is off). Landing anywhere counts as sent, by sendAlert's own
// rule: a channel that is down must not make every run repeat it on one that works.
// Neither half's failure skips the other. The device leg is reported on its own
// (`devices: { tried, reached, missed }`, and `failed` when the call itself threw), so
// runNotifier can try again the devices a warning missed. That later try is an entry
// with `devicesOnly`: to the devices in `only` (all of them when null), and no alert.
export const entrySender = ({ alert, devices = null, log = console.error }) => async entry => {
  let leg = deviceLeg(null);
  if (entry?.devices && devices) {
    try {
      leg = deviceLeg(await devices(entry.message, { only: Array.isArray(entry.only) ? entry.only : null }));
    } catch (err) {
      log(`push: a limit warning failed (${err?.message ?? err})`);
      leg = { ...leg, failed: true };
    }
  }
  if (entry?.devicesOnly) return { sent: leg.reached > 0, devices: leg };
  let result;
  try { result = await alert(entry); } catch (err) { result = { sent: false, reason: err?.message ?? String(err) }; }
  return entry?.devices ? { ...result, sent: Boolean(result?.sent || leg.reached > 0), devices: leg } : result;
};

// What the notifier keeps about limit warnings beside the told keys, in the same file
// under this one name (no alert's key: every key has a colon): `told`, the tellings of
// the last 24 hours (`{ at, label, step }`, for the caps in lib/limit-warnings.mjs),
// and `owed`, by warning key, the devices a told warning has not reached yet
// (`{ passes, missed, at }`: the tries made since the telling, the devices, `null` for
// every one, and when the last try or the telling was; a file that has no time there,
// or one still ahead, is read as `at: 0`, long ago, so its next try is due).
// Since 2026-11-20 also `out`, by label, the limits told full and not yet read reset
// (`{ win, at }`, lib/limit-warnings.mjs's backFrom), and `back`, what the back line
// still owes the devices (a debt as in `owed`), or null.
export const LIMIT_STATE = 'limit-step-state';
const readDebt = (debt, now) => (!Number.isInteger(debt?.passes) || debt.passes < 0 || debt.passes >= DEVICE_RETRIES ? null
  : { passes: debt.passes, missed: Array.isArray(debt.missed) ? debt.missed.filter(isDeviceId) : null, at: Number.isFinite(debt.at) && debt.at <= now ? debt.at : 0 });
export function readLimitState(raw, now) {
  const told = (Array.isArray(raw?.told) ? raw.told : [])
    .filter(t => typeof t?.label === 'string' && Number.isInteger(t.step) && Number.isFinite(t.at) && t.at <= now && now - t.at < DAY_MS)
    .map(t => ({ at: t.at, label: t.label, step: t.step }));
  const owed = {};
  // Whatever `owed` is, only an entry under a warning's key with a count is read.
  for (const [key, debt] of Object.entries(raw?.owed ?? {})) {
    const read = keyParts(key) ? readDebt(debt, now) : null;
    if (read) owed[key] = read;
  }
  // Only a limit that has a full line, told at a time that has come, with a window that
  // is a time or none.
  const out = {};
  for (const [label, o] of Object.entries(raw?.out ?? {})) {
    if (!ruleFor(label)?.full || !Number.isFinite(o?.at) || o.at > now || !(o.win === null || Number.isFinite(o.win))) continue;
    out[label] = { win: o.win, at: o.at };
  }
  return { told, owed, out, back: readDebt(raw?.back, now) };
}
// What a send left owing to the devices: the ids it missed, null for all of them (the
// call threw), or nothing.
const owedAfter = result => (result?.devices?.failed ? { missed: null }
  : Array.isArray(result?.devices?.missed) && result.devices.missed.length > 0 ? { missed: result.devices.missed } : null);

// One later try of a debt to the devices (a told warning's, or the back line's): the
// entry again, to the devices it missed only, with no alert. The debt after it, or null
// when nothing is owed any more; the last failed try is logged.
async function retryDevices(send, entry, debt, now, log) {
  let again;
  try { again = await send({ ...entry, devicesOnly: true, only: debt.missed }); } catch { again = { devices: { failed: true } }; }
  const still = owedAfter(again);
  if (still && debt.passes + 1 < DEVICE_RETRIES) return { passes: debt.passes + 1, missed: still.missed ?? debt.missed, at: now };
  if (still) log(`push: a limit warning did not reach every device in ${DEVICE_RETRIES} more tries; no more are made`);
  return null;
}

// `events` (optional): `(alerts, { observable }) => Promise`, the event
// hook (lib/events.mjs), given the alerts after acks. It keeps a ledger of its own and
// runs in its own try, so a failed push and a failed event never block each other.
// `eventKnown(key)` (optional): whether that hook's ledger already has the key.
// `limitReset` (optional): `() => Promise<{ status }>`, the lead's "limit reset" event
// (lib/events.mjs), called once when every limit told full has reset.
export async function runNotifier({ snapshot, config, now, readSent, writeSent, send, acks = [], events = null, eventKnown = () => false, limitReset = null, log = console.error }) {
  // An acknowledged alert (lib/acks.mjs) is not pushed. Its key is then forgotten
  // by the rule below, so when the ack lapses with the condition still live, the
  // alert is new again and pushed again: an expiry re-notifies, which is its job.
  // The limit warnings (lib/limit-warnings.mjs) join here and not in buildAlerts: the
  // page's alert bar already has its `limit` line, and these are for the push.
  const current = okOnly(snapshot);
  const raised = [...buildAlerts(current, config ?? {}, now), ...limitWarnings(current.usage?.data?.limits, now)];
  const { alerts } = applyAcks(raised, acks, now);
  // The raw snapshot, not okOnly(snapshot): observability is about whether a
  // source reported this run at all, which okOnly's blanking already erases.
  const observable = observableSources(snapshot);
  // Pruned with every live alert, held ones included, so a hold never forgets a key.
  const { [LIMIT_STATE]: rawLimitState, ...sentKeys } = (await readSent()) ?? {};
  // A limit read under the reset mark forgets its told warnings (one line a limit, its
  // label alone, so the log says why the next warning came early).
  const alreadySent = prune(sentKeys, alerts, observable, now, current.usage?.data?.limits,
    label => log(`push: ${oneLine(label, 80)} read under ${RESET_BELOW_PCT}%; its told warnings are forgotten`));
  // A device debt lasts as long as its warning's key: until the window resets.
  const limitState = readLimitState(rawLimitState, now);
  for (const key of Object.keys(limitState.owed)) if (!Object.hasOwn(alreadySent, key)) delete limitState.owed[key];
  // A held alert gets no push and no event this pass (self-healing loop 1).
  const held = heldAlerts(alerts, alreadySent, now, eventKnown);
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

  let sent = 0, skipped = 0, capped = 0, retried = 0;
  for (const entry of pushableFrom(told)) {
    // A limit warning (`entry.devices`): its key says which limit and step it is.
    const warning = entry.devices ? keyParts(entry.keys[0]) : null;
    // A grouped cron entry carries several keys; it is new if ANY of them is.
    if (!entry.keys.some(k => unsentKeys.has(k))) {
      // Told already. If it missed a device then, that device alone is tried again,
      // with no second alert, up to DEVICE_RETRIES times, each at least
      // DEVICE_RETRY_GAP_MS after the one before: a pass sooner than that leaves it.
      const debt = warning ? limitState.owed[entry.keys[0]] : null;
      if (!debt || now - debt.at < DEVICE_RETRY_GAP_MS) { skipped++; continue; }
      const next = await retryDevices(send, entry, debt, now, log);
      retried++;
      if (next) limitState.owed[entry.keys[0]] = next;
      else delete limitState.owed[entry.keys[0]];
      continue;
    }
    // The backstop: over a cap, a warning waits for a pass that has room.
    if (warning && !mayTell(limitState.told, warning, now)) { capped++; continue; }
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
      if (warning) {
        limitState.told.push({ at: now, label: warning.label, step: warning.step });
        // What the steps under this one still owed is dropped: this telling says more,
        // and a later try of a lower step would arrive after it, saying less. (Its own
        // key owes nothing yet: a debt never outlives its told key.)
        for (const k of entry.keys) delete limitState.owed[k];
        const owes = owedAfter(result);
        if (owes) limitState.owed[entry.keys[0]] = { passes: 0, missed: owes.missed, at: now };
        // The full line: the lead is out until this limit resets. What an earlier back
        // line still owed the devices is dropped: it would now say something untrue.
        if (warning.step === FULL_STEP) {
          limitState.out[warning.label] = { win: warning.window, at: now };
          limitState.back = null;
        }
      }
    }
  }

  // Back under the limit: once every limit told full has reset (lib/limit-warnings.mjs,
  // backFrom), read from this pass's current panel only, one fixed line to the devices
  // (no ntfy and no #pepper: the full line's #jarvis post is the record) and one event
  // to the lead. A panel that is not current has no readings here (okOnly), so it says
  // nothing either way.
  let back = 0;
  const backEntry = { keys: [], title: 'Control Room', message: BACK_TEXT, devices: true };
  if (limitState.back && now - limitState.back.at >= DEVICE_RETRY_GAP_MS) {
    limitState.back = await retryDevices(send, backEntry, limitState.back, now, log);
    retried++;
  }
  if (Object.keys(limitState.out).length > 0) {
    const limits = current.usage?.data?.limits;
    const { still, back: turned, dropped } = backFrom(limitState.out, limits, now);
    for (const label of dropped) log(`push: ${oneLine(label, 80)} was told full more than eight days ago and never read reset; no back line for it`);
    // A limit read full now (its own full line not told yet, say) keeps everyone out:
    // the limits that turned stay out, to be back with it.
    const blocked = fullNow(limits);
    limitState.out = blocked ? Object.fromEntries(Object.entries(limitState.out).filter(([label]) => !dropped.includes(label))) : still;
    if (turned.length > 0 && Object.keys(still).length === 0 && !blocked) {
      back = 1;
      let result;
      try { result = await send({ ...backEntry, devicesOnly: true, only: null }); } catch { result = { devices: { failed: true } }; }
      const owes = owedAfter(result);
      limitState.back = owes ? { passes: 0, missed: owes.missed, at: now } : null;
      let lead = 'none';
      if (limitReset) {
        try { lead = (await limitReset())?.status ?? 'unknown'; } catch (err) { lead = 'failed'; log(`events: the limit-reset event failed (${err?.message ?? err})`); }
      }
      const d = result?.devices ?? {};
      log(`push: back under the limit; the line went to ${Number.isInteger(d.reached) ? d.reached : 0} of ${Number.isInteger(d.tried) ? d.tried : 0} devices${d.failed ? ' (the push failed)' : ''}, the lead's event: ${lead}`);
    }
  }

  const keepState = limitState.told.length > 0 || Object.keys(limitState.owed).length > 0
    || Object.keys(limitState.out).length > 0 || limitState.back !== null;
  await writeSent(keepState ? { ...alreadySent, [LIMIT_STATE]: limitState } : alreadySent);
  return {
    alerts: alerts.length, sent, skipped,
    ...(capped ? { capped } : {}), ...(retried ? { retried } : {}), ...(back ? { back } : {}),
    ...(held.size ? { held: held.size } : {}), ...(eventsOut ? { events: eventsOut } : {})
  };
}
