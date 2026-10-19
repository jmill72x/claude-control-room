import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseUsage } from '../lib/parse-usage.mjs';

const execFileAsync = promisify(execFile);

// A bare `claude -p` starts every MCP server the user has, plugins' included.
// This poll needs none of them. On 2026-10-17 its failed plugin starts, one
// every five minutes, kept a shared 15-minute plugin-failure cache full, and
// that blocked Jarvis's Discord connector. --strict-mcp-config starts only the
// servers named by --mcp-config, and there are none. The permission mode is
// pinned so the poll never inherits a looser default from the user's settings.
// `manual` is its listed name; Claude Code 2.1.302 still takes the older
// `default`, but only as an unlisted alias. Neither flag changes what /usage
// prints.
export const runUsageCli = async ({ exec = execFileAsync } = {}) => {
  const { stdout } = await exec('claude', ['-p', '/usage', '--strict-mcp-config', '--permission-mode', 'manual'], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
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
