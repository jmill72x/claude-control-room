import { readFile } from 'node:fs/promises';

const DEFAULTS = { warnThreshold: 85, showAlertBanner: true, plan: null, credits: null };

// `present` travels with the config so the dashboard route can mark the panels
// it feeds as unavailable rather than asserting 'ok' over an empty frame. The
// defaults are still returned — the alert threshold has to have a value — but
// nothing pretends they came from a file that isn't there.
export async function loadConfig(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...DEFAULTS, present: false, error: 'config.json is not an object' };
    }
    return { ...DEFAULTS, ...parsed, present: true, error: null };
  } catch (err) {
    return {
      ...DEFAULTS,
      present: false,
      error: err.code === 'ENOENT'
        ? 'no config.json on this machine — plan and credits have no source'
        : `config.json could not be read: ${err.message}`
    };
  }
}
