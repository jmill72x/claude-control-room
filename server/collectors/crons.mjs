import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseLaunchctlList, buildCron } from '../lib/parse-launchd.mjs';

const exec = promisify(execFile);
const AGENTS_DIR = join(homedir(), 'Library', 'LaunchAgents');
const SKIP = /^com\.(apple|google|openai)\./;

const runLaunchctl = async () => (await exec('launchctl', ['list'], { timeout: 30000 })).stdout;

async function readPlist(path) {
  const { stdout } = await exec('plutil', ['-convert', 'json', '-o', '-', path], { timeout: 15000 });
  return JSON.parse(stdout);
}

export async function collectCrons({
  listAgents = () => readdir(AGENTS_DIR),
  plistReader = readPlist,
  launchctl = runLaunchctl,
  now = () => Date.now()
} = {}) {
  const statuses = parseLaunchctlList(await launchctl());
  const files = (await listAgents()).filter(f => f.endsWith('.plist'));
  const at = now();
  const crons = [];

  for (const file of files) {
    const label = file.replace(/\.plist$/, '');
    if (SKIP.test(label)) continue;
    let plist;
    try { plist = await plistReader(join(AGENTS_DIR, file)); } catch { continue; }
    if (!plist.StartCalendarInterval && !plist.StartInterval) continue;
    crons.push(buildCron({ label, plist, statusRow: statuses.get(label) ?? null }, at));
  }

  return crons.sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? 1 : -1;
    return (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity);
  });
}
