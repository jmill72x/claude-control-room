// Approvals as buttons (docs/design/2026-11-11-jarvis-os-approvals.md): what the page
// may answer for a permission request the lead's channel relayed, and when. The store
// (lib/chat-store.mjs) keeps the requests; the socket route asks `assess` when one
// opens; the verdict route (lib/chat-routes.mjs) asks the gate made here before it
// lets a tap through. Checked by test/approvals.test.mjs.
//
// Three things decide whether the page may answer at all, and the most cautious wins:
//   - config's `chat.approvals`: "off" (the default, and anything not understood),
//     "deny" (cards with Deny only) or "on" (Deny and Allow once);
//   - the kill file ~/.local/state/jarvis-os/approvals-off, read on every request:
//     while it exists the mode is off, without a restart;
//   - the channel's own relay mode, which it reports at hello and with each heartbeat
//     (off, deny or allow): unless it says allow, "on" counts as "deny" here, so the
//     page never offers an Allow the channel would drop.
// While off, both permission routes answer 403, so the channel stops retrying and the
// prompt stays in the terminal and Discord.
//
// Allow is further limited to what passes `denyOnlyReasons`: a short allowlist, not a
// security boundary. It makes the riskiest requests need the terminal or Discord, so a
// stolen phone or a careless tap can't grant them. Since Ultron's 11-11 build review:
// anything outside plain ASCII in a command or a path is Deny-only; writes pass only
// inside config's write folders. Since his final read the same day (design 0.2): code
// inside the write folders is protected by generic rules and by config's
// `chat.approvalsWriteProtected`; a channel reply may attach only what is in the outbox;
// and Bash is Deny-only unless config says "exact", which needs the exact command from
// the report-only PermissionRequest hook (lib/exact-commands.mjs) and then allows only a
// strict one-liner or a command listed in config.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createExactCommands, exactTextOk, foldWhitespace } from './exact-commands.mjs';

export const APPROVAL_MODES = Object.freeze(['off', 'deny', 'on']);
// Each relayed field is kept whole up to this many code points (Claude Code sends each
// top-level field of a preview up to 3,500, so a preview of several fields is longer).
// The channel cuts at 16,000 and adds its own marker, so this leaves room for that
// marker: a field the channel cut is never cut twice. Anything longer is cut here,
// marked, and Deny-only (Ultron H1).
export const FIELD_MAX = 16100;
export const TOOL_MAX = 200;
export const cutMarker = n => `⋯ ${n} code points cut by the Control Room ⋯`;
// A request this old when it reaches the server is answered at the terminal (L9).
export const LATE_AFTER_MS = 2 * 60e3;
// After the classifier blocks something in the lead's session, page cards are
// Deny-only this long (decision 3, M3/M6).
export const BLOCK_WINDOW_MS = 15 * 60e3;
// A block this close before a request is shown as the card's reason for asking.
export const WHY_WINDOW_MS = 2 * 60e3;
// Verdict limits per device (G2).
export const VERDICTS_PER_MINUTE = 6;
export const VERDICTS_PER_HOUR = 30;
export const REFUSALS_FOR_LOCKOUT = 10;
export const REFUSAL_WINDOW_MS = 10 * 60e3;
export const LOCKOUT_MS = 10 * 60e3;
// More than this many allows in the window, from any devices: an alert (stolen phone).
export const ALLOW_BURST = 3;
export const ALLOW_BURST_WINDOW_MS = 5 * 60e3;
// More than this many open requests: Deny-only for FLOOD_MS, and an alert.
export const FLOOD_OPEN = 5;
export const FLOOD_MS = 10 * 60e3;

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const codePoints = s => Array.from(String(s ?? ''));
// Printable ASCII only (space to ~). The disk folds some other letters into ASCII ones
// (APFS reads the long s, U+017F, as "s") where JavaScript's toLowerCase does not, so a
// path or command with anything else can't be judged here and is Deny-only (Ultron H-b).
export function plainAscii(s) {
  const t = String(s ?? '');
  for (let i = 0; i < t.length; i++) { const c = t.charCodeAt(i); if (c < 0x20 || c > 0x7e) return false; }
  return true;
}
const WILDCARD = /[*?[\]{}]/;
const isAbsolute = p => typeof p === 'string' && (p === '~' || p.startsWith('~/') || p.startsWith('/'));
const stripSlash = p => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p);

export const BASH_MODES = Object.freeze(['deny', 'exact']);
export const WRITE_FOLDERS_MAX = 40;
export const WRITE_PROTECTED_MAX = 200;
export const BASH_COMMANDS_MAX = 50;
export const BASH_COMMAND_MAX_CHARS = 2000;

// A path from config: absolute (or ~/), plain ASCII, no `..` or wildcard.
const okConfigPath = f => typeof f === 'string' && f.length <= 300 && plainAscii(f) && (f.startsWith('/') || f.startsWith('~/')) &&
  !f.split('/').includes('..') && !WILDCARD.test(f);
// Repos no write folder may be, hold or sit inside: the lead's repo, machine-setup and
// the Control Room's own code (`root` is its repo).
const noWriteFolderPlaces = (h, root) => [`${h}/projects/jarvis`, `${h}/projects/machine-setup`, ...(root ? ['server', 'web', 'bin', 'mod'].map(d => `${root}/${d}`) : [])];

// A write folder from config: a config path narrower than the home folder, and neither
// above nor inside the repos named above (so never the Projects folder itself); judged
// by the path as written and by its real path. Answers true or false.
export function okWriteFolder(f, home, { repoRoot = OWN_REPO, realpath = safeRealpath } = {}) {
  if (!okConfigPath(f)) return false;
  const h = stripSlash(posix.normalize(home)).toLowerCase();
  const root = stripSlash(String(repoRoot ?? '')).toLowerCase();
  for (const norm of pathForms(f, { home, realpath }).forms) {
    if (norm === '/' || h === norm || h.startsWith(norm + '/')) return false;
    // The Projects folder itself is refused by this rule too: it holds the lead's repo.
    if (noWriteFolderPlaces(h, root).some(place => under(place, norm) || under(norm, place))) return false;
  }
  return true;
}

