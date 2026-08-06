import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { planTierLabel } from '../lib/plan-tier.mjs';

const exec = promisify(execFile);

export const runPlanCli = async () => {
  const { stdout } = await exec('claude', ['auth', 'status', '--json'], { timeout: 30000, maxBuffer: 1024 * 1024 });
  return stdout;
};

// `claude auth status --json` also carries the signed-in email, org id, and
// org name — this repo is public and the dashboard is meant to sit behind a
// tunnel, so those must never reach the cache or a log line. The parsed
// object is discarded the moment `subscriptionType` is pulled out of it;
// nothing else from `parsed` is retained anywhere below this line.
export async function collectPlan({ run = runPlanCli } = {}) {
  const parsed = JSON.parse(await run());
  const subscriptionType = parsed?.subscriptionType;
  if (typeof subscriptionType !== 'string' || subscriptionType === '') {
    throw new Error('claude auth status --json did not return a subscriptionType');
  }
  return { tier: planTierLabel(subscriptionType) };
}
