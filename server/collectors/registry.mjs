export function createRegistry(cache, timers = { setInterval, clearInterval }, { log = console.error } = {}) {
  const collectors = new Map();
  // The collectors a run of `name` would lead back to itself through, were it to be
  // followed by `then`: [name, then, …, name], or null when the chain ends elsewhere.
  // Links are followed as registered so far. The walk always ends: no loop is ever
  // registered (register, below), so a chain of links runs out.
  const loopThrough = (name, then) => {
    const path = [name];
    for (let next = then; next; next = collectors.get(next)?.then) {
      path.push(next);
      if (next === name) return path;
    }
    return null;
  };
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
    // once and not at the notifier's own next tick). It is not waited for. While that
    // collector is already running (its own tick began a moment before, on the old
    // value), the run is not stacked on it and not lost either: one more run follows
    // the one under way, however many asked meanwhile.
    // A `then` that would loop is refused: one that names its own collector, or that
    // leads back to it through the others' (a then b, b then a). Each run would start
    // the next with no timer between them, for good: `claude -p "/usage"` back to
    // back. The collector is still registered and runs on its own interval; only the
    // link is dropped, with one line in the log. (Every loop is caught, whatever the
    // order of the calls: its last link to be registered closes it.)
    register(name, fn, intervalMs, { then = null } = {}) {
      const loop = loopThrough(name, then);
      if (loop) {
        log(`registry: ${name} then ${then} would loop (${loop.join(' > ')}); registered without it`);
        then = null;
      }
      collectors.set(name, { fn, intervalMs, running: false, again: false, then });
      // Tell the cache what this collector's own interval is so its
      // staleness budget can never be shorter than the interval the data is
      // produced on — see cache.mjs's deriveBudgetFromInterval().
      cache.deriveBudgetFromInterval(name, intervalMs);
    },
    // `again` is the registry's own, for a run that follows another collector's: a
    // timer's or a caller's run that meets one under way is skipped, as ever.
    async runOnce(name, { again = false } = {}) {
      const c = collectors.get(name);
      if (!c) return;
      if (c.running) { if (again) c.again = true; return; }
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
      if (!failed && c.then) this.runOnce(c.then, { again: true });
      if (c.again) { c.again = false; this.runOnce(name); }
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