// What config says: the mode, the Bash mode and its listed commands, the write folders,
// the protected places inside them, and anything to log. Unknown values fall to the
// cautious side: off, Bash Deny-only, no listed commands, no write folders. A protected
// list that can't be read turns page writes off whole, since dropping one entry would
// quietly unprotect a place.
export function readApprovalsConfig(config, { home = homedir(), repoRoot = OWN_REPO, realpath = safeRealpath } = {}) {
  const chat = config?.chat;
  const raw = isObject(chat) ? chat.approvals : undefined;
  const problems = [];
  let mode = 'off';
  if (raw !== undefined && raw !== null) {
    if (APPROVAL_MODES.includes(raw)) mode = raw;
    else problems.push('chat.approvals must be "off", "deny" or "on"; approvals stay off');
  }
  const extra = isObject(chat) ? chat.approvalsDenyOnly : undefined;
  const patterns = [];
  if (extra !== undefined) {
    if (!Array.isArray(extra) || !extra.every(p => typeof p === 'string' && p.trim() && p.length <= 200)) {
      problems.push('chat.approvalsDenyOnly must be a list of short strings; it is ignored');
    } else patterns.push(...extra.map(p => p.trim().toLowerCase()));
  }
  let bash = 'deny';
  const rawBash = isObject(chat) ? chat.approvalsBash : undefined;
  if (rawBash !== undefined && rawBash !== null) {
    if (BASH_MODES.includes(rawBash)) bash = rawBash;
    else problems.push('chat.approvalsBash must be "deny" or "exact"; Bash stays Deny-only on the page');
  }
  const bashCommands = [];
  const rawCommands = isObject(chat) ? chat.approvalsBashCommands : undefined;
  if (rawCommands !== undefined && rawCommands !== null) {
    const ok = c => typeof c === 'string' && c.trim() !== '' && c.length <= BASH_COMMAND_MAX_CHARS && exactTextOk(c);
    if (!Array.isArray(rawCommands) || rawCommands.length > BASH_COMMANDS_MAX || !rawCommands.every(ok)) {
      problems.push(`chat.approvalsBashCommands must be a list of at most ${BASH_COMMANDS_MAX} commands in plain ASCII (line breaks and tabs allowed); it is ignored`);
    } else bashCommands.push(...rawCommands);
  }
  const writeFolders = [];
  const rawFolders = isObject(chat) ? chat.approvalsWriteFolders : undefined;
  if (rawFolders !== undefined && rawFolders !== null) {
    if (!Array.isArray(rawFolders) || rawFolders.length > WRITE_FOLDERS_MAX) {
      problems.push(`chat.approvalsWriteFolders must be a list of at most ${WRITE_FOLDERS_MAX} folders; it is ignored, so the page allows no writes`);
    } else {
      for (const f of rawFolders) {
        if (okWriteFolder(f, home, { repoRoot, realpath })) writeFolders.push(f);
        else problems.push('chat.approvalsWriteFolders: an entry is not an absolute plain folder below the home folder, or it is the Projects folder, or it holds or sits inside the lead\'s repo, machine-setup or the Control Room\'s code; it is ignored');
      }
    }
  }
  const writeProtected = [];
  const rawProtected = isObject(chat) ? chat.approvalsWriteProtected : undefined;
  if (rawProtected !== undefined && rawProtected !== null) {
    if (!Array.isArray(rawProtected) || rawProtected.length > WRITE_PROTECTED_MAX || !rawProtected.every(okConfigPath)) {
      problems.push(`chat.approvalsWriteProtected must be a list of at most ${WRITE_PROTECTED_MAX} absolute plain paths; until it is fixed the page allows no writes`);
      writeFolders.length = 0;
    } else writeProtected.push(...rawProtected);
  }
  return { mode, patterns, bash, bashCommands, writeFolders, writeProtected, problems };
}

// Invisible and direction-changing characters (and C0 controls but tab and newline)
// become a visible ⟦U+XXXX⟧, so a preview can't reorder or hide what the card shows.
// Claude Code neutralises these before it relays; this is the second line, and a
// request that carries one is Deny-only.
const isHiddenChar = c => (c < 0x20 && c !== 0x09 && c !== 0x0a) || c === 0x7f || c === 0x061c || (c >= 0x200b && c <= 0x200f) ||
  (c >= 0x202a && c <= 0x202e) || (c >= 0x2060 && c <= 0x2069) || c === 0xfeff;
export function revealHidden(s) {
  let out = '';
  for (const ch of String(s ?? '')) {
    const c = ch.codePointAt(0);
    out += isHiddenChar(c) ? `⟦U+${c.toString(16).toUpperCase().padStart(4, '0')}⟧` : ch;
  }
  return out;
}
const hasHidden = s => { for (const ch of String(s ?? '')) if (isHiddenChar(ch.codePointAt(0))) return true; return false; };
// Whether any text inside a parsed value, keys included, carries a hidden character.
function anyHidden(v, depth = 0) {
  if (typeof v === 'string') return hasHidden(v);
  if (depth > 20 || v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) return v.some(x => anyHidden(x, depth + 1));
  return Object.entries(v).some(([k, x]) => hasHidden(k) || anyHidden(x, depth + 1));
}
const HIDDEN_REASON = 'it carries invisible or direction characters';

// One relayed field, hidden characters made visible, kept whole up to `max` code
// points; a longer one keeps its start and gets the marker, and says it was cut.
export function capField(v, max = FIELD_MAX) {
  const cps = codePoints(revealHidden(typeof v === 'string' ? v : ''));
  if (cps.length <= max) return { text: cps.join(''), cut: false };
  return { text: cps.slice(0, max).join('') + ' ' + cutMarker(cps.length - max), cut: true };
}

// The markers that say part of a field is not shown: Claude Code's elision, its
// credential mask and its unserializable value, the channel's and this server's cuts.
const MARKERS = [
  ['part of it was elided', /⋯ \d+ code points elided ⋯/],
  ['part of it was masked', /\[REDACTED\]/],
  ['a value could not be shown', /\(value unserializable\)/],
  ['it was cut short', /⋯ \d+ code points cut by the (?:Control Room|channel) ⋯/],
  [HIDDEN_REASON, /⟦U\+[0-9A-F]{4,6}⟧/]
];
export const markerReasons = text => MARKERS.filter(([, re]) => re.test(String(text ?? ''))).map(([why]) => why);

// The preview's top-level fields, as text, in the order a card shows them: what will
// run or change first, then the rest. null when the preview isn't a JSON object.
// The stored preview is JSON text, where a hidden character can sit as an escape
// (\u202e) that only parsing brings out: each field's name and text goes through
// `revealHidden` again here, and `hidden` says whether any value held one (Ultron 8).
export const FIELD_ORDER = ['command', 'file_path', 'notebook_path', 'url', 'path', 'pattern', 'content', 'new_string', 'old_string', 'edits', 'new_source'];
export function parsePreview(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  let v;
  try { v = JSON.parse(text); } catch { return null; }
  if (!isObject(v)) return null;
  const keys = Object.keys(v);
  const rank = k => { const i = FIELD_ORDER.indexOf(k); return i < 0 ? FIELD_ORDER.length : i; };
  keys.sort((a, b) => rank(a) - rank(b));
  return { raw: v, hidden: anyHidden(v), fields: keys.map(k => [revealHidden(k), revealHidden(typeof v[k] === 'string' ? v[k] : JSON.stringify(v[k]))]) };
}

