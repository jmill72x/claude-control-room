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
//   - the channel's own mode, set by the lead's launcher (not visible here).
// While off, both permission routes answer 403, so the channel stops retrying and the
// prompt stays in the terminal and Discord.
//
// Allow is further limited to what passes `denyOnlyReasons`: a short allowlist, not a
// security boundary. It makes the riskiest requests need the terminal or Discord, so a
// stolen phone or a careless tap can't grant them.
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix } from 'node:path';

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

// What config says: the mode and anything to log. Unknown values are off.
export function readApprovalsConfig(config) {
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
  return { mode, patterns, problems };
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
  ['it carries invisible or direction characters', /⟦U\+[0-9A-F]{4,6}⟧/]
];
export const markerReasons = text => MARKERS.filter(([, re]) => re.test(String(text ?? ''))).map(([why]) => why);

// The preview's top-level fields, as text, in the order a card shows them: what will
// run or change first, then the rest. null when the preview isn't a JSON object.
export const FIELD_ORDER = ['command', 'file_path', 'notebook_path', 'url', 'path', 'pattern', 'content', 'new_string', 'old_string', 'edits', 'new_source'];
export function parsePreview(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  let v;
  try { v = JSON.parse(text); } catch { return null; }
  if (!isObject(v)) return null;
  const keys = Object.keys(v);
  const rank = k => { const i = FIELD_ORDER.indexOf(k); return i < 0 ? FIELD_ORDER.length : i; };
  keys.sort((a, b) => rank(a) - rank(b));
  return { raw: v, fields: keys.map(k => [k, typeof v[k] === 'string' ? v[k] : JSON.stringify(v[k])]) };
}

// sha256 (hex) of what a card showed (L11): the page computes the same over the
// fields exactly as delivered, and a verdict must carry it.
export const shownHash = (tool, description, inputPreview) =>
  createHash('sha256').update(JSON.stringify([tool ?? '', description ?? '', inputPreview ?? ''])).digest('hex');

// ---- paths ----

// Where a path points, lower-cased (the disk is case-insensitive), with ~ and ..
// resolved; for an absolute path also the real path of its deepest existing parent
// (symlinks). `relative` is true when the path is relative: the session's working
// folder is unknown here, so only its segments can be judged.
export function pathForms(p, { home = homedir(), realpath = safeRealpath } = {}) {
  const s = String(p ?? '');
  let abs = null;
  if (s === '~' || s.startsWith('~/')) abs = home + s.slice(1);
  else if (s.startsWith('/')) abs = s;
  if (abs === null) {
    const segs = s.split('/');
    return { relative: true, dotdot: segs.includes('..'), forms: ['/' + posix.normalize(s).toLowerCase()] };
  }
  const norm = posix.normalize(abs);
  const forms = [norm.toLowerCase()];
  const real = realOfDeepest(norm, realpath);
  if (real && real.toLowerCase() !== forms[0]) forms.push(real.toLowerCase());
  return { relative: false, dotdot: false, forms };
}
function safeRealpath(p) { try { return realpathSync(p); } catch { return null; } }
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

