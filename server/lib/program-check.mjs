import { realpath, stat, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// The two programs this server runs on a timer from paths in config.json: the
// lead's job-status (every minute, for the health strip) and git-read (every 5
// minutes, for To push). Both are Python scripts for /usr/bin/python3, and run as
//
//   /usr/bin/python3 -I <path> <args>
//
// Isolated mode reads no PYTHON* variable and puts neither the script's own folder
// nor the user's site-packages on sys.path, so only the script, the package it puts
// on sys.path itself and the standard library load: a .pth file dropped into the
// user's site-packages can't run every minute (the 2026-10-21 security review). It
// also turns off Apple's per-user cache of compiled code (under ~/Library/Caches),
// so the package's compiled copies can come only from its own __pycache__, which
// is checked below with the rest of the package.
export const PYTHON = '/usr/bin/python3';
export const pythonArgs = (script, args = []) => ['-I', script, ...args];

// Their environment: the short list git-read itself passes on to git (HOME, PATH,
// TMPDIR, USER, LOGNAME, LANG and LC_*), nothing else of this service's, and
// xcrun_nocache=1. /usr/bin/python3 is xcrun's shim, which reads variables that
// move it (DEVELOPER_DIR, SDKROOT, TOOLCHAINS, and xcrun_db, a lookup cache it
// trusts as it stands); none of them comes through, and the shim looks python3 up
// afresh rather than from a cache, as git-read has the shim do for git.
const PASSED_ENV = ['HOME', 'PATH', 'TMPDIR', 'USER', 'LOGNAME', 'LANG'];
export const programEnv = (env = process.env) => ({
  ...Object.fromEntries(Object.entries(env).filter(([k, v]) => typeof v === 'string' && (PASSED_ENV.includes(k) || k.startsWith('LC_')))),
  xcrun_nocache: '1'
});

// Each launcher is a few lines that put its repo's top folder on sys.path and
// import the package beside its own folder, ../jarvis, where the code that runs
// lives. So that package is checked as well, with everything in it.
export const PACKAGE = 'jarvis';
// Far more than the package holds (16 files on 2026-10-21); a bigger or deeper
// tree is refused rather than walked.
export const MAX_ENTRIES = 500;
export const MAX_DEPTH = 4;
const WRITABLE_BY_OTHERS = 0o022;

// The rule, for one file or folder: at its real path (symlinks followed) it is the
// kind expected, this user owns it, neither its group nor anyone else may write
// it, and every folder above it is owned by this user or root and writable by
// neither (as OpenSSH's StrictModes checks a key file). Mode bits only: an ACL
// isn't read. Gives the real path and what stat said, and what is wrong in fixed
// words, or null. Throws when something can't be read.
async function inspect(path, kind, { uid, fs }) {
  const real = await fs.realpath(path);
  const info = await fs.stat(real);
  const isFile = info.isFile();
  const isFolder = info.isDirectory();
  const fits = kind === 'file' ? isFile : kind === 'folder' ? isFolder : isFile || isFolder;
  const wrong = problem => ({ real, info, problem });
  if (!fits) return wrong(kind === 'file' ? 'is not a regular file' : kind === 'folder' ? 'is not a folder' : 'is not a regular file or a folder');
  if (info.uid !== uid) return wrong('is not owned by the user this server runs as');
  if (info.mode & WRITABLE_BY_OTHERS) return wrong('can be changed by other users (group- or world-writable)');
  for (let dir = dirname(real); ; dir = dirname(dir)) {
    const folder = await fs.stat(dir);
    if (folder.uid !== uid && folder.uid !== 0) return wrong('is in a folder owned by another user');
    if (folder.mode & WRITABLE_BY_OTHERS) return wrong('is in a folder other users can change (group- or world-writable)');
    if (dirname(dir) === dir) return wrong(null);
  }
}

const notChecked = err => `could not be checked (${err?.code ?? 'error'})`;

// The package folder and everything in it: each .py file, the compiled copies in
// __pycache__ and any sub-package, each by the rule above.
async function checkPackage(dir, opts) {
  let entries = 0;
  const walk = async (path, where, kind, depth) => {
    let found;
    try { found = await inspect(path, kind, opts); } catch (err) { return `imports ${where}, which ${notChecked(err)}`; }
    if (found.problem) return `imports ${where}, which ${found.problem}`;
    if (!found.info.isDirectory()) return null;
    if (depth >= MAX_DEPTH) return `imports ${where}, which is nested too deep to check`;
    let names;
    try { names = (await opts.fs.readdir(found.real)).sort(); } catch (err) { return `imports ${where}, which ${notChecked(err)}`; }
    for (const name of names) {
      if (++entries > MAX_ENTRIES) return `imports ../${PACKAGE}, which holds more than ${MAX_ENTRIES} entries to check`;
      const problem = await walk(join(found.real, name), `${where}/${name}`, 'any', depth + 1);
      if (problem) return problem;
    }
    return null;
  };
  return walk(dir, `../${PACKAGE}`, 'folder', 0);
}

// Whether this server may run the launcher at `path`: the launcher passes the
// rule, and so does its package. Gives { real, problem }: the launcher's real
// path when everything passes, or what is wrong.
export async function checkProgram(path, { uid = process.getuid(), fs = { realpath, stat, readdir } } = {}) {
  const opts = { uid, fs };
  let launcher;
  try { launcher = await inspect(path, 'file', opts); } catch (err) { return { real: null, problem: notChecked(err) }; }
  if (launcher.problem) return { real: null, problem: launcher.problem };
  const problem = await checkPackage(join(dirname(dirname(launcher.real)), PACKAGE), opts);
  return problem ? { real: null, problem } : { real: launcher.real, problem: null };
}

// Checked once, at startup. Each entry is [its name in config.json, the settings
// object, the key holding the path]. A path that passes is replaced by its real
// path, so every later run starts exactly the file that was checked; one that
// fails is set to null, which leaves that feature "not set up" like any bad entry,
// and what was wrong comes back as a line for the service log.
export async function vetPrograms(entries, options) {
  const problems = [];
  for (const [name, settings, key] of entries) {
    if (typeof settings?.[key] !== 'string') continue;
    const { real, problem } = await checkProgram(settings[key], options);
    if (problem) {
      problems.push(`${name} ${problem}, so it is left out`);
      settings[key] = null;
    } else {
      settings[key] = real;
    }
  }
  return problems;
}