// sha256 (hex) of what a card showed (L11): the page computes the same over the
// fields exactly as delivered, and a verdict must carry it. When the card also showed
// the exact command (from the hook's report), the hash covers that text too.
export const shownHash = (tool, description, inputPreview, exact = null) =>
  createHash('sha256').update(JSON.stringify([tool ?? '', description ?? '', inputPreview ?? '', ...(typeof exact === 'string' ? [exact] : [])])).digest('hex');

// ---- paths ----

// Where a path points, lower-cased (the disk is case-insensitive), with ~ resolved and
// a trailing slash dropped; for an absolute path also the real path of its deepest
// existing parent (symlinks, and the disk's own spelling of each name). `relative` is
// true when the path is relative: the session's working folder is unknown here, so
// only its segments can be judged. `dotdot` is true for any `..` part, in an absolute
// path too (Ultron 7): the caller makes that Deny-only.
export function pathForms(p, { home = homedir(), realpath = safeRealpath } = {}) {
  const s = String(p ?? '');
  const dotdot = s.split('/').includes('..');
  let abs = null;
  if (s === '~' || s.startsWith('~/')) abs = home + s.slice(1);
  else if (s.startsWith('/')) abs = s;
  if (abs === null) return { relative: true, dotdot, forms: [stripSlash('/' + posix.normalize(s)).toLowerCase()] };
  const norm = stripSlash(posix.normalize(abs));
  const forms = [norm.toLowerCase()];
  const real = realOfDeepest(norm, realpath);
  if (real && real.toLowerCase() !== forms[0]) forms.push(real.toLowerCase());
  return { relative: false, dotdot, forms };
}
// The native call asks the disk, so it answers each name as stored (case, and the
// letters APFS folds); Node's own realpathSync echoes the spelling it was given.
function safeRealpath(p) { try { return realpathSync.native(p); } catch { return null; } }
function realOfDeepest(p, realpath) {
  let dir = p;
  const rest = [];
  for (let i = 0; i < 64 && dir !== '/'; i++) {
    const r = realpath(dir);
    if (r) return rest.length ? posix.join(r, ...rest.reverse()) : r;
    rest.push(posix.basename(dir));
    dir = posix.dirname(dir);
  }
  return null;
}
function fileCanRun(p) { try { const st = statSync(p); return st.isFile() && (st.mode & 0o111) !== 0; } catch { return false; } }
// Whether the last part of a path is itself a symbolic link (lstat, never followed).
function pathIsLink(p) { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } }
// The repo this server runs from (lib/ is two levels down).
const OWN_REPO = fileURLToPath(new URL('../..', import.meta.url));

// Inside a write folder, the folders and file names that hold code or settings some
// tool loads without being asked (Ultron's final read, 11-11): a scheduled job, the next
// git command, the next install or deploy, or the next Claude Code session would run or
// obey what a page Allow wrote there. Names are compared lower-cased.
const CODE_FOLDERS = ['.venv', 'node_modules', '.husky', '.github', '.vscode'];
const CODE_NAMES = new Set(['claude.md', 'claude.local.md', 'agents.md', 'skill.md', '.gitignore', '.gitattributes', '.gitmodules', 'package.json', 'package-lock.json',
  'pyproject.toml', 'setup.py', 'setup.cfg', 'conftest.py', 'sitecustomize.py', 'usercustomize.py', 'makefile', 'gnumakefile',
  'wrangler.jsonc', 'wrangler.json', 'wrangler.toml', '.envrc', '_headers', '_redirects', 'pytest.ini', 'tox.ini', '.python-version']);
