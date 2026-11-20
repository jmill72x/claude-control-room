// Restart Jarvis from the page (board 98a30b15): when the card shows and what it says,
// what the button may do, the sheet's steps, and the line in the lead-down cards.
// src/lib/orbit/recover.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RECOVER_COMMAND, RECOVER_WHAT, RESULT_SHOW_MS, POLL_MS, OK_GRACE_MS, STOPPED_NOTE, LOOKS_UP_NOTE, leadDownAlert, verdictWords, buttonState, recoverCard, sheetPhase, sheetNotes,
  UNSEEN, RUN_NAMES_SHOWN, RUNS_CHANGED, runNames, runsWarning
} from '../src/lib/orbit/recover.js';
import { waitingCards } from '../src/lib/orbit/waiting.js';

const T0 = new Date(2026, 10, 20, 14, 30).getTime();
const MIN = 60e3;
const SERVICES = [{ key: 'session:Jarvis', kind: 'session', name: 'Jarvis', state: 'down' }, { key: 'launchd:Tunnel', kind: 'launchd', name: 'Tunnel', state: 'down' }];
const DOWN = { text: 'Jarvis is not running', kind: 'service', key: 'service:session:Jarvis', since: T0 - 6 * MIN };
const status = (over = {}) => ({ usable: true, on: true, passkey: true, pending: false, running: null, last: null, blocked: null, nextAt: null, command: RECOVER_COMMAND, ...over });
const run = (over = {}) => ({ id: 'aaaaaaaaaaaaaaaa', by: 'iPhone', startedAt: T0 - 2 * MIN, finishedAt: T0 - MIN, verdict: 'ok', line: 'OK: Jarvis is back in full (Discord and Jarvis OS chat).', exit: 0, ...over });

test('the line is the run sheet\'s, and a Needs you card for the lead says it on its own line', () => {
  assert.equal(RECOVER_COMMAND, 'cd ~/Projects && ~/Projects/.worktrees/jarvis-release/bin/jarvis-recover');
  assert.ok(RECOVER_WHAT.endsWith(`:\n${RECOVER_COMMAND}`));
  assert.match(RECOVER_WHAT, /Restart Jarvis at the top of the page \(Face ID\)/);
  assert.equal(RESULT_SHOW_MS, 30 * MIN);
  assert.equal(POLL_MS, 3000);
  assert.equal(OK_GRACE_MS, 5 * MIN);
});

test('the lead down: his session\'s alert or a "jarvis-down" local alert, never another service\'s', () => {
  const tunnel = { text: 'Tunnel is not running', kind: 'service', key: 'service:launchd:Tunnel' };
  const local = { text: 'Jarvis failed to start', kind: 'local', about: 'jarvis-down', key: 'local:jarvis-down:abc' };
  assert.equal(leadDownAlert([tunnel, DOWN], SERVICES, 'Jarvis'), DOWN);
  assert.equal(leadDownAlert([tunnel], SERVICES, 'Jarvis'), null);
  assert.equal(leadDownAlert([{ ...local, about: 'other' }], SERVICES, 'Jarvis'), null);
  assert.equal(leadDownAlert([local], SERVICES, 'Jarvis'), local);
  assert.equal(leadDownAlert(null, SERVICES, 'Jarvis'), null);
  // No health list: a session's key is enough (runbook.js's rule).
  assert.equal(leadDownAlert([DOWN], null, 'Jarvis'), DOWN);
});

test('verdict words: OK and OK, degraded are OK; NOT OK; anything else is no answer', () => {
  assert.deepEqual(verdictWords('ok'), { ok: true, label: 'OK' });
  assert.deepEqual(verdictWords('degraded'), { ok: true, label: 'OK' });
  assert.deepEqual(verdictWords('not-ok'), { ok: false, label: 'NOT OK' });
  assert.deepEqual(verdictWords('unknown'), { ok: false, label: 'No answer' });
  assert.deepEqual(verdictWords(undefined), { ok: false, label: 'No answer' });
});

test('the button: none before the read or on a refused one; none while off (with why); shown but not tappable while a run goes or a limit holds', () => {
  assert.deepEqual(buttonState(null), { show: false, can: false, why: null });
  assert.deepEqual(buttonState({ usable: false }), { show: false, can: false, why: null });
  assert.deepEqual(buttonState(status({ on: false, blocked: 'Restart Jarvis from the page is off (config recover.enabled)' })), { show: false, can: false, why: 'Restart Jarvis from the page is off (config recover.enabled)' });
  assert.equal(buttonState(status({ on: false })).why, 'Restarting Jarvis from this page is off.');
  assert.deepEqual(buttonState(status({ running: run({ finishedAt: null, verdict: 'running' }) })), { show: true, can: false, why: 'A restart is going now.' });
  assert.deepEqual(buttonState(status({ blocked: '3 restarts in the last hour already; paste the command in a terminal, or wait' })), { show: true, can: false, why: '3 restarts in the last hour already; paste the command in a terminal, or wait' });
  assert.deepEqual(buttonState(status()), { show: true, can: true, why: null });
  // With no passkey yet the button still shows: the sheet sets Face ID up.
  assert.deepEqual(buttonState(status({ passkey: false })), { show: true, can: true, why: null });
});

