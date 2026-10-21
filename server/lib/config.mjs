import { readFile } from 'node:fs/promises';

const DEFAULTS = { warnThreshold: 85, showAlertBanner: true, plan: null, credits: null };

// `present` travels with the config so the dashboard route can mark the panels
// it feeds as unavailable rather than asserting 'ok' over an empty frame. The
// defaults are still returned — the alert threshold has to have a value — but
// nothing pretends they came from a file that isn't there.
//
// `error` reaches the page, and so every device on the tailnet. A JSON parse
// error quotes the file around the fault (a credit balance, a path) and an open
// error names the file's full path, so the page gets a fixed line and the
// service log gets the detail.
export const UNREADABLE = 'config.json could not be read; the service log says why';

export async function loadConfig(path, { log = console.error } = {}) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...DEFAULTS, present: false, error: 'config.json is not an object' };
    }
    return { ...DEFAULTS, ...parsed, present: true, error: null };
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { ...DEFAULTS, present: false, error: 'no config.json on this machine — plan and credits have no source' };
    }
    log(`config: ${path} could not be read: ${err.message}`);
    return { ...DEFAULTS, present: false, error: UNREADABLE };
  }
}
