import { basename, isAbsolute, resolve } from 'node:path';

// The To push tile on the Orbit page (Orbit plan, Phase 4): which repos have
// staged changes, or commits their upstream doesn't have. This file holds the
// pure parts: the config block, reading what `git status --porcelain=v2
// --branch` prints, and building what the page gets. The page gets each repo's
// folder name, its owner, its branch and counts, never a path, a commit id, a
// file name or anything git said on stderr. The process side is
// collectors/to-push.mjs.

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// A repo's name on the page is its folder's name, so it must look like one.
export const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// A branch name as the page may show it. git allows more than this; a name
// outside it (or one git-read redacted as secret-shaped) is shown as unnamed.
export const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
// Each repo costs one run every pass, one after another, each with its own
// time limit (collectors/to-push.mjs), so the list is capped well inside a pass.
export const MAX_REPOS = 20;

// The block in config.json (gitignored: the real paths live there):
//
//   "toPush": {
//     "gitRead": "/absolute/path/to/git-read",
//     "repos": [
//       { "path": "/absolute/path/to/projects/garden-app", "owner": "builder" },
//       …
//     ]
//   }
//
// `owner` is optional and must be on the roster. A bad entry is left out and
// described in `problems`, which the server logs once at startup.
export function readToPushConfig(config, agentKeys = []) {
  const problems = [];
  const out = { gitRead: null, repos: [], problems };
  const raw = config?.toPush;
  if (raw === undefined) return out;
  if (!isObject(raw)) {
    problems.push('toPush is not an object');
    return out;
  }
  if (typeof raw.gitRead === 'string' && isAbsolute(raw.gitRead)) out.gitRead = raw.gitRead;
  else problems.push('toPush.gitRead must be an absolute path');
  if (!Array.isArray(raw.repos)) {
    problems.push('toPush.repos is not a list');
    return out;
  }
  const keys = new Set(agentKeys);
  const names = new Set();
  raw.repos.forEach((r, i) => {
    const where = `toPush.repos[${i}]`;
    if (!(typeof r?.path === 'string' && isAbsolute(r.path))) return problems.push(`${where}: path must be an absolute path`);
    const path = resolve(r.path);
    const name = basename(path);
    if (!REPO_NAME.test(name)) return problems.push(`${where}: the folder's name can't be shown as a repo name`);
    if (names.has(name)) return problems.push(`${where}: ${JSON.stringify(name)} is listed twice`);
    if (out.repos.length >= MAX_REPOS) return problems.push(`${where}: at most ${MAX_REPOS} repos; this one is left out`);
    let owner = null;
    if (r.owner !== undefined) {
      if (typeof r.owner === 'string' && keys.has(r.owner)) owner = r.owner;
      else problems.push(`${where}: owner ${JSON.stringify(r.owner)} is not on the roster`);
    }
    names.add(name);
    out.repos.push({ name, path, owner });
  });
  return out;
}

// What `git status --porcelain=v2 --branch` printed, down to the branch, whether
// it has an upstream, how far ahead and behind it is, and how many changes are
// staged. Untracked and ignored files never count (the collector asks git not to
// list them). A merge conflict (`u`) isn't a staged change. git-read cuts very
// long output and says so on a line of its own; the counts are then at least
// what they say. Throws when there is no branch line, which every answer has.
export function parseStatus(raw) {
  let head;
  let upstream = false;
  let ahead = null;
  let behind = null;
  let staged = 0;
  let partial = false;
  for (const line of String(raw ?? '').split('\n')) {
    if (line.startsWith('# branch.head ')) head = line.slice('# branch.head '.length).trim();
    else if (line.startsWith('# branch.upstream ')) upstream = true;
    else if (line.startsWith('# branch.ab ')) {
      const m = /^# branch\.ab \+(\d+) -(\d+)\s*$/.exec(line);
      if (m) { ahead = Number(m[1]); behind = Number(m[2]); }
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      if (line[2] !== '.') staged += 1;
    } else if (line.startsWith('[git-read: output cut')) partial = true;
  }
  if (head === undefined) throw new Error('git-read gave no branch line');
  const detached = head === '(detached)';
  const branch = !detached && BRANCH_NAME.test(head) ? head : null;
  return { branch, detached, upstream, ahead, behind, staged, partial };
}

// One repo as the page gets it, built field by field. An unread repo carries
// only its name, owner and why, in the collector's fixed words.
export function repoView(repo, status, at, why = null) {
  if (!status) return { name: repo.name, owner: repo.owner, state: 'error', why: why ?? 'could not be read', checkedAt: at };
  return {
    name: repo.name,
    owner: repo.owner,
    state: 'ok',
    branch: status.branch,
    detached: status.detached,
    upstream: status.upstream,
    staged: status.staged,
    ahead: status.ahead,
    behind: status.behind,
    partial: status.partial,
    checkedAt: at
  };
}
