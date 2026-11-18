export function createRegistry(cache, timers = { setInterval, clearInterval }) {
  const collectors = new Map();
  const handles = [];
  // The first pass (self-healing loop 3, lib/heal-restart.mjs): every collector's first
  // run since startAll, and which of them failed. A restarted server is checked by it.
  const firstPending = new Set();
  const firstFailed = [];
  let resolveFirst;
  const firstPass = new Promise(resolve => { resolveFirst = resolve; });

  return {
    // `then` names a collector to run once right after each run of this one that
    // succeeded (the notifier after the usage poll, so a new reading is acted on at
    // once and not at the notifier's own next tick). It is not waited for, and is
    // skipped like any run while that collector is already running.
    register(name, fn, intervalMs, { then = null } = {}) {
      collectors.set(name, { fn, intervalMs, running: false, then });
      // Tell the cache what this collector's own interval is so its
      // staleness budget can never be shorter than the interval the data is
      // produced on — see cache.mjs's deriveBudgetFromInterval().
      cache.deriveBudgetFromInterval(name, intervalMs);
    },
    async runOnce(name) {
      const c = collectors.get(name);
      if (!c || c.running) return;
      c.running = true;
      let failed = false;
      try {
        cache.set(name, await c.fn());
      } catch (err) {
        failed = true;
        cache.fail(name, err);
      } finally {
        c.running = false;
        if (firstPending.delete(name)) {
          if (failed) firstFailed.push(name);
          if (firstPending.size === 0) resolveFirst({ failed: [...firstFailed] });
        }
      }
      if (!failed && c.then) this.runOnce(c.then);
    },
    startAll() {
      // All of them first. (runOnce can't end before the loop below finishes, since it
      // awaits the collector, so this is belt and braces: its mutant is equivalent.)
      for (const name of collectors.keys()) firstPending.add(name);
      if (firstPending.size === 0) resolveFirst({ failed: [] });
      for (const [name, c] of collectors) {
        this.runOnce(name);
        handles.push(timers.setInterval(() => this.runOnce(name), c.intervalMs));
      }
    },
    // Resolves once every collector's first run has ended: { failed: [names] }.
    whenFirstPass: () => firstPass,
    stopAll() {
      for (const h of handles) timers.clearInterval(h);
      handles.length = 0;
    }
  };
}
