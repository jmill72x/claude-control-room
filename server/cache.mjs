const DEFAULT_BUDGETS = {
  usage: 15 * 60 * 1000,
  sessions: 5 * 60 * 1000,
  agents: 3 * 60 * 1000,
  crons: 5 * 60 * 1000
};
const FALLBACK_BUDGET = 5 * 60 * 1000;

// A collector's own interval is never the right staleness budget by itself:
// budgeting at exactly the interval would flip a panel to stale the instant a
// single run runs a little long or gets skipped once, even though the data
// is only one cycle old and still trustworthy. 2x the interval means one
// missed run is absorbed silently and it takes two consecutive misses to
// actually surface as stale — that's the signal worth showing the user.
const INTERVAL_BUDGET_MULTIPLIER = 2;

export function createCache({ budgets = {} } = {}) {
  const store = new Map();
  // Populated by the registry at register() time — one entry per collector,
  // derived from that collector's own interval. Explicit `budgets` (above)
  // always wins over this; this in turn wins over DEFAULT_BUDGETS/FALLBACK_BUDGET,
  // which only apply to keys nothing ever registered a collector for (e.g.
  // the ingest* keys, written by HTTP POST rather than a timer).
  const derivedBudgets = {};
  const budgetFor = key => budgets[key] ?? derivedBudgets[key] ?? DEFAULT_BUDGETS[key] ?? FALLBACK_BUDGET;

  return {
    // Called by createRegistry() when a collector registers with an
    // interval, so the cache's staleness budget for that key can never be
    // shorter than the interval the data is actually produced on.
    deriveBudgetFromInterval(key, intervalMs) {
      derivedBudgets[key] = intervalMs * INTERVAL_BUDGET_MULTIPLIER;
    },
    set(key, data, now = Date.now()) {
      store.set(key, { data, fetchedAt: now, error: null });
    },
    fail(key, error, now = Date.now()) {
      const prev = store.get(key);
      store.set(key, {
        data: prev?.data ?? null,
        fetchedAt: prev?.fetchedAt ?? null,
        error: String(error?.message ?? error)
      });
    },
    get(key, now = Date.now()) {
      const entry = store.get(key);
      if (!entry || entry.data === null) {
        return { data: null, fetchedAt: entry?.fetchedAt ?? null, status: 'unavailable', error: entry?.error ?? null };
      }
      const aged = now - entry.fetchedAt > budgetFor(key);
      const status = entry.error || aged ? 'stale' : 'ok';
      return { data: entry.data, fetchedAt: entry.fetchedAt, status, error: entry.error };
    },
    snapshot(now = Date.now()) {
      const out = {};
      for (const key of store.keys()) out[key] = this.get(key, now);
      return out;
    }
  };
}
