// The To push tile's pure parts (lib/to-push.mjs): the config block, reading
// what `git status --porcelain=v2 --branch` prints, and what the page gets.
// Every path, repo, branch and agent is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readToPushConfig, parseStatus, repoView, MAX_REPOS } from '../lib/to-push.mjs';

const KEYS = ['builder', 'writer'];

// ---- the config block ----

test('no block is no To push, and no problem', () => {
  assert.deepEqual(readToPushConfig({}, KEYS), { gitRead: null, repos: [], problems: [] });
});

test('each repo takes its folder name, a normalised path and an owner from the roster', () => {
  const s = readToPushConfig({
    toPush: {
      gitRead: '/opt/example/bin/git-read',
      repos: [
        { path: '/home/example/projects/garden-app/', owner: 'builder' },
        { path: '/home/example/projects/notes.site' }
      ]
    }
  }, KEYS);
  assert.deepEqual(s.problems, []);
  assert.equal(s.gitRead, '/opt/example/bin/git-read');
  assert.deepEqual(s.repos, [
    { name: 'garden-app', path: '/home/example/projects/garden-app', owner: 'builder' },
    { name: 'notes.site', path: '/home/example/projects/notes.site', owner: null }
  ]);
});

test('a bad entry is left out and named; the rest stay', () => {
  const s = readToPushConfig({
    toPush: {
      gitRead: 'bin/git-read',
      repos: [
        { path: 'projects/relative' },
        { path: '/home/example/projects/garden-app', owner: 'stranger' },
        { path: '/home/example/other/garden-app' },
        { path: '/home/example/projects/has space' },
        { path: '/' },
        { owner: 'builder' },
        'just a string'
      ]
    }
  }, KEYS);
  assert.equal(s.gitRead, null);
  assert.deepEqual(s.repos, [{ name: 'garden-app', path: '/home/example/projects/garden-app', owner: null }]);
  assert.deepEqual(s.problems, [
    'toPush.gitRead must be an absolute path',
    'toPush.repos[0]: path must be an absolute path',
    'toPush.repos[1]: owner "stranger" is not on the roster',
    'toPush.repos[2]: "garden-app" is listed twice',
    "toPush.repos[3]: the folder's name can't be shown as a repo name",
    "toPush.repos[4]: the folder's name can't be shown as a repo name",
    'toPush.repos[5]: path must be an absolute path',
    'toPush.repos[6]: path must be an absolute path'
  ]);
});

test('a block that is not an object, or repos that are not a list, say so', () => {
  assert.deepEqual(readToPushConfig({ toPush: [] }, KEYS).problems, ['toPush is not an object']);
  const s = readToPushConfig({ toPush: { gitRead: '/opt/git-read', repos: {} } }, KEYS);
  assert.deepEqual(s.problems, ['toPush.repos is not a list']);
  assert.deepEqual(s.repos, []);
});

test(`at most ${MAX_REPOS} repos are read; the rest are named and left out`, () => {
  const repos = Array.from({ length: MAX_REPOS + 2 }, (_, i) => ({ path: `/home/example/projects/r${i}` }));
  const s = readToPushConfig({ toPush: { gitRead: '/opt/git-read', repos } }, KEYS);
  assert.equal(s.repos.length, MAX_REPOS);
  assert.deepEqual(s.problems, [
    `toPush.repos[${MAX_REPOS}]: at most ${MAX_REPOS} repos; this one is left out`,
    `toPush.repos[${MAX_REPOS + 1}]: at most ${MAX_REPOS} repos; this one is left out`
  ]);
});

// ---- what git status says ----

const OID = '# branch.oid 0123456789abcdef0123456789abcdef01234567';

test('a clean branch that matches its upstream: nothing staged, nothing ahead', () => {
  assert.deepEqual(parseStatus([OID, '# branch.head main', '# branch.upstream origin/main', '# branch.ab +0 -0', ''].join('\n')), {
    branch: 'main', detached: false, upstream: true, ahead: 0, behind: 0, staged: 0, partial: false
  });
});

