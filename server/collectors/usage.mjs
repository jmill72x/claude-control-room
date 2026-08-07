import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseUsage } from '../lib/parse-usage.mjs';

const exec = promisify(execFile);

export const runUsageCli = async () => {
  const { stdout } = await exec('claude', ['-p', '/usage'], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
};

export async function collectUsage({ run = runUsageCli, now = () => new Date(), history } = {}) {
  const parsed = parseUsage(await run(), now());

  // Appended only after a successful parse. A gap in the history file must mean
  // "no reading was taken", never "a reading of zero".
  if (history) {
    try {
      await history.append({
        t: now().getTime(),
        limits: parsed.limits.map(l => ({ label: l.label, pct: l.pct, resetsAt: l.resetsAt }))
      });
    } catch (err) {
      // The reading itself is good. Losing a history write costs a future
      // sparkline point; failing the collector would blank a panel that has
      // perfectly valid data. Report it, keep the reading.
      console.error('history append failed:', err.message);
    }
  }
  return parsed;
}