// Any Python module counts: one beside a job's entry point (json.py) is imported ahead of
// the standard library's, and compiled code is loaded without its source being read.
const CODE_NAME_PATTERNS = [/^requirements.*\.txt$/, /\.pth$/, /\.plist$/, /\.(py|pyc|pyw|so)$/];
// Other names for the same disk: the real path does not fold them back to /Users/…, so
// the rules written for the home folder would never see a path that goes through one.
const DISK_ALIASES = ['/system', '/.vol', '/.file', '/.nofollow', '/.resolve', '/volumes'];
const SHELL_RC = ['.zshenv', '.zshrc', '.zprofile', '.zlogin', '.zlogout', '.bashrc', '.bash_profile', '.bash_login', '.profile'];
// Rules over a lower-cased absolute (or '/'-rooted relative) path. `H` is the home.
const under = (p, dir) => p === dir || p.startsWith(dir + '/');
const hasSeg = (p, seg) => p.includes('/' + seg + '/') || p.endsWith('/' + seg);
const base = p => p.slice(p.lastIndexOf('/') + 1);
// The second layer for writes: places the page may never Allow a write to, even inside
// a write folder from config. `repoRoot` is the Control Room's own repo. Every write is
// also checked against `sensitiveWhy`.
export function protectedWhy(p, H, repoRoot = OWN_REPO) {
  const h = H.toLowerCase();
  const root = stripSlash(String(repoRoot ?? '')).toLowerCase();
  const b = base(p);
  if (hasSeg(p, '.claude')) return 'a .claude folder';
  if (b === '.mcp.json') return 'an .mcp.json';
  if (hasSeg(p, '.git')) return 'a .git folder';
  if (hasSeg(p, '.worktrees')) return 'a .worktrees folder';
  if (p.includes('/.github/workflows')) return 'a GitHub workflow';
  for (const seg of CODE_FOLDERS) if (hasSeg(p, seg)) return `a ${seg} folder`;
  if (CODE_NAMES.has(b) || CODE_NAME_PATTERNS.some(re => re.test(b))) return `a file that tools load or run by its name (${b.slice(0, 40)})`;
  if (p.includes('/machine-setup/git-hooks')) return 'the git hooks';
  if (hasSeg(p, 'machine-setup')) return 'the machine-setup repo';
  if (p.endsWith('/server/config.json')) return 'the Control Room config';
  if (p.endsWith('/bin/chat-pair')) return 'chat-pair';
  if (root && ['server', 'web', 'bin', 'mod'].some(d => under(p, `${root}/${d}`))) return 'the Control Room\'s own code';
  if (b.startsWith('approvals-') || b === 'channel-enabled' || b.endsWith('-off')) return 'a Jarvis OS flag name';
  if (SHELL_RC.includes(b)) return 'a shell startup file';
  if (under(p, h + '/.ssh') || hasSeg(p, '.ssh')) return '~/.ssh';
  if (under(p, h + '/projects/jarvis') || p.endsWith('/projects/jarvis')) return 'the jarvis repo';
  if (under(p, h + '/library/launchagents') || under(p, '/library') || under(p, '/system') || under(p, '/etc') || under(p, '/private/etc') || under(p, '/usr') || under(p, '/dev')) return 'a system folder';
  return null;
}
// Places the page may never Allow a read of, or a write to. `repoRoot` is the Control
// Room's own repo: its config and its data folder hold the board and account figures.
export function sensitiveWhy(p, H, repoRoot = OWN_REPO) {
  const h = H.toLowerCase();
  const root = stripSlash(String(repoRoot ?? '')).toLowerCase();
  if (DISK_ALIASES.some(dir => under(p, dir))) return 'another name for the disk (a path through /System, /Volumes or /.vol and the like)';
  if (under(p, h + '/.claude/channels') || p.includes('/.claude/channels')) return 'the channels folder';
  if (under(p, h + '/.claude/projects')) return 'Claude Code\'s transcripts';
  if (under(p, h + '/library')) return 'the Library folder';
  if (root && (p === `${root}/server/config.json` || under(p, `${root}/server/data`))) return 'the Control Room\'s config or data';
  if (under(p, h + '/.ssh') || hasSeg(p, '.ssh')) return '~/.ssh';
  if (under(p, h + '/.local/state/jarvis-os') || p.includes('/.local/state/jarvis-os')) return 'the Jarvis OS state folder';
  const b = base(p);
  if (b === '.env' || b.startsWith('.env.')) return 'an .env file';
  if (b.startsWith('.dev.vars')) return 'a .dev.vars file';
  if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(b) || /\.(pem|key|p12|pfx|keychain|keychain-db)$/.test(b) || ['.netrc', '.npmrc', '.pypirc', '.credentials.json'].includes(b)) return 'a key or credentials file';
  if (b.startsWith('.claude.json')) return 'Claude Code\'s account file';
  if (b === '.gitconfig' || hasSeg(p, '.config/git')) return 'the git settings';
  if (hasSeg(p, '.config/gh')) return 'the GitHub CLI settings';
  if (hasSeg(p, '.cloudflared')) return 'the Cloudflare tunnel settings';
  if (hasSeg(p, '.aws')) return 'the AWS settings';
  if (hasSeg(p, '.docker')) return 'the Docker settings';
  if (b.endsWith('_history')) return 'a history file';
  if (hasSeg(p, 'browser-profile')) return 'a browser profile';
  if (hasSeg(p, '.wrangler')) return 'the Wrangler state folder';
  if (hasSeg(p, '.gnupg')) return 'the GnuPG folder';
  if (hasSeg(p, '.config/gcloud')) return 'the Google Cloud settings';
  if (hasSeg(p, '.local/bin')) return 'a folder of commands (~/.local/bin)';
  if (under(p, '/opt/homebrew')) return 'Homebrew';
  if (b === '.tmux.conf') return 'the tmux settings';
  return null;
}
// Whether a folder holds one of the home's protected places, so a search or a
// recursive listing rooted there would reach it.
const coveredPlaces = (h, root) => [`${h}/.ssh`, `${h}/.claude/channels`, `${h}/.local/state/jarvis-os`, `${h}/.claude.json`, `${h}/.gitconfig`, `${h}/.config/git`,
  `${h}/.config/gh`, `${h}/.cloudflared`, `${h}/.aws`, `${h}/.docker`, `${h}/.local/bin`, `${h}/.tmux.conf`, '/opt/homebrew',
  ...(root ? [`${root}/server/config.json`, `${root}/server/data`] : [])];
// (The other private places, ~/Library, ~/.claude/projects, ~/.gnupg and ~/.config/gcloud,
// sit under folders this list already makes Deny-only as a search root.)
export const coversProtected = (p, H, repoRoot = OWN_REPO) => p === '/' ||
  coveredPlaces(H.toLowerCase(), stripSlash(String(repoRoot ?? '')).toLowerCase()).some(place => place !== p && place.startsWith(p + '/'));

// ---- Bash ----

// Claude Code folds each run of whitespace in a relayed preview to one space (channels
// reference), so a two-line command can arrive looking like one: "cat a.txt" then
// "rm -rf x" reads "cat a.txt rm -rf x" (Ultron H-a). Two answers, the first the default:
//   deny   Bash is never allowed from the page (config `chat.approvalsBash`, default).
//   exact  the page may allow a Bash request only when the hook's report gave its exact
//          text (lib/exact-commands.mjs; no report, or two that differ: Deny-only), and
//          then only in two tiers. Tier 1: one line that passes the grammar below, which
//          is sound once the line breaks are known: a listed command, only that
//          command's own options, exactly spelled, and every other word an absolute path
//          that passes the path rules and is not a file that can be run; no command that
//          takes a free word is listed (grep, rg, echo, which). Tier 2: a command that
//          equals, character for character, one listed in config's
//          `chat.approvalsBashCommands` (none by default). Everything else is Deny-only.
// Shell metacharacters (; | & $ ` > < ( ) and line breaks), and what would hide a path
// from the checks: quotes, backslashes, globs, braces and tabs.
const SHELL_SYNTAX = /[;|&$`><()\n\r\t\\'"*?[\]{}!]/;
const INT = /^[0-9]{1,6}$/;
const letters = set => new RegExp(`^-[${set}]+$`);
// name -> { flags: exact options, letters: single-letter options that may be joined,
// ints: options that take a number, dashInt: -5 style, paths: [min, max], write }.
export const BASH_COMMANDS = Object.freeze({
  pwd: { paths: [0, 0] },
  date: { flags: ['-u'], paths: [0, 0] },
  ls: { letters: letters('1AaFGhlRrSTtd'), paths: [0, 20] },
  cat: { flags: ['-n', '-b'], paths: [1, 20] },
  head: { ints: ['-n', '-c'], dashInt: true, paths: [1, 20] },
  tail: { ints: ['-n', '-c'], dashInt: true, paths: [1, 20] },
  wc: { letters: letters('lwcm'), paths: [1, 20] },
  stat: { paths: [1, 20] },
  file: { paths: [1, 20] },
  du: { letters: letters('shk'), paths: [1, 20] },
  df: { letters: letters('hk'), paths: [0, 20] },
  diff: { letters: letters('urq'), paths: [2, 2] },
  touch: { paths: [1, 20], write: true },
  mkdir: { flags: ['-p'], paths: [1, 20], write: true }
});
export const GIT_SUBCOMMANDS = Object.freeze({
  status: { flags: ['-s', '--short', '--porcelain', '-b', '--branch', '-sb'], revs: 0 },
  diff: { flags: ['--stat', '--cached', '--staged', '--name-only', '--name-status'], revs: 2 },
  log: { flags: ['--oneline', '--stat', '--name-only'], ints: ['-n'], dashInt: true, revs: 1 },
  show: { flags: ['--stat', '--name-only', '--oneline'], revs: 1 },
  'rev-parse': { flags: ['--short', '--abbrev-ref', '--show-toplevel'], revs: 1 }
});
const GIT_REV = /^(?:HEAD(?:[~^][0-9]{0,3})?|[0-9a-f]{7,40})$/;
const short = w => String(w).slice(0, 40);

// One option word against a spec; answers how many words it used (1 or 2), or 0 with
// the problem pushed.
function takeOption(spec, name, words, i, problems) {
  const w = words[i];
  if (spec.flags?.includes(w) || spec.letters?.test(w)) return 1;
  if (spec.ints?.includes(w)) {
    if (INT.test(words[i + 1] ?? '')) return 2;
    problems.push(`${w} needs a number`);
    return 1;
  }
  if (spec.ints?.some(o => w.startsWith(o) && INT.test(w.slice(o.length)))) return 1;
  if (spec.dashInt && /^-[0-9]{1,4}$/.test(w)) return 1;
  problems.push(`the option ${w.slice(0, 20)} is not one of ${name}'s`);
  return 1;
}

