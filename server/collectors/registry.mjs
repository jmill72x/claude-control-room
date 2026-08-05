export function createRegistry(cache, timers = { setInterval, clearInterval }) {
  const collectors = new Map();
  const handles = [];

  return {
    register(name, fn, intervalMs) {
      collectors.set(name, { fn, intervalMs, running: false });
    },
    async runOnce(name) {
      const c = collectors.get(name);
      if (!c || c.running) return;
      c.running = true;
      try {
        cache.set(name, await c.fn());
      } catch (err) {
        cache.fail(name, err);
      } finally {
        c.running = false;
      }
    },
    startAll() {
      for (const [name, c] of collectors) {
        this.runOnce(name);
        handles.push(timers.setInterval(() => this.runOnce(name), c.intervalMs));
      }
    },
    stopAll() {
      for (const h of handles) timers.clearInterval(h);
      handles.length = 0;
    }
  };
}
