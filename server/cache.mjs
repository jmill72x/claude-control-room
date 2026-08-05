const DEFAULT_BUDGETS = {
  usage: 15 * 60 * 1000,
  sessions: 5 * 60 * 1000,
  agents: 3 * 60 * 1000,
  crons: 5 * 60 * 1000
};
const FALLBACK_BUDGET = 5 * 60 * 1000;

export function createCache({ budgets = {} } = {}) {
  const store = new Map();
  const budgetFor = key => budgets[key] ?? DEFAULT_BUDGETS[key] ?? FALLBACK_BUDGET;

  return {
    set(key, data, now = Date.now()) {
      store.set(key, { data, fetchedAt: now, error: null });
    },
    fail(key, error, now = Date.now()) {
      const prev = store.get(key);
      store.set(key, {
        data: prev?.data ?? null,
        fetchedAt: prev?.fetchedAt ?? null,
        error: String(error?.message ?? error),
        failedAt: now
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