// A command against the strict grammar: { problems, paths: [{ path, write }] }.
export function bashGrammar(cmd) {
  const words = String(cmd ?? '').trim().split(/ +/);
  const problems = [];
  const paths = [];
  const name = words[0];
  const notPath = w => problems.push(`"${short(w)}" is not an absolute path (only options and absolute paths can be allowed here)`);
  if (name === 'git') {
    let i = 1;
    if (words[i] === '-C') {
      if (isAbsolute(words[i + 1])) paths.push({ path: words[i + 1], write: false });
      else notPath(words[i + 1] ?? '');
      i += 2;
    }
    const sub = words[i];
    const spec = Object.hasOwn(GIT_SUBCOMMANDS, sub ?? '') ? GIT_SUBCOMMANDS[sub] : null;
    if (!spec) { problems.push('only git status, diff, log, show and rev-parse'); return { problems, paths }; }
    let revs = 0;
    for (i += 1; i < words.length;) {
      const w = words[i];
      if (w.startsWith('-')) { i += takeOption(spec, `git ${sub}`, words, i, problems); continue; }
      if (GIT_REV.test(w) && revs < spec.revs) revs += 1;
      else problems.push(`git ${sub} takes only its own options${spec.revs ? ', and HEAD or a commit id' : ''}: not "${short(w)}"`);
      i += 1;
    }
    return { problems, paths };
  }
  const spec = Object.hasOwn(BASH_COMMANDS, name) ? BASH_COMMANDS[name] : null;
  if (!spec) { problems.push(`"${short(name)}" is not on the short list of commands`); return { problems, paths }; }
  for (let i = 1; i < words.length;) {
    const w = words[i];
    if (w.startsWith('-')) { i += takeOption(spec, name, words, i, problems); continue; }
    if (isAbsolute(w)) paths.push({ path: w, write: spec.write === true });
    else notPath(w);
    i += 1;
  }
  const [min, max] = spec.paths;
  if (max === 0 && words.length > 1 && paths.length > 0) problems.push(`${name} takes no paths`);
  else if (paths.length < min) problems.push(min === max ? `${name} needs exactly ${min} paths` : `${name} needs at least one path`);
  else if (paths.length > max) problems.push(min === max ? `${name} needs exactly ${min} paths` : `${name} takes at most ${max} paths`);
  return { problems, paths };
}

// ---- the rules ----

// The inputs each tool is known to take; any other key is Deny-only (Ultron 9).
export const TOOL_KEYS = Object.freeze({
  Bash: ['command', 'description', 'timeout'],
  Edit: ['file_path', 'old_string', 'new_string', 'replace_all'],
  MultiEdit: ['file_path', 'edits'],
  Write: ['file_path', 'content'],
  NotebookEdit: ['notebook_path', 'new_source', 'cell_id', 'cell_type', 'edit_mode'],
  Read: ['file_path', 'offset', 'limit', 'pages', 'allow_large'],
  Glob: ['pattern', 'path'],
  Grep: ['pattern', 'path', 'glob', 'type', 'output_mode', '-i', '-n', '-A', '-B', '-C', 'context', 'head_limit', 'offset', 'multiline'],
  WebFetch: ['url', 'prompt'],
  WebSearch: ['query', 'allowed_domains', 'blocked_domains']
});
const CHANNEL_KEYS = ['chat_id', 'text', 'reply_to', 'files', 'message_id', 'emoji', 'limit', 'before', 'channel'];

export const WEBFETCH_HOSTS = new Set(['code.claude.com', 'docs.anthropic.com', 'github.com', 'raw.githubusercontent.com', 'developer.mozilla.org', 'nodejs.org', 'www.npmjs.com', 'pypi.org']);
const CHANNEL_TOOL = /^mcp__plugin_(?:jarvis-channel_jarvis|discord_discord)__[a-z_]{1,40}$/;
const NOT_PLAIN = 'characters outside plain ASCII';
// What a Grep `glob` may end in when it has a wildcard: *.ext (one or more dotted parts).
const STAR_EXT = /^\*(\.[A-Za-z0-9_-]+)+$/;

