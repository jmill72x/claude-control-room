// Dark mode on the Overview and the Board (board e0ad4cfe): orbit.css's switch, read
// from the stylesheet itself. The paper tokens inside .o-main and .o-recover point at
// the chat's dark tokens; every rule there with a colour written out has a dark
// counterpart or a stated reason not to; the words clear WCAG AA (4.5:1) on their
// backgrounds in both themes; the heat map's shades run the right way round in each;
// and the marks drawn in a colour from the code carry both colours.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { duoStyle, agentColors, ACCENT_COLORS } from '../src/lib/orbit/page.js';
import { SHADES, SHADES_NIGHT, shadeColors, eventColors } from '../src/lib/orbit/overview.js';
import { todayView } from '../src/lib/orbit/agents.js';

const CSS = readFileSync(new URL('../src/orbit/orbit.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// ---- a small reader for this stylesheet: rules outside and inside the dark query ----

function blocks(css) {
  // Splits into top-level pieces: { at, sel, body } where at is the @-rule's prelude.
  const out = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const prelude = css.slice(i, open).trim();
    let depth = 1, j = open + 1;
    while (depth > 0 && j < css.length) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
    out.push({ prelude, body: css.slice(open + 1, j - 1), at: open });
    i = j;
  }
  return out;
}
const decls = body => Object.fromEntries(body.split(';').map(d => d.trim()).filter(Boolean).map(d => {
  const k = d.indexOf(':');
  return [d.slice(0, k).trim(), d.slice(k + 1).trim()];
}));
const sels = prelude => prelude.split(',').map(s => s.trim().replace(/\s+/g, ' '));

const TOP = [], DARK = [];
for (const b of blocks(CSS)) {
  if (b.prelude.startsWith('@media')) {
    const into = /prefers-color-scheme:\s*dark/.test(b.prelude) ? DARK : null;
    if (into) for (const r of blocks(b.body)) into.push({ sels: sels(r.prelude), decls: decls(r.body) });
  } else if (!b.prelude.startsWith('@')) {
    TOP.push({ sels: sels(b.prelude), decls: decls(b.body), at: b.at });
  }
}
// The last value a selector gets for a property, in source order.
function value(rules, sel, prop) {
  let v;
  for (const r of rules) if (r.sels.includes(sel) && prop in r.decls) v = r.decls[prop];
  return v;
}
function tokensOf(rules, sel) {
  const out = {};
  for (const r of rules) if (r.sels.includes(sel)) for (const [k, v] of Object.entries(r.decls)) if (k.startsWith('--')) out[k] = v;
  return out;
}

const LIGHT = tokensOf(TOP, ':root');
const DARK_ENV = { ...LIGHT, ...tokensOf(DARK, ':root'), ...tokensOf(DARK, '.o-main') };
const resolve = (v, env, depth = 0) => {
  assert.ok(depth < 12, `a var() loop in ${v}`);
  const out = v.replace(/var\((--[a-z0-9-]+)(?:,\s*([^()]*))?\)/gi, (_, name, fb) => {
    if (env[name] !== undefined) return env[name];
    assert.ok(fb !== undefined, `${name} has no value`);
    return fb;
  });
  return out.includes('var(') ? resolve(out, env, depth + 1) : out;
};

// ---- WCAG contrast, with translucent layers over an opaque one ----

function rgba(c) {
  c = c.trim();
  if (c.startsWith('#')) {
    let h = c.slice(1);
    if (h.length === 3) h = [...h].map(x => x + x).join('');
    return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)).concat(h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1);
  }
  const m = /^rgba?\(([^)]*)\)$/.exec(c);
  assert.ok(m, `not a colour: ${c}`);
  const p = m[1].split(',').map(Number);
  return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
}
const over = (fg, bg) => [0, 1, 2].map(i => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1);
const lum = c => {
  const ch = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
};
// ratio(text, innermost background, ..., an opaque one last)
function ratio(fg, ...bgs) {
  let bg = rgba(bgs[bgs.length - 1]);
  assert.equal(bg[3], 1, `the last background must be opaque: ${bgs[bgs.length - 1]}`);
  for (const b of bgs.slice(0, -1).reverse()) bg = over(rgba(b), bg);
  const f = over(rgba(fg), bg);
  const [a, b] = [lum(f), lum(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

test('the contrast reader agrees with known pairs', () => {
  assert.ok(Math.abs(ratio('#FFFFFF', '#000000') - 21) < 1e-9);
  assert.ok(Math.abs(ratio('#777777', '#FFFFFF') - 4.48) < 0.01);
  assert.ok(Math.abs(ratio('rgba(0, 0, 0, 0.5)', '#FFFFFF') - ratio('rgb(127.5, 127.5, 127.5)', '#FFFFFF')) < 1e-9, 'half black over white is mid grey');
  assert.ok(Math.abs(ratio('#FFFFFF', 'rgba(0, 0, 0, 0.5)', '#FFFFFF') - ratio('#FFFFFF', 'rgb(127.5, 127.5, 127.5)')) < 1e-9, 'layers compose');
});

// ---- the switch ----

const PAPER_TOKENS = ['--card', '--lane', '--rule', '--rule-strong', '--ink', '--heading', '--sub', '--chip-soft', '--accent', '--accent-deep', '--accent-ink', '--accent-soft'];

test("dark mode points the paper surfaces' tokens at the chat's dark ones", () => {
  const main = tokensOf(DARK, '.o-main');
  const recover = tokensOf(DARK, '.o-recover');
  for (const t of PAPER_TOKENS) {
    assert.ok(main[t], `${t} has a dark value in .o-main`);
    assert.equal(recover[t], main[t], `${t} is the same in .o-recover`);
  }
  // Reused, not invented: the text and surface tokens are the chat's own.
  for (const t of ['--card', '--lane', '--rule', '--rule-strong', '--ink', '--heading', '--sub', '--chip-soft', '--accent', '--accent-ink']) {
    assert.match(main[t], /^var\(--c-[a-z-]+\)$/, `${t} reuses a chat token`);
  }
  // The chat's dark tokens are on :root (and still on .o-chat, whose light ones they replace).
  const root = DARK.find(r => r.sels.includes(':root'));
  assert.ok(root && root.sels.includes('.o-chat'), "the chat's dark tokens sit on :root and .o-chat");
  for (const t of ['--c-bg', '--c-card', '--c-theirs', '--c-ink', '--c-heading', '--c-sub', '--c-rule', '--c-mine', '--c-mine-ink', '--c-ok', '--c-bad']) assert.ok(root.decls[t], t);
  // Words with no colour of their own take the dark ink, not the body's light one.
  assert.equal(value(DARK, '.o-main', 'color'), 'var(--ink)');
  assert.equal(value(DARK, '.o-main', 'color-scheme'), 'dark', 'native controls (the date picker, scroll bars) go dark too');
  assert.equal(value(DARK, 'body', 'background'), 'var(--c-bg)');
  // Light mode is untouched: no paper token is redefined outside the dark query.
  for (const t of PAPER_TOKENS) assert.equal(tokensOf(TOP, '.o-main')[t], undefined, `${t} outside the query`);
  // The two-colour marks: light takes --o-day, dark --o-night.
  assert.equal(tokensOf(TOP, '.o-duo')['--o-tone'], 'var(--o-day)');
  assert.equal(tokensOf(DARK, '.o-duo')['--o-tone'], 'var(--o-night)');
});

test('resolving the dark tokens reaches colours, with no var() loop', () => {
  for (const t of PAPER_TOKENS) assert.doesNotThrow(() => rgba(resolve(DARK_ENV[t], DARK_ENV)), t);
  for (const t of PAPER_TOKENS) assert.doesNotThrow(() => rgba(resolve(LIGHT[t], LIGHT)), t);
});

// Rules on the paper surfaces with a colour written out, and why each is right in dark
// mode as it stands. Every other one must have its own dark rule.
const SAME_IN_BOTH = {
  // On a navy panel (Usage, the work map) or the navy header, which keep their colours.
  '.o-fold-night': 'navy panel', '.o-chip-night': 'navy panel', '.o-ring-track': 'navy panel', '.o-bar .o-bar-stub': 'navy panel',
  '.o-shares': 'navy panel', '.o-share-bar': 'navy panel', '.o-map-orbit': 'navy panel', '.o-map-line': 'navy panel',
  '.o-map-line-on': 'navy panel', '.o-map-node .o-avatar': 'navy panel', '.o-map-lead .o-avatar': 'navy panel',
  // White on its own green circle: a decorative icon, 5.4:1 in both themes.
  '.o-wtile-push': 'its own fill',
  // On the red alert strip, which keeps its red in both themes (the same pieces in a
  // card are .o-ack-form-card's, in tokens).
  '.o-alerts .o-runbook-btn': 'red strip', '.o-ack-save': 'red strip', '.o-ack-btn': 'red strip', '.o-ack-form': 'red strip',
  '.o-ack-choice input': 'red strip',
  // The Now chip, in the navy header.
  '.o-now-chip': 'navy header', '.o-now-chip.o-tone-bad': 'navy header',
  // Never applied: .o-wtile and .o-wcard, later in the file, set the same properties
  // (a light-mode slip from 11-10, on the board as a follow-up). Dark mode draws
  // these as light mode does.
  '.o-wtile-alerts': 'overridden', '.o-wcard-alert': 'overridden'
};

test('every written-out colour on the paper surfaces has a dark rule or a reason', () => {
  const from = CSS.indexOf('.o-wtile-alerts');
  const to = CSS.indexOf('.o-duo {');
  assert.ok(from > 0 && to > from);
  const navyBand = new Set(['.o-health-runbook', '.o-runbook-night']); // the health details, in the header
  const missing = [];
  let seen = 0;
  for (const r of TOP) {
    if (r.at < from || r.at > to) continue;
    for (const [prop, v] of Object.entries(r.decls)) {
      if (!/#[0-9a-f]{3,8}\b|rgba?\(/i.test(v)) continue;
      if (!/color|background|border|shadow|stroke|fill|^--/.test(prop)) continue;
      seen++;
      for (const sel of r.sels) {
        if (SAME_IN_BOTH[sel] || navyBand.has(sel)) continue;
        const dark = DARK.some(d => d.sels.includes(sel) && (prop in d.decls || (prop.startsWith('border') && Object.keys(d.decls).some(k => k.startsWith('border'))) || (prop === 'color' && 'color' in d.decls)));
        if (!dark) missing.push(`${sel} { ${prop}: ${v} }`);
      }
    }
  }
  assert.ok(seen > 20, `the scan found the rules (${seen})`);
  assert.deepEqual(missing, []);
});

// ---- contrast in both themes ----

// Each theme's surfaces: a panel (card), a tile or lane (lane), and the paper inside a
// panel (a waiting card, the empty note, a done item) or the page itself.
const THEMES = {
  light: { env: LIGHT, rules: TOP, page: 'var(--paper)' },
  dark: { env: DARK_ENV, rules: [...TOP, ...DARK], page: value(DARK, '.o-wempty', 'background') }
};
const col = (theme, v) => resolve(v, THEMES[theme].env);
// A rule's value for this theme (the dark rules come after, so they win in dark).
const ruleVal = (theme, sel, prop) => value(THEMES[theme].rules, sel, prop);
const cardTokens = (theme, sel) => ({ ...tokensOf(TOP, '.o-wcard'), ...tokensOf(TOP, sel), ...(theme === 'dark' ? { ...tokensOf(DARK, '.o-wcard'), ...tokensOf(DARK, sel) } : {}) });

for (const theme of ['light', 'dark']) {
  test(`${theme}: the words clear AA (4.5:1) on every paper surface`, () => {
    const t = THEMES[theme];
    const c = v => col(theme, v);
    const page = c(t.page);
    const card = c('var(--card)'), lane = c('var(--lane)');
    const fails = [];
    const check = (what, fg, ...bgs) => { const r = ratio(fg, ...bgs); if (r < 4.5) fails.push(`${what}: ${r.toFixed(2)}`); return r; };
    for (const ink of ['--ink', '--heading', '--sub']) {
      check(`${ink} on a panel`, c(`var(${ink})`), card);
      check(`${ink} on a tile or lane`, c(`var(${ink})`), lane);
      check(`${ink} on paper`, c(`var(${ink})`), page);
    }
    // Red words: a failed routine, a due date, the error line, a P1 chip, a quiet run.
    check('accent on a panel', c('var(--accent)'), card);
    check('accent-deep on a panel', c('var(--accent-deep)'), card);
    check('accent-ink on accent-soft in a panel', c('var(--accent-ink)'), c('var(--accent-soft)'), card);
    check('accent-ink on accent-soft on the page (Restart Jarvis)', c('var(--accent-ink)'), c('var(--accent-soft)'), page);
    check('heading on accent-soft on the page', c('var(--heading)'), c('var(--accent-soft)'), page);
    check('sub on accent-soft on the page', c('var(--sub)'), c('var(--accent-soft)'), page);
    check('heading on chip-soft (P2)', c('var(--heading)'), c('var(--chip-soft)'), card);
    check('sub on chip-soft (Restart Jarvis running)', c('var(--sub)'), c('var(--chip-soft)'), page);
    // Greens: a routine that ran, a loop that held, the push chip, Restart Jarvis done.
    check('a routine that ran', c(ruleVal(theme, '.o-routine.o-tone-ok .o-routine-mark', 'color')), card);
    check('a loop chip', c(ruleVal(theme, '.o-loop-chip.o-tone-ok', 'color')), card);
    const push = cardTokens(theme, '.o-wcard-push');
    check('the push chip', c(push['--w-chip-fg']), c(push['--w-chip-bg']), c(push['--w-bg']));
    const ok = c(ruleVal(theme, '.o-recover-ok', 'background'));
    check('heading on Restart Jarvis done', c('var(--heading)'), ok, page);
    check('sub on Restart Jarvis done', c('var(--sub)'), ok, page);
    // Fills with words on them.
    for (const sel of [".o-atab[aria-selected='true']", '.o-chip-on', '.o-btn-solid']) {
      check(sel, c(ruleVal(theme, sel, 'color')), c(ruleVal(theme, sel, 'background')));
    }
    for (const sel of ['.o-btn-accent', '.o-pri-P0', '.o-due-overdue']) {
      check(sel, c(ruleVal(theme, sel, 'color')), c(ruleVal(theme, sel, 'background')));
    }
    check('.o-pri-P1', c('var(--accent-ink)'), c('var(--accent-soft)'), card);
    check('.o-pri-P3', c('var(--sub)'), lane);
    // A hot waiting card (today, tomorrow, overdue): its words and its chip.
    const hot = cardTokens(theme, '.o-wcard-hot');
    check('hot card title', c(hot['--w-ink']), c(hot['--w-bg']));
    check('hot card sub', c(hot['--w-sub']), c(hot['--w-bg']));
    check('hot card chip', c(hot['--w-chip-fg']), c(hot['--w-chip-bg']));
    const soon = cardTokens(theme, '.o-wcard-soon');
    check('soon card title', c(soon['--w-ink']), c(soon['--w-bg']));
    check('soon card chip', c(soon['--w-chip-fg']), c(soon['--w-chip-bg']), c(soon['--w-bg']));
    const plain = cardTokens(theme, '.o-wcard');
    check('a waiting card title', c(plain['--w-ink']), c(plain['--w-bg']));
    check('a waiting card sub', c(plain['--w-sub']), c(plain['--w-bg']));
    check('a waiting card chip', c(plain['--w-chip-fg']), c(plain['--w-chip-bg']), c(plain['--w-bg']));
    // A field: what is typed. A done item on the board.
    check('a field', c('var(--heading)'), c(ruleVal(theme, '.o-input', 'background')));
    check('a done item', c(ruleVal(theme, '.o-card-done .o-card-title', 'color')), c(ruleVal(theme, '.o-card-done', 'background')));
    // A fill that marks a state (the picked tab, a filter that's on, a hot card) shows
    // against what it sits on: navy on a dark page would not (about 1.1:1). The chat's
    // blue is about 2.5 to 3:1 there, as on the Feed's filters, and the words change too.
    const shows = (what, fill, surface) => { const r = ratio(fill, surface); if (r < 2.4) fails.push(`${what} fill: ${r.toFixed(2)}`); };
    shows("the picked Agents tab", c(ruleVal(theme, ".o-atab[aria-selected='true']", 'background')), lane);
    shows('a filter that is on', c(ruleVal(theme, '.o-chip-on', 'background')), page);
    shows('a hot card', c(hot['--w-bg']), card);
    assert.deepEqual(fails, []);
  });
}

// ---- the Chat: Jeff's own bubbles (board 15156e62) ----

// The chat's tokens in each theme: light ones on .o-chat, dark ones on ':root, .o-chat'.
const CHAT = {
  light: { env: { ...LIGHT, ...tokensOf(TOP, '.o-chat') }, rules: TOP },
  dark: { env: { ...LIGHT, ...tokensOf(TOP, '.o-chat'), ...tokensOf(DARK, '.o-chat') }, rules: [...TOP, ...DARK] }
};

for (const theme of ['light', 'dark']) {
  test(`${theme}: the time line and file size on Jeff's bubbles clear AA and stay secondary`, () => {
    const { env, rules } = CHAT[theme];
    const c = v => resolve(v, env);
    const bubble = c(value(rules, '.o-chat-mine .o-chat-bubble', 'background'));
    const ink = c(value(rules, '.o-chat-mine .o-chat-bubble', 'color'));
    // The time line (and edited, via, a late note) and a file's size both take --c-mine-sub.
    assert.equal(value(rules, '.o-chat-mine .o-chat-meta', 'color'), 'var(--c-mine-sub)');
    assert.equal(value(rules, '.o-chat-mine .o-chat-pdf-size', 'color'), 'var(--c-mine-sub)');
    const sub = c('var(--c-mine-sub)');
    const fails = [];
    const check = (what, fg, ...bgs) => { const r = ratio(fg, ...bgs); if (r < 4.5) fails.push(`${what}: ${r.toFixed(2)}`); return r; };
    const subR = check('the time line on the bubble', sub, bubble);
    const inkR = check('the message on the bubble', ink, bubble);
    // A file chip sits on its own inset in the bubble: its name (the bubble's ink) and size.
    const chip = c(value(rules, '.o-chat-mine .o-chat-pdf', 'background'));
    check("a file's name on its chip", ink, chip, bubble);
    check("a file's size on its chip", sub, chip, bubble);
    // The chip still shows against the bubble, about as much as the light one does.
    assert.ok(ratio(chip, bubble) >= 1.2, `the chip shows: ${ratio(chip, bubble).toFixed(2)}`);
    // Secondary: clearly dimmer than the message text it sits under.
    assert.ok(inkR / subR >= 1.2, `the time line reads as secondary: ${inkR.toFixed(2)} vs ${subR.toFixed(2)}`);
    assert.deepEqual(fails, []);
  });
}

// ---- the charts ----

test("the heat map's shades: darker is busier in light, lighter in dark, each a visible step", () => {
  assert.equal(SHADES.length, SHADES_NIGHT.length);
  const L = SHADES.map(s => lum(rgba(s)));
  const D = SHADES_NIGHT.map(s => lum(rgba(s)));
  for (let i = 1; i < L.length; i++) {
    assert.ok(L[i] < L[i - 1], `light level ${i} is darker than ${i - 1}`);
    assert.ok(D[i] > D[i - 1], `dark level ${i} is lighter than ${i - 1}`);
  }
  // The inset the map sits on (Usage's fold: the panel colour).
  const insetLight = resolve('var(--card)', LIGHT), insetDark = resolve('var(--card)', DARK_ENV);
  assert.ok(ratio(SHADES_NIGHT[0], insetDark) >= 1.1, 'an empty hour still shows in dark');
  assert.ok(ratio(SHADES[0], insetLight) >= 1.1, 'an empty hour still shows in light');
  assert.ok(ratio(SHADES_NIGHT[4], insetDark) >= 3, 'the busiest hour stands out (3:1, a graphic) in dark');
  assert.ok(ratio(SHADES[4], insetLight) >= 3, 'the busiest hour stands out in light');
  assert.deepEqual(shadeColors(2), { day: SHADES[2], night: SHADES_NIGHT[2] });
});

test("Next 24 hours and Today's lanes carry both colours: the paper palette and the night one", () => {
  assert.deepEqual(duoStyle({ day: '#111111', night: '#EEEEEE' }), { '--o-day': '#111111', '--o-night': '#EEEEEE' });
  assert.deepEqual(eventColors('reset', null), ACCENT_COLORS);
  assert.deepEqual(eventColors('you', { index: 2 }), ACCENT_COLORS, 'your own ask is the accent, whoever owns it');
  assert.deepEqual(eventColors('routine', { index: 2 }), agentColors(2));
  assert.deepEqual(eventColors('routine', { index: -1 }), agentColors(-1), "an owner the roster doesn't know is grey");
  assert.deepEqual(eventColors('routine', null), agentColors(-1));
  const card = resolve('var(--card)', DARK_ENV);
  // Every night colour reads on the dark panel (3:1, a graphic), as the day ones do on paper.
  for (let i = 0; i < 8; i++) {
    assert.ok(ratio(agentColors(i).night, card) >= 3, `agent ${i} at night`);
    assert.ok(ratio(agentColors(i).day, resolve('var(--card)', LIGHT)) >= 3, `agent ${i} by day`);
  }
  assert.ok(ratio(ACCENT_COLORS.night, card) >= 3 && ratio(agentColors(-1).night, card) >= 3);

  const at = h => new Date(2026, 9, 21, h).getTime();
  const roster = { agents: [{ key: 'atlas', name: 'Atlas' }, { key: 'forge', name: 'Forge' }], tagOwners: {} };
  const work = {
    lead: 'atlas',
    agents: { atlas: { tokens7d: 1, lastActivity: at(14) }, forge: { tokens7d: 1, lastActivity: at(14) } },
    runs: [{ agent: 'forge', helper: false, direct: false, task: 't', tokens: 10, start: at(9), last: at(9) + 60e3 }]
  };
  const crons = [{ label: 'com.example.digest', name: 'digest', dueAt: [], nextRunAt: null }];
  const view = todayView({ work, roster, crons, jobs: {}, now: at(15) });
  const forge = view.lanes.find(l => l.name === 'Forge');
  assert.deepEqual(forge.colors, agentColors(1));
  assert.deepEqual(view.lanes.find(l => l.scheduled).colors, agentColors(-1));
});

test('the paper-side pieces that draw a colour from the code use both colours', () => {
  const read = f => readFileSync(new URL(`../src/orbit/${f}`, import.meta.url), 'utf8');
  // Written-out colours left in these files, each on a navy panel or its own fill.
  const allowed = {
    'Overview.jsx': ['#FF8A5B'], // Burn's icon, on the navy panel
    'Agents.jsx': ['#FF7A45', '#3FCB82'], // the work map's request and result, on navy
    'Waiting.jsx': [], 'Routines.jsx': [], 'Loops.jsx': [], 'HeadsUp.jsx': [], 'Live.jsx': []
  };
  for (const [file, ok] of Object.entries(allowed)) {
    const found = [...new Set(read(file).match(/#[0-9A-Fa-f]{6}\b/g) ?? [])];
    assert.deepEqual(found.filter(h => !ok.includes(h)), [], `${file}: a colour with no dark value`);
  }
  assert.match(read('Overview.jsx'), /duoStyle\(shadeColors\(c\.level\)\)/, 'heat cells');
  assert.match(read('Overview.jsx'), /duoStyle\(colorsOf\(e\)\)/, 'event dots');
  assert.match(read('Agents.jsx'), /duoStyle\(l\.colors\)/, "Today's marks");
});
