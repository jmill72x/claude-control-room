// Credits used to be hand-typed into config.json, so they went stale the day
// they were entered — the dashboard kept showing a promotional credit that had
// already expired. The real figures do exist on this machine: every
// `claude -p "/usage"` (which the usage collector runs every five minutes)
// refreshes `cachedUsageUtilization` in ~/.claude.json with the account's full
// usage response, dollar-denominated credit buckets included. That cache is
// undocumented and its bucket names are internal codenames, so this parser is
// deliberately generic: any bucket carrying a dollar limit is a grant, known
// codenames get the name claude.ai shows for them, and anything else is shown
// under a neutral label rather than a guessed one.

export const MAX_CACHE_AGE_MS = 30 * 60 * 1000;

// Verified against claude.ai/settings/usage on 2026-09-28.
const LABELS = {
  iguana_necktie: 'Cloud session credits',
  omelette_promotional: 'Promotional credit'
};

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const money = v => {
  if (num(v) !== null) return v;
  if (v && typeof v === 'object' && num(v.amount_minor) !== null) {
    return v.amount_minor / 10 ** (num(v.exponent) ?? 2);
  }
  return null;
};

export function parseAccountCredits(state, now = Date.now()) {
  const cache = state?.cachedUsageUtilization;
  if (!cache || typeof cache !== 'object' || !cache.utilization) {
    throw new Error('no cached usage response in ~/.claude.json');
  }
  const asOf = num(cache.fetchedAtMs);
  if (asOf === null || now - asOf > MAX_CACHE_AGE_MS) {
    throw new Error('cached usage response is older than 30 minutes — the /usage poll is not refreshing it');
  }

  const grants = [];
  for (const [id, b] of Object.entries(cache.utilization)) {
    if (!b || typeof b !== 'object' || num(b.limit_dollars) === null) continue;
    grants.push({
      id,
      label: LABELS[id] ?? 'Included credit',
      limit: b.limit_dollars,
      used: num(b.used_dollars),
      remaining: num(b.remaining_dollars),
      expiresAt: typeof b.resets_at === 'string' ? b.resets_at : null
    });
  }

  const spend = cache.utilization.spend;
  return {
    asOf,
    grants,
    usageCredits: { balance: money(spend?.balance), enabled: spend?.enabled === true }
  };
}
