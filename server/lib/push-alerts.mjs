// What may leave this machine, and what may not.
//
// The ntfy topic is the only access control on the free tier — anyone who knows
// it can read it — and the body transits a third party. So redaction is decided
// per SOURCE, not per message: usage figures are the user's own and go out in
// full, but cron identifiers come from launchd and include jobs belonging to a
// private repo. Those never leave; a count is enough to know whether to look.
const REDACTED_KINDS = new Set(['cron']);

export function pushableFrom(alerts) {
  const keyed = (alerts ?? []).filter(a => typeof a?.key === 'string' && a.key);
  const out = [];

  for (const a of keyed.filter(a => !REDACTED_KINDS.has(a.kind))) {
    out.push({ keys: [a.key], title: 'Control Room', message: a.text });
  }

  const crons = keyed.filter(a => REDACTED_KINDS.has(a.kind));
  if (crons.length > 0) {
    out.push({
      keys: crons.map(a => a.key),
      title: 'Control Room',
      message: `${crons.length} scheduled job${crons.length === 1 ? '' : 's'} failed — open the dashboard for detail`
    });
  }
  return out;
}

export function newKeys(alerts, alreadySent) {
  return (alerts ?? [])
    .map(a => a?.key)
    .filter(k => typeof k === 'string' && k && !(k in (alreadySent ?? {})));
}

// A condition that has cleared is forgotten, so that if it returns it notifies
// again. Without this, one 88% week would silence that limit forever.
export function prune(alreadySent, alerts) {
  const live = new Set((alerts ?? []).map(a => a?.key));
  const out = {};
  for (const [k, v] of Object.entries(alreadySent ?? {})) if (live.has(k)) out[k] = v;
  return out;
}