const SHELL_RC = ['.zshenv', '.zshrc', '.zprofile', '.zlogin', '.zlogout', '.bashrc', '.bash_profile', '.bash_login', '.profile'];
// Rules over a lower-cased absolute (or '/'-rooted relative) path. `H` is the home.
const under = (p, dir) => p === dir || p.startsWith(dir + '/');
const hasSeg = (p, seg) => p.includes('/' + seg + '/') || p.endsWith('/' + seg);
const base = p => p.slice(p.lastIndexOf('/') + 1);
// Paths the page may never Allow a write to (or, for Bash, any mention of). Every
// write is also checked against `sensitiveWhy`, which holds ~/.ssh's siblings such as
// the Jarvis OS state folder (its flags, sockets and reviewed hash).
export function protectedWhy(p, H) {
  const h = H.toLowerCase();
  if (hasSeg(p, '.claude')) return 'a .claude folder';
  if (base(p) === '.mcp.json') return 'an .mcp.json';
  if (hasSeg(p, '.git')) return 'a .git folder';
  if (p.includes('/.github/workflows')) return 'a GitHub workflow';
  if (p.includes('/machine-setup/git-hooks')) return 'the git hooks';
  if (p.endsWith('/server/config.json')) return 'the Control Room config';
  if (p.endsWith('/bin/chat-pair')) return 'chat-pair';
  if (SHELL_RC.includes(base(p))) return 'a shell startup file';
  if (under(p, h + '/.ssh') || hasSeg(p, '.ssh')) return '~/.ssh';
  if (under(p, h + '/projects/jarvis') || p.endsWith('/projects/jarvis')) return 'the jarvis repo';
  if (under(p, h + '/library/launchagents') || under(p, '/library') || under(p, '/system') || under(p, '/etc') || under(p, '/private/etc') || under(p, '/usr')) return 'a system folder';
  return null;
}
// Paths the page may never Allow a read of.
export function sensitiveWhy(p, H) {
  const h = H.toLowerCase();
  if (under(p, h + '/.claude/channels') || p.includes('/.claude/channels')) return 'the channels folder';
  if (under(p, h + '/.ssh') || hasSeg(p, '.ssh')) return '~/.ssh';
  if (under(p, h + '/.local/state/jarvis-os') || p.includes('/.local/state/jarvis-os')) return 'the Jarvis OS state folder';
  const b = base(p);
  if (b === '.env' || b.startsWith('.env.')) return 'an .env file';
  if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(b) || /\.(pem|key|p12|pfx|keychain|keychain-db)$/.test(b) || ['.netrc', '.npmrc', '.pypirc'].includes(b)) return 'a key or credentials file';
  return null;
}

