const DAY = 24 * 3600 * 1000;
// Three quarters of the board's save cap.
export const BOARD_WARN_SHARE = 0.75;
// How long a service must stay down before it raises an alert: long enough
// that a restart (launchd brings a KeepAlive job back within seconds, and the
// lead's session has a weekly restart of its own) never does.
export const SERVICE_DOWN_ALERT_MS = 5 * 60 * 1000;

const listOf = envelope => (Array.isArray(envelope?.data) ? envelope.data : []);

// `key` names the alert's SUBJECT, not its wording. A limit's text moves with
// its percentage ("at 86%" -> "at 87%"), so a text-keyed dedup would push a
// fresh notification every poll for one continuous condition.
export function buildAlerts(snapshot, config, now = Date.now()) {
  const alerts = [];
  const threshold = config.warnThreshold ?? 85;

  // Ingested crons are exactly the ones nobody is watching — they run on Claude
  // Cloud, not on this machine, and reporting in here is the only way their
  // failure is ever seen. Reading `snapshot.crons` alone meant an ingested cron
  // could report ok:false and raise nothing, while the page merged both feeds
  // for display. Spec §6: any cron with a non-zero exit raises an alert.
  // The key names the SOURCE too. The notifier may forget a key only when it
  // could observe that key's source this run, and launchd being readable says
  // nothing about the ingest poster — a bare `cron:label` could not tell the
  // two apart, so an ingested job's key was forgotten on every poster gap and
  // the same failure re-pushed each time the poster came back.
  const cronSources = [['launchd', listOf(snapshot.crons)], ['ingest', listOf(snapshot.ingestCrons)]];
  for (const [source, crons] of cronSources) {
    for (const cron of crons) {
      if (cron?.ok === false) {
        alerts.push({
          text: `${cron.name} cron ${cron.last ?? 'failed'}`,
          kind: 'cron',
          key: `cron:${source}:${cron.label ?? cron.name}`
        });
      }
    }
  }

  for (const limit of snapshot.usage?.data?.limits ?? []) {
    if (limit.pct >= threshold) {
      alerts.push({
        text: `${limit.label} at ${limit.pct}%`,
        kind: 'limit',
        key: `limit:${limit.label}`
      });
    }
  }

  // Pace complements the threshold rule rather than replacing it: 85% tells you
  // that you are nearly out, a projection tells you while you can still act.
  for (const limit of snapshot.usage?.data?.limits ?? []) {
    const projected = limit?.pace?.projectedPct;
    if (Number.isFinite(projected) && projected > 100) {
      alerts.push({
        text: `${limit.label} projected to reach ${projected}% by reset`,
        kind: 'projection',
        key: `projection:${limit.label}`
      });
    }
  }

  // The board's size against its save cap (routes.mjs, BOARD_MAX_BODY). A PUT
  // past the cap is refused whole, so this warns while there is room to act,
  // such as archiving the done lane. Only the percent is said, never an item.
  // Before the credits rules, which return early.
  const board = snapshot.board?.data;
  if (Number.isFinite(board?.bytes) && Number.isFinite(board?.cap) && board.cap > 0) {
    const share = board.bytes / board.cap;
    if (share >= BOARD_WARN_SHARE) {
      alerts.push({
        text: `The board is at ${Math.round(share * 100)}% of its save limit`,
        kind: 'board',
        key: 'board:size'
      });
    }
  }

  // An always-on service that has been down for five minutes (the health
  // strip, lib/health.mjs): the lead's session or a KeepAlive job. Never the
  // Pi, whose watch pages on every change itself, and never this server, which
  // can't report itself down. Before the credits rules, which return early.
  for (const s of snapshot.health?.data?.services ?? []) {
    if ((s?.kind === 'session' || s?.kind === 'launchd') && s.state === 'down' &&
        Number.isFinite(s.downSince) && now - s.downSince >= SERVICE_DOWN_ALERT_MS) {
      alerts.push({ text: `${s.name} is not running`, kind: 'service', key: `service:${s.key}` });
    }
  }

  // Automatic credits — read from the CLI's own cached usage response — outrank
  // everything hand-entered, on the page and here. While they are readable the
  // config/ingest rules below do not run at all: their figures are superseded,
  // and warning from them is exactly how an expired promo kept alerting.
  const account = snapshot.accountCredits?.data;
  if (account && Array.isArray(account.grants)) {
    for (const g of account.grants) {
      const expires = Date.parse(g?.expiresAt);
      if (!Number.isFinite(expires) || expires <= now || expires - now > 7 * DAY) continue;
      if (!(typeof g.remaining === 'number' && g.remaining > 0)) continue;
      const days = Math.max(1, Math.ceil((expires - now) / DAY));
      alerts.push({
        text: `${g.label}: $${g.remaining.toFixed(2)} left, expires in ${days} day${days === 1 ? '' : 's'}`,
        kind: 'credits',
        key: `credits:grant:${g.id}`
      });
    }
    return alerts;
  }

  // Ingested credits outrank config credits on the page, so they must outrank
  // them here too — otherwise the promo expiry warning is computed from figures
  // nobody is looking at.
  const ingested = snapshot.ingestCredits?.data;
  const credits = (ingested && typeof ingested === 'object' && !Array.isArray(ingested))
    ? ingested
    : config.credits;
  if (credits?.promoExpiresOn) {
    const expires = Date.parse(credits.promoExpiresOn);
    // `expires - now < 30 days` was also true for every date in the PAST, so an
    // expired promo warned "expires in 0 days" forever.
    if (Number.isFinite(expires) && expires > now && expires - now < 30 * DAY) {
      const days = Math.max(0, Math.round((expires - now) / DAY));
      alerts.push({
        text: `Promotional credit expires in ${days} days`,
        kind: 'credits',
        key: 'credits:promo'
      });
    }
  }
  if (credits?.updatedAt) {
    const updated = Date.parse(credits.updatedAt);
    if (Number.isFinite(updated) && now - updated > 14 * DAY) {
      alerts.push({
        text: 'Credits figures are over 14 days old',
        kind: 'credits',
        key: 'credits:stale'
      });
    }
  }
  return alerts;
}
