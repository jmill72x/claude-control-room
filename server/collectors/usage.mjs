import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseUsage } from '../lib/parse-usage.mjs';

const exec = promisify(execFile);

export const runUsageCli = async () => {
  const { stdout } = await exec('claude', ['-p', '/usage'], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
};

export async function collectUsage({ run = runUsageCli, now = () => new Date() } = {}) {
  return parseUsage(await run(), now());
}