test('the card: nothing when all is well; the lead down; a run going; a fresh result for half an hour, until put away', () => {
  assert.equal(recoverCard({ down: null, status: status(), now: T0 }), null);
  assert.equal(recoverCard({ down: null, status: null, now: T0 }), null);
  const down = recoverCard({ down: DOWN, status: status(), now: T0 });
  assert.equal(down.phase, 'down');
  assert.equal(down.title, 'Jarvis is down');
  assert.match(down.text, /jarvis-recover/);
  // A device that can't restart still gets the card (the line to paste), from the alert alone.
  assert.equal(recoverCard({ down: DOWN, status: { usable: false }, now: T0 }).phase, 'down');
  const going = recoverCard({ down: DOWN, status: status({ running: run({ finishedAt: null, verdict: 'running', startedAt: T0 - 30e3 }) }), now: T0 });
  assert.equal(going.phase, 'running');
  assert.equal(going.title, 'Restarting Jarvis…');
  assert.match(going.text, /^Asked from iPhone at /);
  // A run going is shown even once the alert has cleared.
  assert.equal(recoverCard({ down: null, status: status({ running: run({ finishedAt: null, verdict: 'running' }) }), now: T0 }).phase, 'running');
  const ok = recoverCard({ down: null, status: status({ last: run() }), now: T0 });
  assert.deepEqual([ok.phase, ok.ok, ok.title, ok.line, ok.down, ok.runId], ['done', true, 'Jarvis restart: OK', 'OK: Jarvis is back in full (Discord and Jarvis OS chat).', false, 'aaaaaaaaaaaaaaaa']);
  assert.match(ok.text, /^Asked from iPhone at .+, ended .+\.$/);
  const bad = recoverCard({ down: DOWN, status: status({ last: run({ verdict: 'not-ok', line: 'NOT OK: the Claude login lapsed.' }) }), now: T0 });
  assert.deepEqual([bad.phase, bad.ok, bad.title, bad.down], ['done', false, 'Jarvis restart: NOT OK', true], 'still down after a NOT OK: the button stays');
  // Right after an OK the alert may still be on the strip: no second restart offered...
  assert.equal(recoverCard({ down: DOWN, status: status({ last: run({ verdict: 'degraded' }) }), now: T0 }).down, false);
  assert.equal(recoverCard({ down: DOWN, status: status({ last: run({ finishedAt: T0 - OK_GRACE_MS + 1 }) }), now: T0 }).down, false);
  // ...but down again past the grace, it is offered with the result still shown.
  assert.equal(recoverCard({ down: DOWN, status: status({ last: run({ finishedAt: T0 - OK_GRACE_MS }) }), now: T0 }).down, true);
  assert.equal(recoverCard({ down: null, status: status({ last: run({ finishedAt: T0 - OK_GRACE_MS }) }), now: T0 }).down, false);
  // Old, or put away: the card goes back to what is true now.
  assert.equal(recoverCard({ down: null, status: status({ last: run({ finishedAt: T0 - RESULT_SHOW_MS }) }), now: T0 }), null);
  assert.equal(recoverCard({ down: null, status: status({ last: run({ finishedAt: T0 - RESULT_SHOW_MS + 1 }) }), now: T0 }).phase, 'done');
  assert.equal(recoverCard({ down: null, status: status({ last: run() }), now: T0, dismissed: 'aaaaaaaaaaaaaaaa' }), null);
  assert.equal(recoverCard({ down: DOWN, status: status({ last: run() }), now: T0, dismissed: 'aaaaaaaaaaaaaaaa' }).phase, 'down');
  assert.equal(recoverCard({ down: null, status: status({ last: run({ line: '' }) }), now: T0 }).line, '(no line)');
  assert.equal(recoverCard({ down: null, status: status({ last: run({ finishedAt: null }) }), now: T0 }), null);
});

