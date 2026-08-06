const DAY = 24 * 3600 * 1000;

const listOf = envelope => (Array.isArray(envelope?.data) ? envelope.data : []);

export function buildAlerts(snapshot, config, now = Date.now()) {
  const alerts = [];
  const threshold = config.warnThreshold ?? 85;

  // Ingested crons are exactly the ones nobody is watching — they run on Claude
  // Cloud, not on this machine, and reporting in here is the only way their
  // failure is ever seen. Reading `snapshot.crons` alone meant an ingested cron
  // could report ok:false and raise nothing, while the page merged both feeds
  // for display. Spec §6: any cron with a non-zero exit raises an alert.
  for (const cron of [...listOf(snapshot.crons), ...listOf(snapshot.ingestCrons)]) {
    if (cron?.ok === false) alerts.push({ text: `${cron.name} cron ${cron.last ?? 'failed'}` });
  }

  for (const limit of snapshot.usage?.data?.limits ?? []) {
    if (limit.pct >= threshold) alerts.push({ text: `${limit.label} at ${limit.pct}%` });
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
      alerts.push({ text: `Promotional credit expires in ${days} days` });
    }
  }
  if (credits?.updatedAt) {
    const updated = Date.parse(credits.updatedAt);
    if (Number.isFinite(updated) && now - updated > 14 * DAY) {
      alerts.push({ text: 'Credits figures are over 14 days old' });
    }
  }
  return alerts;
}