// Why the page may only Deny this request, as short phrases; empty means Allow may
// be offered (mode and window permitting). `req` is the stored request: { tool,
// description, inputPreview, cut }. `writeFolders` are config's (none: no page Allow
// for any write) and `writeProtected` the places inside them config protects; `bash`
// is "deny" or "exact", `exact` the command's exact text from the hook's report (or
// null, with `exactProblem` saying why) and `bashCommands` config's listed commands;
// `isExecutable(path)` says whether an absolute path is a file that can be run, and
// `isLink(path)` whether its last part is a symbolic link.
export const NO_EXACT = 'no exact copy of this command came from the hook (answer at the terminal or in Discord)';
export function denyOnlyReasons(req, {
  home = homedir(), realpath = safeRealpath, patterns = [], writeFolders = [], writeProtected = [], bash = 'deny', exact = null, exactProblem = null,
  bashCommands = [], repoRoot = OWN_REPO, isExecutable = fileCanRun, isLink = pathIsLink
} = {}) {
  const reasons = [];
  const add = r => { if (!reasons.includes(r)) reasons.push(r); };
  const tool = String(req?.tool ?? '');
  if (req?.cut) add('it was cut short');
  for (const field of [req?.description, req?.inputPreview]) for (const r of markerReasons(field)) add(r);
  const lowered = `${req?.description ?? ''}\n${req?.inputPreview ?? ''}`.toLowerCase();
  for (const p of patterns) if (lowered.includes(p)) add('it matches a Deny-only pattern in config');
  const parsed = parsePreview(req?.inputPreview);
  if (!parsed) { add('its arguments could not be read'); return reasons; }
  if (parsed.hidden) add(HIDDEN_REASON);
  const v = parsed.raw;
  const opts = { home, realpath };
  const writeForms = (Array.isArray(writeFolders) ? writeFolders : []).filter(f => okWriteFolder(f, home, { repoRoot, realpath })).flatMap(f => pathForms(f, opts).forms);
  // (Config's reader refuses a list with a bad entry; here an odd one can only protect more.)
  const protectedForms = (Array.isArray(writeProtected) ? writeProtected : []).flatMap(f => pathForms(f, opts).forms);
  const outboxForms = pathForms(`${home}/.local/state/jarvis/outbox`, opts).forms;
  const projectsForms = pathForms(`${home}/Projects`, opts).forms;
  const onDisk = p => stripSlash(p === '~' || p.startsWith('~/') ? home + p.slice(1) : p);
  const keysOf = allowed => {
    for (const k of Object.keys(v).filter(k => !allowed.includes(k)).slice(0, 3)) add(`the input "${revealHidden(k).slice(0, 40)}" is not one this tool is known to take`);
  };
  // One path: plain ASCII, no `..`, and the rules for where it points. A write must
  // also sit inside a write folder, by its own spelling and by its real path. `guard`
  // applies the write layer's protected places to a read too: Bash gets it for every
  // path, since a word in a command may be more than a file to read.
  const checkPath = (p, { write = false, guard = write } = {}) => {
    if (typeof p !== 'string' || p === '') return;
    if (!plainAscii(p)) { add(`a path with ${NOT_PLAIN}`); return; }
    const f = pathForms(p, opts);
    if (f.dotdot) add('a path with ..');
    // The relay folds whitespace, so a write path with a space may not be the real one.
    if (write && p.includes(' ')) add('a write path with a space in it (the relay folds spaces)');
    if (!f.relative) {
      let link = true;
      try { link = isLink(onDisk(p)) === true; } catch { link = true; }
      if (link) add('a path whose last part is a link');
    }
    if (write && !f.forms.every(form => writeForms.some(dir => under(form, dir)))) add('it writes outside the folders the page may allow writes in');
    if (write && !f.relative) {
      // An existing file that can be run: a job, a hook or a person may run it later.
      let runs = true;
      try { runs = isExecutable(onDisk(p)) === true; } catch { runs = true; }
      if (runs) add('it changes a file that can be run');
    }
    for (const form of f.forms) {
      const w = guard ? protectedWhy(form, home, repoRoot) : null;
      const r = sensitiveWhy(form, home, repoRoot);
      if (w) add(`it touches ${w}`);
      if (write && protectedForms.some(place => under(form, place))) add('it touches a place config protects inside the write folders');
      if (r) add(`it ${write ? 'touches' : 'reads'} ${r}`);
      if (!write && !f.relative && coversProtected(form, home, repoRoot)) add('its folder holds protected files');
    }
  };
  // A Glob pattern or a Grep glob: relative, plain, no `..`; its folders literal or a
  // whole `**`, wildcards only in the last part. Grep reads what its glob picks, so
  // there the last part is a literal name or `*.ext`, and neither may pick key files.
  const checkPattern = (pat, { reads }) => {
    if (typeof pat !== 'string' || pat === '') return;
    if (!plainAscii(pat)) { add(`a pattern with ${NOT_PLAIN}`); return; }
    if (pat.startsWith('/') || pat.startsWith('~')) { add('a pattern that names its own folder (only one under the folder shown can be allowed)'); return; }
    const parts = pat.split('/');
    if (parts.includes('..')) add('a path with ..');
    if (parts.slice(0, -1).some(s => s !== '**' && WILDCARD.test(s))) add('a wildcard in a folder name');
    const last = parts[parts.length - 1];
    if (reads && WILDCARD.test(last) && !STAR_EXT.test(last)) add('a wildcard that could pick any file (a search can be allowed for a name or *.ext only)');
    // The key-file rules read the ending, so `*.pem` is caught as it stands.
    const r = sensitiveWhy('/' + pat.toLowerCase(), home, repoRoot);
    if (r) add(`it reads ${r}`);
  };

  if (tool === 'Bash') {
    keysOf(TOOL_KEYS.Bash);
    const cmd = v.command;
    if (typeof cmd !== 'string' || cmd.trim() === '') { add('no command to show'); return reasons; }
    // What the rules below read: the preview's command, or in "exact" mode the exact
    // text, which must be the hook's report of this very command.
    let text = cmd;
    if (bash !== 'exact') add('Bash is answered at the terminal or in Discord (a relayed command may have lost its line breaks)');
    else {
      if (typeof exact !== 'string') { add(typeof exactProblem === 'string' && exactProblem ? exactProblem : NO_EXACT); return reasons; }
      if (!exactTextOk(exact)) { add('the exact command has characters outside plain ASCII, line breaks and tabs'); return reasons; }
      if (foldWhitespace(exact) !== cmd && exact !== cmd) { add('the exact command does not match the preview'); return reasons; }
      // Tier 2: a command the owner listed, character for character.
      if ((Array.isArray(bashCommands) ? bashCommands : []).includes(exact)) return reasons;
      if (/[\n\t]/.test(exact)) { add('it has more than one line, or a tab, and is not a command listed in config'); return reasons; }
      text = exact;
    }
    const syntax = SHELL_SYNTAX.test(text);
    if (syntax) add('it uses shell syntax (only one plain command can be allowed here)');
    const plain = plainAscii(text.replace(/[\n\r\t]/g, ' '));
    if (!plain) add(`a command with ${NOT_PLAIN}`);
    if (syntax || !plain) return reasons;
    const g = bashGrammar(text);
    for (const p of g.problems) add(p);
    for (const { path, write } of g.paths) {
      checkPath(path, { write, guard: true });
      let runs = true;
      try { runs = isExecutable(onDisk(path)); } catch { runs = true; }
      if (runs) add('it names a file that can be run');
    }
    return reasons;
  }
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    keysOf(TOOL_KEYS[tool]);
    const p = tool === 'NotebookEdit' ? v.notebook_path : v.file_path;
    if (!isAbsolute(p) || p === '~') { add('no absolute path to show'); return reasons; }
    checkPath(p, { write: true });
    return reasons;
  }
  if (tool === 'Read') {
    keysOf(TOOL_KEYS.Read);
    if (!isAbsolute(v.file_path)) { add('no absolute path to show'); return reasons; }
    checkPath(v.file_path);
    return reasons;
  }
  if (tool === 'Glob' || tool === 'Grep') {
    keysOf(TOOL_KEYS[tool]);
    // Without a folder the search runs in the session's working folder, unknown here.
    if (!isAbsolute(v.path)) add('no absolute folder to show');
    else {
      if (WILDCARD.test(v.path)) add('a wildcard in the folder');
      checkPath(v.path);
      // The whole Projects folder is too wide a search: every repo, private ones too.
      if (plainAscii(v.path) && pathForms(v.path, opts).forms.some(form => projectsForms.includes(form))) add('a search of the whole Projects folder');
    }
    if (tool === 'Glob') {
      if (typeof v.pattern !== 'string' || v.pattern === '') add('no pattern to show');
      checkPattern(v.pattern, { reads: false });
    } else if (v.glob !== undefined) {
      if (typeof v.glob !== 'string') add('its glob could not be read');
      checkPattern(v.glob, { reads: true });
    }
    return reasons;
  }
  if (tool === 'WebFetch') {
    keysOf(TOOL_KEYS.WebFetch);
    let u = null;
    try { u = new URL(String(v.url)); } catch { u = null; }
    if (!u || u.protocol !== 'https:' || u.username || u.password) add('only a plain https address');
    else {
      if (u.search !== '') add('the address has a query string');
      if (!WEBFETCH_HOSTS.has(u.hostname.toLowerCase())) add(`${u.hostname.slice(0, 60)} is not on the short list of sites`);
    }
    return reasons;
  }
  if (tool === 'WebSearch') { keysOf(TOOL_KEYS.WebSearch); return reasons; }
  if (CHANNEL_TOOL.test(tool)) {
    keysOf(CHANNEL_KEYS);
    if (v.files !== undefined) {
      if (!Array.isArray(v.files) || !v.files.every(f => typeof f === 'string')) add('its files could not be read');
      else for (const f of v.files) {
        if (!isAbsolute(f) || f === '~') { add('no absolute path to show'); continue; }
        checkPath(f);
        // A reply can attach any file the session can read: only the outbox, the folder
        // made for sending, by the path as written and by its real path (Ultron, 11-11).
        if (!plainAscii(f) || !pathForms(f, opts).forms.every(form => outboxForms.some(dir => form !== dir && under(form, dir)))) add('it attaches a file from outside the outbox folder');
      }
    }
    return reasons;
  }
  add('a tool the page does not know');
  return reasons;
}

