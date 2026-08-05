const DAY = 24 * 3600 * 1000;

export function buildAlerts(snapshot, config, now = Date.now()) {
  const alerts = [];
  const threshold = config.warnThreshold ?? 85;

  for (const cron of snapshot.crons?.data ?? []) {
    if (cron.ok === false) alerts.push({ text: `${cron.name} cron ${cron.last ?? 'failed'}` });
  }

  for (const limit of snapshot.usage?.data?.limits ?? []) {
    if (limit.pct >= threshold) alerts.push({ text: `${limit.label} at ${limit.pct}%` });
  }

  const credits = config.credits;
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
