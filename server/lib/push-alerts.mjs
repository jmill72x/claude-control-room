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
// Anything not named here is counted, never quoted.
const DISCLOSED_KINDS = new Set(['limit', 'projection', 'credits']);

export function pushableFrom(alerts) {
  const keyed = (alerts ?? []).filter(a => typeof a?.key === 'string' && a.key);
  const out = [];

  for (const a of keyed.filter(a => DISCLOSED_KINDS.has(a.kind))) {
    out.push({ keys: [a.key], title: 'Control Room', message: a.text });
  }

  const counted = keyed.filter(a => !DISCLOSED_KINDS.has(a.kind));
  if (counted.length > 0) {
    out.push({
      keys: counted.map(a => a.key),
      title: 'Control Room',
      message: `${counted.length} item${counted.length === 1 ? '' : 's'} need${counted.length === 1 ? 's' : ''} attention — open the dashboard for detail`
    });
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
    ...(ok('usage') ? ['limit', 'projection'] : []),
    ...(ok('crons') ? ['cron:launchd'] : []),
    ...(ok('ingestCrons') ? ['cron:ingest'] : []),
    // Credits alerts read the ingested feed when it is current and fall back
    // to config (loaded at startup, always readable) otherwise. So the source
    // is observable when the feed is current or was never posted — but a
    // STALE feed means whatever drove the alert has gone quiet, and absence of
    // the alert is not evidence it cleared.
    ...(status('ingestCredits') === 'stale' ? [] : ['credits'])
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
export function prune(alreadySent, alerts, observable) {
  const live = new Set((alerts ?? []).map(a => a?.key));
  const prefixes = [...(observable ?? [])];
  const out = {};
  for (const [k, v] of Object.entries(alreadySent ?? {})) {
    if (live.has(k) || !ownedBy(k, prefixes)) out[k] = v;
  }
  return out;
}
