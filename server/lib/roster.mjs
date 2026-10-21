import { isAbsolute } from 'node:path';

// An agent's key: lowercase letters, digits and inner hyphens, at most 40
// characters. The board's `owner` field, the roster in config and the avatar
// route (/avatars/<key>.png) all take this one pattern, so a key that passes any
// of them is safe to put in a URL path and a file name as it stands.
export const AGENT_KEY = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v, max) => (typeof v === 'string' && v.trim() !== '' && v.length <= max ? v.trim() : null);

// The roster and the job names, read from config.json (gitignored, so the real
// names, avatar folder and job labels stay out of this public repo):
//
//   "roster": {
//     "avatarDir": "/absolute/path/to/a/folder/of/<key>.png",
//     "agents": [{ "key": "lead", "name": "The Lead" }, …],
//     "tagOwners": { "Infra": "builder", … }
//   },
//   "jobs": { "<launchd label>": { "name": "Morning brief", "owner": "lead" }, … }
//
// Anything malformed is left out and described in `problems`, which the server
// logs once at startup: one bad entry costs that entry, never the roster.
export function readRoster(config) {
  const problems = [];
  const raw = isObject(config?.roster) ? config.roster : {};
  if (config?.roster !== undefined && !isObject(config.roster)) problems.push('roster is not an object');

  const agents = [];
  const seen = new Set();
  for (const a of Array.isArray(raw.agents) ? raw.agents : []) {
    const key = typeof a?.key === 'string' ? a.key : '';
    const name = text(a?.name, 60);
    if (!AGENT_KEY.test(key)) { problems.push(`roster.agents: ${JSON.stringify(a?.key)} is not an agent key`); continue; }
    if (!name) { problems.push(`roster.agents: ${key} has no name`); continue; }
    if (seen.has(key)) { problems.push(`roster.agents: ${key} is listed twice`); continue; }
    seen.add(key);
    agents.push({ key, name });
  }

  const tagOwners = {};
  for (const [tag, key] of Object.entries(isObject(raw.tagOwners) ? raw.tagOwners : {})) {
    if (seen.has(key)) tagOwners[tag] = key;
    else problems.push(`roster.tagOwners: ${JSON.stringify(tag)} names ${JSON.stringify(key)}, which is not on the roster`);
  }

  // Only an absolute path: a relative one would depend on the directory the
  // service happens to start in.
  let avatarDir = null;
  if (raw.avatarDir !== undefined) {
    if (typeof raw.avatarDir === 'string' && isAbsolute(raw.avatarDir)) avatarDir = raw.avatarDir;
    else problems.push('roster.avatarDir must be an absolute path');
  }

  const jobs = {};
  for (const [label, job] of Object.entries(isObject(config?.jobs) ? config.jobs : {})) {
    const name = text(job?.name, 60);
    if (!name) { problems.push(`jobs: ${JSON.stringify(label)} has no name`); continue; }
    const owner = typeof job.owner === 'string' && seen.has(job.owner) ? job.owner : null;
    if (job.owner !== undefined && !owner) problems.push(`jobs: ${JSON.stringify(label)} names an owner that is not on the roster`);
    jobs[label] = owner ? { name, owner } : { name };
  }

  return { agents, tagOwners, avatarDir, jobs, problems };
}