// Bash: one plain command, no shell syntax, its first word on a short list (M5).
export const BASH_FIRST_WORDS = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'diff', 'stat', 'file', 'pwd', 'date', 'echo', 'touch', 'mkdir', 'which', 'du', 'df', 'git']);
export const GIT_SUBCOMMANDS = new Set(['status', 'diff', 'log', 'show', 'rev-parse']);
// Shell metacharacters (; | & $ ` > < ( ) newline), and the ones that would hide a
// path from the checks below: quotes, backslashes, globs and braces.
const SHELL_SYNTAX = /[;|&$`><()\n\r\\'"*?[\]{}!]/;
const RISKY_OPTIONS = [/^--output/, /^--pre$/, /^--pre=/, /^--exec/, /^-c$/];

export const WEBFETCH_HOSTS = new Set(['code.claude.com', 'docs.anthropic.com', 'github.com', 'raw.githubusercontent.com', 'developer.mozilla.org', 'nodejs.org', 'www.npmjs.com', 'pypi.org']);
const CHANNEL_TOOL = /^mcp__plugin_(?:jarvis-channel_jarvis|discord_discord)__[a-z_]{1,40}$/;

// Why the page may only Deny this request, as short phrases; empty means Allow may
// be offered (mode and window permitting). `req` is the stored request: { tool,
// description, inputPreview, cut }.
export function denyOnlyReasons(req, { home = homedir(), realpath = safeRealpath, patterns = [] } = {}) {
  const reasons = [];
  const add = r => { if (!reasons.includes(r)) reasons.push(r); };
  const tool = String(req?.tool ?? '');
  if (req?.cut) add('it was cut short');
  for (const field of [req?.description, req?.inputPreview]) for (const r of markerReasons(field)) add(r);
  const lowered = `${req?.description ?? ''}\n${req?.inputPreview ?? ''}`.toLowerCase();
  for (const p of patterns) if (lowered.includes(p)) add('it matches a Deny-only pattern in config');
  const parsed = parsePreview(req?.inputPreview);
  if (!parsed) { add('its arguments could not be read'); return reasons; }
  const v = parsed.raw;
  const opts = { home, realpath };
  const checkPath = (p, { write, read }) => {
    if (typeof p !== 'string' || p === '') return;
    const f = pathForms(p, opts);
    if (f.dotdot) add('a relative path with ..');
    for (const form of f.forms) {
      const w = write ? protectedWhy(form, home) : null;
      const r = read ? sensitiveWhy(form, home) : null;
      if (w) add(`it touches ${w}`);
      if (r) add(`it reads ${r}`);
    }
  };
  if (tool === 'Bash') {
    const cmd = v.command;
    if (typeof cmd !== 'string' || cmd.trim() === '') { add('no command to show'); return reasons; }
    if (SHELL_SYNTAX.test(cmd)) add('it uses shell syntax (only one plain command can be allowed here)');
    const words = cmd.trim().split(/[ \t]+/);
    if (!BASH_FIRST_WORDS.has(words[0])) add(`"${words[0].slice(0, 40)}" is not on the short list of commands`);
    if (words[0] === 'git' && !GIT_SUBCOMMANDS.has(words[1] ?? '')) add('only git status, diff, log, show and rev-parse');
    for (const w of words.slice(1)) {
      if (RISKY_OPTIONS.some(re => re.test(w))) add(`the option ${w.slice(0, 20)}`);
      if (/^~[^/]/.test(w)) add('another user\'s home');
      const value = w.startsWith('-') ? (w.includes('=') ? w.slice(w.indexOf('=') + 1) : '') : w;
      checkPath(value, { write: true, read: true });
    }
    return reasons;
  }
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    const p = v.file_path ?? v.notebook_path;
    if (typeof p !== 'string' || !(p.startsWith('/') || p.startsWith('~/'))) { add('no absolute path to show'); return reasons; }
    checkPath(p, { write: true, read: true });
    return reasons;
  }
  if (tool === 'Read') {
    if (typeof v.file_path !== 'string') { add('no path to show'); return reasons; }
    checkPath(v.file_path, { write: false, read: true });
    return reasons;
  }
  if (tool === 'Glob' || tool === 'Grep') {
    checkPath(v.path, { write: false, read: true });
    if (typeof v.pattern === 'string' && tool === 'Glob') checkPath(v.pattern, { write: false, read: true });
    if (typeof v.glob === 'string') checkPath(v.glob, { write: false, read: true });
    return reasons;
  }
  if (tool === 'WebFetch') {
    let u = null;
    try { u = new URL(String(v.url)); } catch { u = null; }
    if (!u || u.protocol !== 'https:' || u.username || u.password) add('only a plain https address');
    else {
      if (u.search !== '') add('the address has a query string');
      if (!WEBFETCH_HOSTS.has(u.hostname.toLowerCase())) add(`${u.hostname.slice(0, 60)} is not on the short list of sites`);
    }
    return reasons;
  }
  if (tool === 'WebSearch') return reasons;
  if (CHANNEL_TOOL.test(tool)) {
    for (const f of Array.isArray(v.files) ? v.files : []) checkPath(f, { write: false, read: true });
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

// The gate: mode (with the kill file), the classifier-block window, the flood rule,
// per-device limits and lockout, refusals with no device, and the allow-burst alert.
// `onEvent` hears { kind } for each thing worth an alert.
export function createApprovals({
  mode = 'off', killPath = null, patterns = [], home = homedir(), realpath = safeRealpath,
  now = () => Date.now(), onEvent = () => {}, exists = existsSync, isLead = () => true
} = {}) {
  const configured = APPROVAL_MODES.includes(mode) ? mode : 'off';
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
  const current = () => (killed() ? 'off' : configured);
  const device = id => {
    if (!perDevice.has(id)) perDevice.set(id, { taps: [], refusals: [], lockedUntil: 0 });
    return perDevice.get(id);
  };
  const recent = (list, ms, at) => list.filter(t => at - t < ms);

  // Why Allow is out now for this request: its own reasons plus the moment's.
  function reasonsNow(p, at = now()) {
    const out = [...(p.denyOnly ?? [])];
    if (at < blockUntil) out.push('auto mode blocked something in the last 15 minutes');
    if (at < floodUntil) out.push('too many requests at once');
    return out;
  }

  return {
    configured,
    mode: current,
    killed,
    // At open: the request's own reasons and why it is asking, if a block explains it.
    assess(p) {
      const at = now();
      const denyOnly = denyOnlyReasons(p, { home, realpath, patterns });
      const why = lastBlock && at - lastBlock.at <= WHY_WINDOW_MS && lastBlock.tool === p.tool
        ? `Auto mode refused this ${lastBlock.tool} call${lastBlock.why ? ` (${lastBlock.why})` : ''}, so Claude Code is asking you`
        : null;
      return { denyOnly, why };
    },
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
    status: (at = now()) => ({ mode: current(), denyOnlyUntil: Math.max(blockUntil, floodUntil) > at ? Math.max(blockUntil, floodUntil) : null }),
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
