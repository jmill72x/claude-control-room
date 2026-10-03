// The server once stayed alive for four days holding no listening socket:
// collectors ticking, nothing logged, every request hanging. launchd's
// KeepAlive restarts a process that EXITS, not one that has gone deaf, so the
// server checks its own front door and exits when it stays shut.
//
// One failure is a blip (a slow tick, a GC pause); only `failuresAllowed`
// consecutive failures count. A probe that never settles is cut off, so a hung
// request is a failure rather than a watchdog that hangs with it.
export function createWatchdog({ probe, onDead, failuresAllowed = 3, timeoutMs = 5000 }) {
  let failures = 0;
  let fired = false;
  const withTimeout = () => Promise.race([
    Promise.resolve().then(probe),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), timeoutMs).unref?.())
  ]);
  return {
    async tick() {
      if (fired) return;
      let ok = false;
      try { ok = (await withTimeout()) === true; } catch { ok = false; }
      failures = ok ? 0 : failures + 1;
      if (failures >= failuresAllowed) {
        fired = true;
        onDead(`${failuresAllowed} consecutive self-checks of the HTTP listener failed`);
      }
    }
  };
}
