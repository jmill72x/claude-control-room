const DAY = 24 * 3600 * 1000;

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
  for (const cron of [...listOf(snapshot.crons), ...listOf(snapshot.ingestCrons)]) {
    if (cron?.ok === false) {
      alerts.push({
        text: `${cron.name} cron ${cron.last ?? 'failed'}`,
        kind: 'cron',
        key: `cron:${cron.label ?? cron.name}`
      });
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

  // Ingested credits outrank config credits on the page, so they must outrank
  // them here too — otherwise the promo expiry warning is computed from figures
  // nobody is looking at.
  const ingested = snapshot.ingestCredits?.data;
  const credits = (ingested && typeof ingested === 'object' && !Array.isArray(ingested))
    ? ingested
    : config.credits;
  if (credits?.promoExpiresOn) {
    const expires = Date.parse(credits.promoExpiresOn);
    if (Number.isFinite(expires) && expires - now < 30 * DAY) {
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