// The "why it's asking" line from a recent classifier block for the same tool: the
// rule's name when the hook gave one in brackets, else the fixed words for the two
// known kinds. The hook's other text is never kept.
export function blockReasonWords(reason) {
  const r = String(reason ?? '');
  const m = /^\[([A-Za-z][A-Za-z /-]{0,58})\]$/.exec(r.trim());
  if (m) return m[1];
  if (r.startsWith('Auto mode could not evaluate this action')) return 'auto mode could not evaluate it';
  if (r === 'Classifier unavailable') return 'the classifier was unavailable';
  return null;
}

// The Origin rule for verdicts (G2): required, https, one of config's allowed hosts;
// Sec-Fetch-Site, when sent, same-origin. Answers null or the refusal's words.
export function verdictOriginProblem(headers, allowedHosts) {
  const origin = headers?.origin;
  if (typeof origin !== 'string' || origin === '' || origin === 'null') return 'a verdict must come from the page (no Origin)';
  let u;
  try { u = new URL(origin); } catch { return 'a verdict must come from the page (bad Origin)'; }
  if (u.protocol !== 'https:') return 'a verdict must come from the https page';
  const host = u.host.toLowerCase();
  if (!(allowedHosts.has(host) || (u.port === '' && allowedHosts.has(`${u.hostname.toLowerCase()}:443`)))) return 'a verdict must come from the page\'s own address';
  const site = headers?.['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin') return 'a verdict must come from the page itself';
  return null;
}

