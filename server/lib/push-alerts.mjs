import { KIND as LIMIT_STEP, ruleFor, keyParts, resetLabels, NO_RESET_KEEP_MS } from './limit-warnings.mjs';

// What may leave this machine, and what may not.
//
// The ntfy topic is the only access control on the free tier — anyone who knows
// it can read it — and the body transits a third party. So redaction is decided
// per SOURCE, not per message: usage figures are the user's own and go out in
// full, but cron identifiers come from launchd and include jobs belonging to a
// private repo. Those never leave; a count is enough to know whether to look.
// An ALLOWLIST, deliberately. A denylist would send full text for any kind that
// is missing, misspelled, or added later by someone who has not read this — so
// the failure mode of a future mistake would be disclosure to a third party.
// Anything not named here is counted, never quoted. The board's alert is built
// from two numbers alone (lib/alerts.mjs), so its percent can go out as written.
const DISCLOSED_KINDS = new Set(['limit', 'projection', 'credits', 'board']);

// How a count of each counted kind is said: "1 job failed", "2 services are
// down". Any other kind is an item that needs attention. Each kind goes out as
// its own message, so a new failure of one kind doesn't repeat the others.
const COUNT_WORDS = {
  cron: n => `${n} job${n === 1 ? '' : 's'} failed`,
  service: n => `${n} service${n === 1 ? ' is' : 's are'} down`,
  'needs-you': n => `${n} session${n === 1 ? ' is' : 's are'} waiting on you`
};
const anyOther = n => `${n} item${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} attention`;

export function pushableFrom(alerts) {
  const keyed = (alerts ?? []).filter(a => typeof a?.key === 'string' && a.key);
  const out = [];

  for (const a of keyed.filter(a => DISCLOSED_KINDS.has(a.kind))) {
    // A limit with warning steps of its own (lib/limit-warnings.mjs) is told by
    // those, not by the alert bar's threshold: one limit, one line of messages.
    if (a.kind === 'limit' && a.key.startsWith('limit:') && ruleFor(a.key.slice('limit:'.length))) continue;
    out.push({ keys: [a.key], title: 'Control Room', message: a.text });
  }

  // A limit warning: its words are the usage panel's own numbers, so they go out as
  // written, and to the paired devices too (`devices`; collectors/notifier.mjs). It
  // carries the keys of the steps it has passed, so each is told once.
  for (const a of keyed.filter(a => a.kind === LIMIT_STEP)) {
    const covers = (Array.isArray(a.covers) ? a.covers : []).filter(k => typeof k === 'string' && k);
    out.push({ keys: [a.key, ...covers], title: 'Control Room', message: a.text, devices: true });
  }

  const groups = new Map();
  for (const a of keyed.filter(a => !DISCLOSED_KINDS.has(a.kind) && a.kind !== LIMIT_STEP)) {
    const group = Object.hasOwn(COUNT_WORDS, a.kind) ? a.kind : 'other';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(a.key);
  }
  for (const [group, keys] of groups) {
    const words = group === 'other' ? anyOther(keys.length) : COUNT_WORDS[group](keys.length);
    out.push({ keys, title: 'Control Room', message: `${words} — open the dashboard for detail` });
  }
  return out;
}

export function newKeys(alerts, alreadySent) {
  return (alerts ?? [])
    .map(a => a?.key)
    .filter(k => typeof k === 'string' && k && !(k in (alreadySent ?? {})));
}

// Which sources we can actually see this run, as the key prefixes they own. A
// key may only be forgotten if we could have observed its condition — otherwise
// a cold start, where the slow `/usage` collector has not written yet, looks
// identical to every alert having cleared, and the whole notified set is wiped
// and re-pushed. Per SOURCE, not per kind: launchd and the ingest poster both
// produce `cron` alerts, and one being readable says nothing about the other.
export function observableSources(snapshot) {
  const status = k => snapshot?.[k]?.status;
  const ok = k => status(k) === 'ok';
  return new Set([
    ...(ok('usage') ? ['limit', 'projection', LIMIT_STEP] : []),
    ...(ok('crons') ? ['cron:launchd'] : []),
    ...(ok('ingestCrons') ? ['cron:ingest'] : []),
    ...(ok('board') ? ['board'] : []),
    ...(ok('health') ? ['service'] : []),
    // The waits live in this server's own memory (lib/needs-you.mjs), so they are
    // always observable: a wait that is gone has been cleared or has lapsed.
    'needs-you',
    // Credits alerts read the ingested feed when it is current and fall back
    // to config (loaded at startup, always readable) otherwise. So the source
    // is observable when the feed is current or was never posted — but a
    // STALE feed means whatever drove the alert has gone quiet, and absence of
    // the alert is not evidence it cleared.
    ...(status('ingestCredits') === 'stale' || status('accountCredits') === 'stale' ? [] : ['credits'])
  ]);
}

const ownedBy = (key, prefixes) => {
  const k = String(key);
  for (const p of prefixes) if (k === p || k.startsWith(p + ':')) return true;
  return false;
};

// A condition that has cleared is forgotten, so that if it returns it notifies
// again — without this, one 88% week would silence that limit forever. But a
// key whose SOURCE is not observable right now is kept, because absence of
// evidence is not evidence the condition cleared.
// With `now` (the notifier gives it), a limit warning's key is also kept until its
// window's reset has passed: a step is told once per window, even when a reading dips
// under it and comes back, or the limit moves on to its next step. A key with no reset
// in it is kept for a fixed time after it was told (its value), so it can't flap.
// Either kind is kept only until its limit is read well under every step (`limits`,
// the usage panel's readings now, under RESET_BELOW_PCT): the limit has been reset,
// at its printed time or before it (2026-10-19: a weekly limit went from 93% to 0%
// eight and a half hours early), and that is a new window, whose warning the old key
// must not hide. `limits` is this pass's reading and nothing else: the notifier gives
// the panel only while it is current, and the history store is never asked, so an
// old low reading forgets nothing. A key that is live now is never forgotten.
// `onReset` (optional) is given the label of each limit whose told keys this rule
// forgot and nothing else would have (once per label a pass), for the service log
// (Ultron's 11-18 low a): a forgotten key can warn again, and the log says why.
export function prune(alreadySent, alerts, observable, now = null, limits = null, onReset = null) {
  const live = new Set((alerts ?? []).map(a => a?.key));
  const prefixes = [...(observable ?? [])];
  const reset = resetLabels(limits);
  const forgot = new Set();
  const out = {};
  for (const [k, v] of Object.entries(alreadySent ?? {})) {
    const warning = Number.isFinite(now) ? keyParts(k) : null;
    const inWindow = warning !== null
      && (warning.window !== null ? now < warning.window : Number.isFinite(v) && now - v < NO_RESET_KEEP_MS);
    const stays = inWindow && !reset.has(warning.label);
    if (live.has(k) || !ownedBy(k, prefixes) || stays) out[k] = v;
    else if (inWindow) forgot.add(warning.label);
  }
  if (typeof onReset === 'function') for (const label of forgot) onReset(label);
  return out;
}
