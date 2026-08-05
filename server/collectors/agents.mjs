import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export const runAgentsCli = async () => {
  const { stdout } = await exec('claude', ['agents', '--json'], { timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
};

export async function collectAgents({ run = runAgentsCli } = {}) {
  const parsed = JSON.parse(await run());
  if (!Array.isArray(parsed)) throw new Error('claude agents --json did not return an array');
  return parsed;
}