// The gate: mode (with the kill file and the channel's relay mode), the classifier-block window, the flood rule,
// per-device limits and lockout, refusals with no device, and the allow-burst alert.
// `onEvent` hears { kind } for each thing worth an alert. `isLead(id)` is the cautious
// test the block window uses (the lead's session, or one nobody can name);
// `isLeadSession(id)` is the strict one for exact-command reports: the lead's session
// by name, and nothing else.
export function createApprovals({
  mode = 'off', killPath = null, patterns = [], home = homedir(), realpath = safeRealpath,
  now = () => Date.now(), onEvent = () => {}, exists = existsSync, isLead = () => true,
  bash = 'deny', writeFolders = [], repoRoot = OWN_REPO, isExecutable = fileCanRun,
  writeProtected = [], bashCommands = [], isLeadSession = () => false, isLink = pathIsLink
} = {}) {
  const configured = APPROVAL_MODES.includes(mode) ? mode : 'off';
  const bashMode = BASH_MODES.includes(bash) ? bash : 'deny';
  // The hook's reports of exact Bash commands: memory only, two minutes, the lead's.
  const exactReports = createExactCommands({ now });
  const previewCommand = p => { const c = parsePreview(p?.inputPreview)?.raw?.command; return typeof c === 'string' ? c : null; };
  const EXACT_CONFLICT = 'two different exact copies of this command were reported (answer at the terminal or in Discord)';
  // What the channel last said its relay does: null until its first hello, then
  // "off", "deny", "allow" or "unknown" (a channel that didn't say).
  let channelRelay = null;
  let lastKilled = null;
  let blockUntil = 0;
  let lastBlock = null; // { at, tool, why }
  let floodUntil = 0;
  const perDevice = new Map(); // id -> { taps: [at], refusals: [at], lockedUntil }
  let anonymous = [];          // times of refusals with no device
  let anonymousAlertedAt = 0;
  let allows = [];
  let burstAlertedAt = 0;

  const killed = () => {
    let k = false;
    try { k = Boolean(killPath) && exists(killPath); } catch { k = true; }
    if (lastKilled !== null && k !== lastKilled) onEvent({ kind: 'approvals-kill', on: k });
    lastKilled = k;
    return k;
  };
  // Config and the kill file alone, and then with the channel's word: "on" needs a
  // channel that says it delivers Allow.
  const serverMode = () => (killed() ? 'off' : configured);
  const current = () => { const m = serverMode(); return m === 'on' && channelRelay !== 'allow' ? 'deny' : m; };
  const device = id => {
    if (!perDevice.has(id)) perDevice.set(id, { taps: [], refusals: [], lockedUntil: 0 });
    return perDevice.get(id);
  };
  const recent = (list, ms, at) => list.filter(t => at - t < ms);

  // Why Allow is out now for this request: its own reasons plus the moment's.
  function reasonsNow(p, at = now()) {
    const out = [...(p.denyOnly ?? [])];
    // A card that shows an exact command: a second, different report for the same
    // preview since it opened means one of the two is not what will run. Sticky.
    if (typeof p.exact === 'string' && !p.exactConflict) {
      const c = exactReports.candidates(previewCommand(p), p.relayedAt ?? p.openedAt ?? at);
      if (c.unusable || c.texts.some(t => t !== p.exact)) {
        p.exactConflict = true;
        onEvent({ kind: 'approvals-exact-conflict' });
      }
    }
    if (p.exactConflict) out.push(EXACT_CONFLICT);
    if (channelRelay !== 'allow') out.push(channelRelay === 'deny' ? 'the channel delivers Deny only' : 'the channel has not said it can deliver Allow');
    if (at < blockUntil) out.push('auto mode blocked something in the last 15 minutes');
    if (at < floodUntil) out.push('too many requests at once');
    return out;
  }

  return {
    configured,
    mode: current,
    serverMode,
    killed,
    // The channel's relay mode, from its hello or a heartbeat. A change after the
    // first report is an event.
    noteChannelRelay(value) {
      const next = ['off', 'deny', 'allow'].includes(value) ? value : 'unknown';
      if (channelRelay !== null && next !== channelRelay) onEvent({ kind: 'approvals-relay', relay: next, previous: channelRelay });
      channelRelay = next;
      return next;
    },
    get channelRelay() { return channelRelay ?? 'unknown'; },
    // At open: the request's own reasons and why it is asking, if a block explains it.
    assess(p) {
      const at = now();
      // In "exact" mode a Bash request is matched, by content, to the hook's reports:
      // exactly one usable text, or it stays Deny-only (two that differ: also an alert).
      let exact = null;
      let exactProblem = null;
      if (bashMode === 'exact' && p?.tool === 'Bash') {
        const cmd = previewCommand(p);
        if (markerReasons(p.inputPreview).length > 0) exactProblem = 'part of the command is hidden in the preview, so its exact copy is not used';
        else if (cmd !== null) {
          const c = exactReports.candidates(cmd, p.relayedAt ?? at);
          if (c.conflict) { exactProblem = EXACT_CONFLICT; onEvent({ kind: 'approvals-exact-conflict' }); }
          else if (c.unusable) exactProblem = 'the exact command has characters outside plain ASCII, line breaks and tabs';
          else if (c.texts.length === 1) exact = c.texts[0];
        }
      }
      const denyOnly = denyOnlyReasons(p, { home, realpath, patterns, writeFolders, writeProtected, bash: bashMode, exact, exactProblem, bashCommands, repoRoot, isExecutable, isLink });
      const why = lastBlock && at - lastBlock.at <= WHY_WINDOW_MS && lastBlock.tool === p.tool
        ? `Auto mode refused this ${lastBlock.tool} call${lastBlock.why ? ` (${lastBlock.why})` : ''}, so Claude Code is asking you`
        : null;
      return { denyOnly, why, exact };
    },
    // A report from the PermissionRequest hook: { sessionId, command }. Kept only in
    // "exact" mode with approvals on, and only from the lead's session; answers
    // "kept", "off" or "other". The text is never logged.
    noteExact({ sessionId, command } = {}) {
      if (bashMode !== 'exact' || serverMode() === 'off') return 'off';
      let lead = false;
      try { lead = isLeadSession(sessionId) === true; } catch { lead = false; }
      if (!lead) return 'other';
      exactReports.note(command);
      return 'kept';
    },
    bashMode,
    // A PermissionDenied hook event: { sessionId, tool, reason, at }. Only blocks in
    // the lead's session (or one that can't be told apart from it) open the window.
    noteBlock({ sessionId, tool, reason }) {
      if (!isLead(sessionId)) return false;
      const at = now();
      blockUntil = at + BLOCK_WINDOW_MS;
      lastBlock = { at, tool: typeof tool === 'string' ? tool : null, why: blockReasonWords(reason) };
      return true;
    },
    noteOpenCount(n) {
      if (n > FLOOD_OPEN && now() >= floodUntil) {
        floodUntil = now() + FLOOD_MS;
        onEvent({ kind: 'approvals-flood', open: n });
      }
    },
    reasonsNow,
    view(p, at = now()) {
      const m = current();
      const reasons = reasonsNow(p, at);
      return { mode: m, denyOnly: reasons, canAllow: m === 'on' && reasons.length === 0 && p.state === 'open' };
    },
    status: (at = now()) => ({ mode: current(), relay: channelRelay ?? 'unknown', denyOnlyUntil: Math.max(blockUntil, floodUntil) > at ? Math.max(blockUntil, floodUntil) : null }),
    // Before a device's verdict: locked out, or over its limits? Answers null or { status, error }.
    check(id) {
      const at = now();
      const d = device(id);
      if (at < d.lockedUntil) return { status: 429, error: 'this device is locked out of approvals for a while after too many refused taps' };
      d.taps = recent(d.taps, 3600e3, at);
      if (recent(d.taps, 60e3, at).length >= VERDICTS_PER_MINUTE) return { status: 429, error: 'too many taps this minute' };
      if (d.taps.length >= VERDICTS_PER_HOUR) return { status: 429, error: 'too many taps this hour' };
      return null;
    },
    noteTap(id) { device(id).taps.push(now()); },
    // A refused verdict from a known device: 10 in 10 minutes lock it out, alerted.
    noteRefusal(id, name) {
      const at = now();
      const d = device(id);
      d.refusals = [...recent(d.refusals, REFUSAL_WINDOW_MS, at), at];
      if (d.refusals.length >= REFUSALS_FOR_LOCKOUT && at >= d.lockedUntil) {
        d.lockedUntil = at + LOCKOUT_MS;
        d.refusals = [];
        onEvent({ kind: 'approvals-lockout', device: name });
      }
    },
    // A refusal with no paired device behind it (L: it can lock nobody out). Alerted
    // once per window when they pile up.
    noteAnonymousRefusal() {
      const at = now();
      anonymous = [...recent(anonymous, REFUSAL_WINDOW_MS, at), at];
      if (anonymous.length >= REFUSALS_FOR_LOCKOUT && at - anonymousAlertedAt >= REFUSAL_WINDOW_MS) {
        anonymousAlertedAt = at;
        onEvent({ kind: 'approvals-anonymous', count: anonymous.length });
      }
    },
    noteAllow() {
      const at = now();
      allows = [...recent(allows, ALLOW_BURST_WINDOW_MS, at), at];
      if (allows.length > ALLOW_BURST && at - burstAlertedAt >= ALLOW_BURST_WINDOW_MS) {
        burstAlertedAt = at;
        onEvent({ kind: 'approvals-burst', count: allows.length });
      }
    }
  };
}