test('the sheet\'s steps: loading, Face ID up, the code, a run going, its own run\'s end, set-up, waiting for the code, unusable, confirm', () => {
  assert.equal(sheetPhase(null, null), 'loading');
  assert.equal(sheetPhase('working', status()), 'working');
  assert.equal(sheetPhase('code', status({ passkey: false })), 'code');
  assert.equal(sheetPhase(null, status({ running: run({ finishedAt: null, verdict: 'running' }) }), 'aaaaaaaaaaaaaaaa'), 'running');
  assert.equal(sheetPhase(null, status({ last: run() }), 'aaaaaaaaaaaaaaaa'), 'done');
  assert.equal(sheetPhase(null, status({ last: run() }), 'bbbbbbbbbbbbbbbb'), 'confirm', 'another run\'s end is not this sheet\'s');
  assert.equal(sheetPhase(null, status({ last: run() })), 'confirm');
  assert.equal(sheetPhase(null, { usable: false }), 'unusable');
  assert.equal(sheetPhase(null, status({ passkey: false })), 'setup');
  assert.equal(sheetPhase(null, status({ passkey: false, pending: true })), 'pending');
  assert.equal(sheetPhase(null, status()), 'confirm');
});

test('Needs you: the lead\'s down card says how to bring him back first, in its lines; another service\'s does not', () => {
  const cards = waitingCards({ items: [], today: '2026-11-20', roster: { agents: [], tagOwners: {} }, toPushEnv: undefined, alerts: [DOWN, { text: 'Tunnel is not running', kind: 'service', key: 'service:launchd:Tunnel', since: T0 - 6 * MIN }], now: T0 });
  const all = Object.values(cards).flat().filter(c => c && typeof c === 'object' && 'what' in c);
  const lead = all.find(c => c.key === 'alert:service:session:Jarvis');
  const tunnel = all.find(c => c.key === 'alert:service:launchd:Tunnel');
  assert.ok(lead && tunnel, JSON.stringify(Object.keys(cards)));
  assert.ok(lead.what.startsWith(`${RECOVER_WHAT}\n\n`));
  assert.equal(lead.preLine, true);
  assert.ok(!tunnel.what.includes('jarvis-recover'));
  assert.equal(tunnel.preLine, undefined);
});

test('Q1: the sheet says when Jarvis looks up or was stopped on purpose; nothing when he is down, unknown, or the status says nothing', () => {
  assert.equal(LOOKS_UP_NOTE, 'Jarvis looks up; this ends his current turn.');
  assert.equal(STOPPED_NOTE, 'Jarvis was stopped on purpose; this restart clears that.');
  assert.deepEqual(sheetNotes(status({ jarvis: { health: 'up', stopped: false } })), [LOOKS_UP_NOTE]);
  assert.deepEqual(sheetNotes(status({ jarvis: { health: 'down', stopped: true } })), [STOPPED_NOTE]);
  assert.deepEqual(sheetNotes(status({ jarvis: { health: 'up', stopped: true } })), [STOPPED_NOTE, LOOKS_UP_NOTE]);
  assert.deepEqual(sheetNotes(status({ jarvis: { health: 'down', stopped: false } })), []);
  assert.deepEqual(sheetNotes(status({ jarvis: { health: 'unknown', stopped: false } })), []);
  assert.deepEqual(sheetNotes(status({ jarvis: { health: 'up', stopped: 'yes' } })), [LOOKS_UP_NOTE], 'only true is the flag');
  assert.deepEqual(sheetNotes(status()), [], 'an older server says nothing of him');
  assert.deepEqual(sheetNotes({ usable: false, jarvis: { health: 'up', stopped: true } }), []);
  assert.deepEqual(sheetNotes(null), []);
});

test('Q1: the sheet shows its notes in the confirm step, before Face ID', () => {
  const jsx = readFileSync(fileURLToPath(new URL('../src/orbit/Recover.jsx', import.meta.url)), 'utf8');
  const confirm = jsx.slice(jsx.indexOf("{(phase === 'confirm' || phase === 'working') && ("), jsx.indexOf("{phase === 'setup' && <p"));
  assert.match(confirm, /sheetNotes\(status\)\.map\(note => <p key=\{note\} className="o-recover-note" role="status">\{note\}<\/p>\)/);
});

test('the page holds the line in one place: recover.js, and no other source file', () => {
  const src = fileURLToPath(new URL('../src', import.meta.url));
  const holders = [];
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(js|jsx|css|html)$/.test(name) && readFileSync(path, 'utf8').includes('bin/jarvis-recover')) holders.push(path.slice(src.length + 1));
    }
  };
  walk(src);
  assert.deepEqual(holders, [join('lib', 'orbit', 'recover.js')]);
});

// ---- agent runs a restart would stop (board d8f27c49) ----

const A = 'a1a1a1a1a1a1a1a1', B = 'b2b2b2b2b2b2b2b2';
const agents = (runs, known = true) => ({ agents: { known, runs } });

