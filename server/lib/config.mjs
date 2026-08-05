import { readFile } from 'node:fs/promises';

const DEFAULTS = { warnThreshold: 85, showAlertBanner: true, plan: null, credits: null };

export async function loadConfig(path) {
  try {
    return { ...DEFAULTS, ...JSON.parse(await readFile(path, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}