test('staged changes count by the index column only; changes not staged and conflicts do not', () => {
  const raw = [
    OID, '# branch.head feature/ferns', '# branch.upstream origin/feature/ferns', '# branch.ab +2 -1',
    '1 M. N... 100644 100644 100644 aaaa bbbb src/a.js',
    '1 A. N... 000000 100644 100644 0000 cccc src/new file.js',
    '1 MM N... 100644 100644 100644 aaaa dddd src/both.js',
    '1 .M N... 100644 100644 100644 aaaa aaaa src/unstaged.js',
    '2 R. N... 100644 100644 100644 eeee eeee R100 src/moved.js\tsrc/old.js',
    'u UU N... 100644 100644 100644 100644 a b c src/conflict.js',
    ''
  ].join('\n');
  assert.deepEqual(parseStatus(raw), { branch: 'feature/ferns', detached: false, upstream: true, ahead: 2, behind: 1, staged: 4, partial: false });
});

test('no upstream: no ahead or behind; a detached head has no branch', () => {
  assert.deepEqual(parseStatus(`${OID}\n# branch.head build/v2\n`), {
    branch: 'build/v2', detached: false, upstream: false, ahead: null, behind: null, staged: 0, partial: false
  });
  const detached = parseStatus(`${OID}\n# branch.head (detached)\n1 M. N... 100644 100644 100644 a b x\n`);
  assert.equal(detached.detached, true);
  assert.equal(detached.branch, null);
  assert.equal(detached.staged, 1);
});

test('an upstream that is gone gives no counts against it', () => {
  const s = parseStatus(`${OID}\n# branch.head main\n# branch.upstream origin/main\n`);
  assert.equal(s.upstream, true);
  assert.equal(s.ahead, null);
});

test('a branch name the page can\'t show, or one git-read redacted, is unnamed but still a branch', () => {
  for (const head of ['[redacted: token]', 'has space', '-dash', 'x'.repeat(101), 'ünïcode']) {
    const s = parseStatus(`# branch.head ${head}\n# branch.upstream origin/x\n# branch.ab +1 -0\n`);
    assert.equal(s.branch, null, head);
    assert.equal(s.detached, false, head);
    assert.equal(s.ahead, 1, head);
  }
});

test("git-read's cut note makes the counts a lower bound", () => {
  const s = parseStatus(`# branch.head main\n1 M. N... a b c d e f\n[git-read: output cut at 200000 characters]\n`);
  assert.equal(s.partial, true);
  assert.equal(s.staged, 1);
});

test('an answer with no branch line is no answer', () => {
  assert.throws(() => parseStatus(''), /no branch line/);
  assert.throws(() => parseStatus('1 M. N... a b c d e f\n'), /no branch line/);
});

test('a malformed ahead line leaves the counts unknown rather than wrong', () => {
  const s = parseStatus('# branch.head main\n# branch.upstream origin/main\n# branch.ab +x -1\n');
  assert.equal(s.ahead, null);
  assert.equal(s.behind, null);
});

// ---- what the page gets ----

test('the page gets the name, owner, branch and counts, and never the path', () => {
  const repo = { name: 'garden-app', path: '/home/example/projects/garden-app', owner: 'builder' };
  const view = repoView(repo, parseStatus(`${OID}\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +1 -0\n`), 1000);
  assert.deepEqual(view, {
    name: 'garden-app', owner: 'builder', state: 'ok', branch: 'main', detached: false, upstream: true,
    staged: 0, ahead: 1, behind: 0, partial: false, checkedAt: 1000
  });
  assert.ok(!JSON.stringify(view).includes('/home/example') && !JSON.stringify(view).includes('0123456789'));
  assert.deepEqual(repoView(repo, null, 2000, 'timed out after 10 s'), {
    name: 'garden-app', owner: 'builder', state: 'error', why: 'timed out after 10 s', checkedAt: 2000
  });
});