test('runs warning: none when the server says no run is going; the runs by name, and Restarting stops them, when some are', () => {
  assert.equal(runsWarning(status(agents([])), T0), null);
  assert.deepEqual(runsWarning(status(agents([{ id: A, name: 'Vision', last: T0 - 10e3 }, { id: B, name: 'Ultron', last: T0 }])), T0), {
    text: '2 agent runs are going (Vision, Ultron). Restarting stops them.', ids: [A, B], count: 2, known: true
  });
  assert.equal(runsWarning(status(agents([{ id: A, name: 'Pepper', last: T0 }])), T0).text, '1 agent run is going (Pepper). Restarting stops it.');
  // Not usable, or before the read: nothing (the sheet shows no confirm then).
  assert.equal(runsWarning({ usable: false, agents: { known: true, runs: [{ id: A, name: 'Vision' }] } }, T0), null);
  assert.equal(runsWarning(null, T0), null);
  // A row with no id is not a run the server can be told about.
  assert.equal(runsWarning(status(agents([{ name: 'Vision' }, null])), T0), null);
});

test('runs warning: not seen says so and sends UNSEEN with the ids; an older server\'s status (no agents) warns as not seen', () => {
  assert.deepEqual(runsWarning(status(agents([], false)), T0), { text: 'The Control Room can\'t see whether agent runs are going. Restarting stops any that are.', ids: [UNSEEN], count: 0, known: false });
  assert.deepEqual(runsWarning(status(agents([{ id: A, name: 'Vision', last: T0 }], false)), T0), {
    text: '1 agent run was going at the last check (Vision), and the Control Room can\'t see the runs now. Restarting stops any still going.', ids: [A, UNSEEN], count: 1, known: false
  });
  assert.equal(runsWarning(status(), T0).ids[0], UNSEEN);
  assert.equal(UNSEEN, 'unseen');
});

test('run names: a quiet run is marked as the live pane marks it; a long list is cut', () => {
  assert.equal(runNames([{ name: 'Vision', last: T0 - 6 * MIN }, { name: 'Ultron', last: T0 - 119e3 }, { name: ' ', last: null }], T0), 'Vision (quiet 6 min), Ultron, subagent');
  const many = Array.from({ length: RUN_NAMES_SHOWN + 2 }, (_, i) => ({ name: `A${i}` }));
  assert.equal(runNames(many, T0), 'A0, A1, A2, A3, A4, A5 and 2 more');
  assert.equal(RUN_NAMES_SHOWN, 6);
});

test('the sheet: the warning first in the confirm step, Cancel the default (filled, focused), Restart anyway sends the ids; a 409 shows the server\'s runs', () => {
  const jsx = readFileSync(fileURLToPath(new URL('../src/orbit/Recover.jsx', import.meta.url)), 'utf8');
  const confirm = jsx.slice(jsx.indexOf("{(phase === 'confirm' || phase === 'working') && ("), jsx.indexOf("{phase === 'setup' && <p"));
  assert.ok(confirm.indexOf('{warn && <p className="o-recover-runs" role="alert">{warn.text}</p>}') > -1);
  assert.ok(confirm.indexOf('o-recover-runs') < confirm.indexOf('o-stop-detail'), 'the warning comes before the rest');
  assert.match(jsx, /const warn = phase === 'confirm' \|\| phase === 'working' \? runsWarning\(status\) : null;/);
  assert.match(jsx, /await restartJarvis\(warn\?\.ids \?\? \[\]\)/);
  assert.match(jsx, /className=\{warn \? 'o-stop-anyway' : 'o-stop-go'\} onClick=\{go\} disabled=\{busy \|\| checking \|\| !btn\.can\}>\{busy \? 'Waiting for Face ID…' : checking \? 'Checking…' : warn \? 'Restart anyway' : 'Restart with Face ID'\}/);
  assert.match(jsx, /className=\{warn \? 'o-stop-cancel o-stop-cancel-main' : 'o-stop-cancel'\} onClick=\{onClose\} disabled=\{busy\} autoFocus=\{Boolean\(warn\)\}/);
  assert.match(jsx, /if \(err\?\.status === 409 && err\.body\?\.agents\) \{\s*ctx\.setStatus\(s => \(\{ \.\.\.s, agents: err\.body\.agents \}\)\);\s*setError\(RUNS_CHANGED\);/);
  // Opening the sheet reads the status afresh, and the restart waits for it.
  assert.match(jsx, /open: \(\) => \{ setOpen\(true\); setChecking\(true\); read\(\)\.finally\(\(\) => setChecking\(false\)\); \}/);
  assert.match(RUNS_CHANGED, /changed since this opened/);
  const api = readFileSync(fileURLToPath(new URL('../src/orbit/recoverApi.js', import.meta.url)), 'utf8');
  assert.match(api, /post\('\/api\/recover\/challenge', \{ stopRuns \}\)/);
  assert.match(api, /post\('\/api\/recover', \{ \.\.\.assertion\(cred\), stopRuns \}\)/);
});
