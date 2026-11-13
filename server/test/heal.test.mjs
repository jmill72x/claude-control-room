// Self-healing loops, the pure parts (lib/heal.mjs), and the pieces of loop 1 that live
// beside them: job-status's stale-log-only verdict (lib/health.mjs), the alert's hold
// (lib/alerts.mjs) and the notifier's (collectors/notifier.mjs). Every label, name and
// figure here is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TIERS, VERB_FLOORS, floorOf, CATALOG, loadCatalog, toolsFor, readHealConfig, parseRunInterval, judgeReadings,
  keptLines, capStop, weeklyCounts, distinctHeals, buildLoopsView, LEDGER_KEEP_MS, LEDGER_MAX, PER_TARGET_DAY, PER_DAY, COMEBACK_MS,
  SETTLE_MAX_MS, WHY_WORDS
} from '../lib/heal.mjs';
import { parseJobStatus, overlayCrons, buildJobs, readHealthConfig, staleLogOnly, QUIET_REASON } from '../lib/health.mjs';
import { buildAlerts } from '../lib/alerts.mjs';
import { runNotifier, heldAlerts } from '../collectors/notifier.mjs';

const MIN = 60e3, H = 3600e3, DAY = 24 * H;
const NOW = new Date(2026, 10, 12, 9, 0).getTime();

// ---- the floor check ----

test('every verb has a floor, and every floor is a tier below T3', () => {
  for (const [verb, floor] of Object.entries(VERB_FLOORS)) {
    assert.ok(['T0', 'T1', 'T2'].includes(floor), verb);
  }
  assert.equal(VERB_FLOORS['launchctl:print'], 'T0');
  assert.equal(VERB_FLOORS['alert:mark-quiet'], 'T1');
  for (const v of ['launchctl:kickstart', 'launchctl:load', 'launchctl:unload', 'launchctl:bootstrap', 'launchctl:bootout', 'deploy:web-build', 'git:push', 'fs:delete', 'alert:ack']) {
    assert.equal(VERB_FLOORS[v], 'T2', v);
  }
  assert.deepEqual(TIERS, ['T0', 'T1', 'T2', 'T3']);
});

test("a verb list's floor is its highest verb's, and an unknown verb has none", () => {
  assert.equal(floorOf(['launchctl:print']), 'T0');
  assert.equal(floorOf(['launchctl:print', 'alert:mark-quiet']), 'T1');
  assert.equal(floorOf(['alert:mark-quiet', 'launchctl:print']), 'T1');
  assert.equal(floorOf(['launchctl:print', 'launchctl:kickstart', 'alert:mark-quiet']), 'T2');
  assert.equal(floorOf(['launchctl:print', 'launchctl:rm-everything']), null);
  assert.equal(floorOf(['constructor']), null, 'an inherited name is no verb');
});

const entry = (extra = {}) => ({ id: 'try-it', class: 'stale-log', tier: 'T1', targetKind: 'job', verbs: ['launchctl:print'], settleMs: 60e3, ...extra });

test('the shipped catalog loads, with mark-quiet at T1 and its floor worked out', () => {
  const c = loadCatalog(CATALOG);
  assert.deepEqual([...c.keys()], ['mark-quiet']);
  const q = c.get('mark-quiet');
  assert.equal(q.tier, 'T1');
  assert.equal(q.floor, 'T1');
  assert.equal(q.settleMs, SETTLE_MAX_MS);
  assert.ok(Object.isFrozen(q) && Object.isFrozen(q.verbs));
});

test('the loader refuses a T0 entry that declares launchctl:kickstart, and any tier below its floor', () => {
  assert.throws(() => loadCatalog([entry({ tier: 'T0', verbs: ['launchctl:print', 'launchctl:kickstart'] })]), /tier T0 is below its verbs' floor of T2/);
  assert.throws(() => loadCatalog([entry({ tier: 'T1', verbs: ['launchctl:kickstart'] })]), /tier T1 is below its verbs' floor of T2/);
  assert.throws(() => loadCatalog([entry({ tier: 'T0', verbs: ['alert:mark-quiet'] })]), /tier T0 is below its verbs' floor of T1/);
  // At or above the floor is fine: a heal may sit higher than it must.
  assert.equal(loadCatalog([entry({ tier: 'T2', verbs: ['launchctl:kickstart'] })]).get('try-it').tier, 'T2');
  assert.equal(loadCatalog([entry({ tier: 'T2', verbs: ['launchctl:print'] })]).get('try-it').floor, 'T0');
  // One bad entry refuses the whole catalog.
  assert.throws(() => loadCatalog([...CATALOG, entry({ tier: 'T0', verbs: ['launchctl:kickstart'] })]), /below its verbs' floor/);
});

test('the loader refuses unknown verbs, no verbs, repeats, T3, bad tiers, kinds and settle times', () => {
  assert.throws(() => loadCatalog([entry({ verbs: ['launchctl:print', 'launchctl:frobnicate'] })]), /verb the floor table doesn't know/);
  assert.throws(() => loadCatalog([entry({ verbs: [] })]), /declares no verbs/);
  assert.throws(() => loadCatalog([entry({ verbs: 'launchctl:print' })]), /declares no verbs/);
  assert.throws(() => loadCatalog([entry({ verbs: ['launchctl:print', 'launchctl:print'] })]), /listed twice/);
  assert.throws(() => loadCatalog([entry({ tier: 'T3' })]), /T3 entry never acts/);
  assert.throws(() => loadCatalog([entry({ tier: 'T9' })]), /tier must be one of/);
  assert.throws(() => loadCatalog([entry({ targetKind: 'host' })]), /unknown target kind/);
  assert.throws(() => loadCatalog([entry({ settleMs: SETTLE_MAX_MS + 1 })]), /settle time/);
  assert.throws(() => loadCatalog([entry({ settleMs: 0 })]), /settle time/);
  assert.throws(() => loadCatalog([entry(), entry()]), /listed twice/);
  assert.throws(() => loadCatalog([entry({ id: 'Bad Id' })]), /no usable id/);
  assert.throws(() => loadCatalog([entry({ class: '' })]), /no usable class/);
  assert.throws(() => loadCatalog('mark-quiet'), /not a list/);
  assert.throws(() => loadCatalog([null]), /not an object/);
});

test('an action gets the tools for its declared verbs and no others', () => {
  const all = { 'launchctl:print': () => 'p', 'launchctl:kickstart': () => 'k', 'alert:mark-quiet': () => 'q' };
  const t = toolsFor(loadCatalog(CATALOG).get('mark-quiet'), all);
  assert.deepEqual(Object.keys(t).sort(), ['alert:mark-quiet', 'launchctl:print']);
  assert.equal(t['launchctl:kickstart'], undefined);
  assert.ok(Object.isFrozen(t));
  assert.throws(() => toolsFor(loadCatalog(CATALOG).get('mark-quiet'), { 'launchctl:print': () => 'p' }), /no tool for its verb alert:mark-quiet/);
  assert.throws(() => toolsFor(loadCatalog(CATALOG).get('mark-quiet'), Object.create({ 'launchctl:print': () => 1, 'alert:mark-quiet': () => 1 })), /no tool/);
});

// ---- config ----

test('no heal block is off with no targets and no problems', () => {
  const s = readHealConfig({});
  assert.equal(s.enabled, false);
  assert.equal(s.targets.size, 0);
  assert.deepEqual(s.problems, []);
});

test('a heal block: enabled only when exactly true, targets by label, actions from the catalog', () => {
  const s = readHealConfig({ heal: { enabled: true, targets: { 'nas-mount': { label: 'com.example.nas-mount', actions: ['mark-quiet'] } }, off: [] } });
  assert.deepEqual(s.problems, []);
  assert.equal(s.enabled, true);
  const t = s.targets.get('com.example.nas-mount');
  assert.equal(t.id, 'nas-mount');
  assert.ok(t.actions.has('mark-quiet'));
  assert.equal(readHealConfig({ heal: { enabled: 'yes' } }).enabled, false);
  assert.deepEqual(readHealConfig({ heal: { enabled: 'yes' } }).problems, ['heal.enabled must be true or false']);
  assert.equal(readHealConfig({ heal: { enabled: 1 } }).enabled, false);
});

test('bad targets are left out and said, and inherited names never count', () => {
  const s = readHealConfig({
    heal: {
      enabled: true,
      targets: {
        good: { label: 'com.example.good', actions: ['mark-quiet'] },
        'Bad Id': { label: 'com.example.x', actions: ['mark-quiet'] },
        nolabel: { actions: ['mark-quiet'] },
        spaced: { label: 'com.example.a b', actions: ['mark-quiet'] },
        twice: { label: 'com.example.good', actions: ['mark-quiet'] },
        noactions: { label: 'com.example.y' },
        strange: { label: 'com.example.z', actions: ['rerun-job', 'constructor', 'mark-quiet'] }
      },
      off: ['nothing-like-it']
    }
  });
  assert.deepEqual([...s.targets.keys()], ['com.example.good', 'com.example.z']);
  assert.deepEqual([...s.targets.get('com.example.z').actions], ['mark-quiet']);
  assert.equal(s.problems.length, 8);
  assert.equal(s.off.size, 0);
  assert.equal(readHealConfig({ heal: { targets: Object.create({ inherited: { label: 'com.example.i', actions: ['mark-quiet'] } }) } }).targets.size, 0);
  assert.deepEqual(readHealConfig({ heal: [] }).problems, ['heal is not an object']);
  assert.deepEqual(readHealConfig({ heal: { targets: [] } }).problems, ['heal.targets is not an object']);
  assert.deepEqual([...readHealConfig({ heal: { off: ['mark-quiet'] } }).off], ['mark-quiet']);
});

// ---- the readings ----

test("launchd's run interval is read from the top level only, within bounds", () => {
  assert.equal(parseRunInterval('\tstate = not running\n\truns = 147\n\tlast exit code = 0\n\trun interval = 180 seconds\n'), 180);
  assert.equal(parseRunInterval('\t\trun interval = 180 seconds\n'), null, 'a nested line is not the job\'s');
  assert.equal(parseRunInterval('\trun interval = 5 seconds\n'), null);
  assert.equal(parseRunInterval('\trun interval = 10 seconds\n'), 10);
  assert.equal(parseRunInterval(`\trun interval = ${32 * 24 * 3600} seconds\n`), null);
  assert.equal(parseRunInterval('\tstate = running\n'), null);
  assert.equal(parseRunInterval(null), null);
});

test('two readings prove a clean run only when the counter rose and both exits were 0', () => {
  assert.equal(judgeReadings({ runs: 147, lastExit: 0 }, { runs: 148, lastExit: 0 }), 'clean');
  assert.equal(judgeReadings({ runs: 147, lastExit: 0 }, { runs: 160, lastExit: 0 }), 'clean');
  assert.equal(judgeReadings({ runs: 147, lastExit: 0 }, { runs: 147, lastExit: 0 }), 'flat');
  assert.equal(judgeReadings({ runs: 147, lastExit: 0 }, { runs: 3, lastExit: 0 }), 'reset');
  // A crash loop raises the counter too: the exit decides.
  assert.equal(judgeReadings({ runs: 147, lastExit: 0 }, { runs: 152, lastExit: 1 }), 'exit');
  assert.equal(judgeReadings({ runs: 147, lastExit: 78 }, { runs: 152, lastExit: 0 }), 'exit');
  // A signal leaves no exit code, which isn't 0 either.
  assert.equal(judgeReadings({ runs: 147, lastExit: 0 }, { runs: 152, lastExit: null }), 'exit');
  assert.equal(judgeReadings({ runs: 147, lastExit: 0 }, null), 'unreadable');
  assert.equal(judgeReadings(null, { runs: 1, lastExit: 0 }), 'unreadable');
  assert.equal(judgeReadings({ runs: null, lastExit: 0 }, { runs: 1, lastExit: 0 }), 'unreadable');
});

// ---- the ledger's lines and the rate limits ----

const line = (extra = {}) => ({ at: NOW - H, class: 'stale-log', action: 'mark-quiet', tier: 'T1', target: 'nas-mount', since: NOW - 10 * H, detectedAt: NOW - H - 5 * MIN, outcome: 'healed', why: 'clean', runs: [1, 2], ...extra });

test('the ledger keeps well-formed lines of the last 30 days, oldest first, at most LEDGER_MAX', () => {
  const kept = keptLines([line({ at: NOW - 2 * H }), line({ at: NOW - LEDGER_KEEP_MS - 1 }), line({ at: NOW - LEDGER_KEEP_MS }), { at: NOW, outcome: 'healed' }, line({ outcome: 'exploded' }), line({ tier: 'T7' }), null, line({ at: NOW - 3 * H })], NOW);
  assert.deepEqual(kept.map(l => l.at), [NOW - LEDGER_KEEP_MS, NOW - 3 * H, NOW - 2 * H]);
  assert.deepEqual(keptLines({ not: 'a list' }, NOW), []);
  const many = Array.from({ length: LEDGER_MAX + 5 }, (_, i) => line({ at: NOW - i * MIN }));
  const k = keptLines(many, NOW);
  assert.equal(k.length, LEDGER_MAX);
  assert.equal(k[k.length - 1].at, NOW, 'the newest are kept');
});

test('rate limits: 3 heals of one target a day, 20 in all, and no second heal within an hour', () => {
  assert.equal(capStop([], 'nas-mount', NOW), null);
  const three = [1, 2, 3].map(i => line({ at: NOW - i * 2 * H, since: NOW - (10 + i) * H }));
  assert.equal(capStop(three, 'nas-mount', NOW), 'cap-target');
  assert.equal(capStop(three.slice(0, PER_TARGET_DAY - 1), 'nas-mount', NOW), null);
  assert.equal(capStop(three, 'other', NOW), null, 'the cap is per target');
  // Lines older than a day don't count; escalations never do.
  assert.equal(capStop(three.map(l => ({ ...l, at: l.at - DAY })), 'nas-mount', NOW), null);
  assert.equal(capStop(three.map(l => ({ ...l, outcome: 'escalated' })), 'nas-mount', NOW), null);
  const day = Array.from({ length: PER_DAY }, (_, i) => line({ target: `t${i % 7}`, since: NOW - 10 * H - i * H, at: NOW - 2 * H - i * MIN }));
  assert.equal(capStop(day, 'fresh', NOW), 'cap-day');
  assert.equal(capStop(day.slice(1), 'fresh', NOW), null);
  // A heal of this target within the hour, by the ledger or by a loop that just ended.
  assert.equal(capStop([line({ at: NOW - COMEBACK_MS + 1 })], 'nas-mount', NOW), 'came-back');
  assert.equal(capStop([line({ at: NOW - COMEBACK_MS })], 'nas-mount', NOW), null);
  assert.equal(capStop([], 'nas-mount', NOW, NOW - COMEBACK_MS + 1), 'came-back');
  assert.equal(capStop([], 'nas-mount', NOW, NOW - COMEBACK_MS), null);
  // The same instance checked again (after the kill switch, or a restart) is no comeback.
  assert.equal(capStop([line({ at: NOW - 10 * MIN, since: NOW - 10 * H })], 'nas-mount', NOW, null, NOW - 10 * H + 30e3), null);
  assert.equal(capStop([line({ at: NOW - 10 * MIN, since: NOW - 10 * H })], 'nas-mount', NOW, null, NOW - 9 * H), 'came-back');
});

test('the same instance healed again (after a restart) is one heal for the caps and the counts', () => {
  const same = [1, 2, 3, 4].map(i => line({ at: NOW - i * 2 * H, since: NOW - 10 * H + i * 30e3 }));
  assert.equal(distinctHeals(same).length, 1);
  assert.equal(distinctHeals(same)[0].at, NOW - 2 * H, 'the first line of the instance, in the order given');
  assert.equal(capStop(same.sort((a, b) => a.at - b.at), 'nas-mount', NOW, null, NOW - 10 * H), null);
  assert.deepEqual(weeklyCounts(same, NOW)[0].counts, [0, 0, 0, 1]);
  // Other targets and other instances still count apart.
  assert.equal(distinctHeals([...same, line({ target: 'b' }), line({ since: NOW - 2 * H })]).length, 3);
  assert.equal(distinctHeals([line({ outcome: 'escalated' })]).length, 0);
});

test('weekly counts: healed loops per class, oldest week first, the last week ending now', () => {
  const lines = [line({ at: NOW - H, since: NOW - 2 * H }), line({ at: NOW - 8 * DAY, since: NOW - 9 * DAY }), line({ at: NOW - 8 * DAY, since: NOW - 10 * DAY, outcome: 'escalated' }), line({ at: NOW - 27 * DAY, since: NOW - 28 * DAY }), line({ at: NOW - 29 * DAY, since: NOW - 30 * DAY })];
  assert.deepEqual(weeklyCounts(lines, NOW), [{ class: 'stale-log', label: 'stale log', counts: [1, 0, 1, 1] }]);
  assert.deepEqual(weeklyCounts([], NOW), []);
});

test('the view names targets from config, words every outcome, and carries no label', () => {
  const settings = readHealConfig({ heal: { enabled: true, targets: { 'nas-mount': { label: 'com.example.nas-mount', actions: ['mark-quiet'] } } } });
  const v = buildLoopsView({
    status: 'on', settings, jobNames: { 'com.example.nas-mount': { name: 'NAS mount' } }, now: NOW,
    open: [{ target: 'nas-mount', class: 'stale-log', action: 'mark-quiet', tier: 'T1', step: 'diagnosing', detectedAt: NOW - MIN, nextCheckAt: NOW + 3 * MIN, holdUntil: NOW + 9 * MIN }],
    quiet: [{ target: 'gone-now', since: NOW - 10 * H, checkedAt: NOW - MIN, tier: 'T1' }],
    held: [{ target: 'nas-mount', why: 'x' }],
    lines: [line({ at: NOW - 8 * DAY }), line({ at: NOW - 2 * H, outcome: 'escalated', why: 'flat' }), line({ at: NOW - H, why: 'not-a-why' })]
  });
  assert.equal(v.open[0].name, 'NAS mount');
  assert.equal(v.quiet[0].name, 'gone-now', 'a target no longer in config goes by its id');
  assert.deepEqual(v.recent.map(r => [r.words, r.why]), [['quiet, ran clean', null], ['left as it was', WHY_WORDS.flat]]);
  assert.ok(!JSON.stringify(v).includes('com.example'), 'no label reaches the page');
  assert.ok(!JSON.stringify(v).includes('runs'), 'no reading reaches the page');
});

// ---- job-status's stale-log-only verdict (lib/health.mjs) ----

const job = (label, extra = {}) => ({
  label, state: 'not running', last_exit: 0, log_path: `/private/logs/${label}.log`, log_age_hours: 10.3,
  max_age_hours: 0.15, ok: false, reason: 'log last written 10.3 h ago, more than the 0.15 h expected', ...extra
});
const report = jobs => JSON.stringify({ generated_at: new Date(NOW).toISOString(), jobs });
const parsed = e => parseJobStatus(report([e])).jobs[0];

test("stale-log-only: the log's age is the whole reason, the last exit is 0 and the job is loaded", () => {
  assert.equal(staleLogOnly(parsed(job('com.example.a'))), true);
  assert.equal(staleLogOnly(parsed(job('com.example.a', { log_age_hours: 300, max_age_hours: 192, reason: 'log last written 300.0 h ago, more than the 192 h expected' }))), true);
  assert.equal(staleLogOnly(parsed(job('com.example.a', { last_exit: 1, reason: 'last exit code 1; log last written 10.3 h ago, more than the 0.15 h expected' }))), false);
  assert.equal(staleLogOnly(parsed(job('com.example.a', { last_exit: 1 }))), false, 'exit 1 even if the reason were only the age');
  assert.equal(staleLogOnly(parsed(job('com.example.a', { last_exit: null }))), false, 'never exited is no proof');
  assert.equal(staleLogOnly(parsed(job('com.example.a', { state: 'not loaded' }))), false);
  assert.equal(staleLogOnly(parsed(job('com.example.a', { state: null }))), false);
  assert.equal(staleLogOnly(parsed(job('com.example.a', { reason: 'log last written 10.3 h ago, more than the 0.15 h expected; launchctl print gave no state' }))), false);
  assert.equal(staleLogOnly(parsed(job('com.example.a', { reason: 'could not read its plist (x); log last written 10.3 h ago, more than the 0.15 h expected' }))), false);
  assert.equal(staleLogOnly(parsed(job('com.example.a', { ok: true, reason: null }))), false);
  assert.equal(staleLogOnly(parsed(job('com.example.a', { ok: true }))), false, 'an OK verdict is never stale-log-only, whatever its reason says');
  assert.equal(staleLogOnly(parsed(job('com.example.a', { log_age_hours: 0.1 }))), false, 'not actually older than allowed');
  assert.equal(staleLogOnly(parsed(job('com.example.a', { max_age_hours: null }))), false);
});

const cron = (label, extra = {}) => ({ name: label.split('.').pop(), label, schedule: 'Every 3 minutes', nextRunAt: null, dueAt: [], ok: true, state: 'ok', last: 'OK', ...extra });

test('the crons overlay flags a stale-log-only failure for the heal runner, and nothing else', () => {
  const answer = { ...parseJobStatus(report([
    job('com.example.a'),
    job('com.example.b', { last_exit: 2, reason: 'last exit code 2; log last written 10.3 h ago, more than the 0.15 h expected' }),
    job('com.example.c', { ok: true, reason: null, log_age_hours: 0.01 })
  ])), receivedAt: NOW };
  const out = overlayCrons([cron('com.example.a'), cron('com.example.b'), cron('com.example.c')], answer, NOW);
  const by = Object.fromEntries(out.map(c => [c.label, c]));
  assert.equal(by['com.example.a'].staleLog, true);
  assert.equal(by['com.example.a'].state, 'failed');
  assert.equal(by['com.example.b'].staleLog, undefined);
  assert.equal(by['com.example.c'].staleLog, undefined);
});

test("the Jobs list reads a quiet job as quiet, only for the runner's instance and only when stale-log-only", () => {
  const settings = readHealthConfig({ health: { jobStatus: '/opt/example/job-status', services: [] } });
  const answer = { ...parseJobStatus(report([job('com.example.a'), job('com.example.b', { last_exit: 1, reason: 'last exit code 1' })])), receivedAt: NOW };
  const asked = [];
  const quietOf = (label, since) => { asked.push([label, since]); return { at: NOW }; };
  const jobs = buildJobs({ settings, answer, quietOf });
  const by = Object.fromEntries(jobs.list.map(j => [j.name, j]));
  assert.deepEqual(by.a, { name: 'a', schedule: null, state: 'quiet', reason: QUIET_REASON });
  assert.equal(by.b.state, 'failed', 'a job that failed for its exit is never quiet');
  assert.deepEqual(asked, [['com.example.a', Math.round(NOW - 10.3 * H)]], 'asked by label and instance, for the stale one only');
  assert.equal(buildJobs({ settings, answer }).list.find(j => j.name === 'a').state, 'failed', 'no runner, no quiet');
  assert.equal(buildJobs({ settings, answer, quietOf: () => null }).list.find(j => j.name === 'a').state, 'failed');
});

// ---- the hold: alerts and the notifier ----

test("a launchd cron's holdUntil rides on its alert; an ingested one's never does", () => {
  const snap = {
    crons: { status: 'ok', data: [{ name: 'a', label: 'com.example.a', ok: false, state: 'failed', last: 'Overdue', lastRunAt: NOW - H, holdUntil: NOW + 5 * MIN }, { name: 'b', label: 'com.example.b', ok: false, last: 'Failed' }] },
    ingestCrons: { status: 'ok', data: [{ name: 'c', label: 'c', ok: false, holdUntil: NOW + 5 * MIN }] }
  };
  const alerts = buildAlerts(snap, {}, NOW);
  const by = Object.fromEntries(alerts.map(a => [a.key, a]));
  assert.equal(by['cron:launchd:com.example.a'].holdUntil, NOW + 5 * MIN);
  assert.equal('holdUntil' in by['cron:launchd:com.example.b'], false);
  assert.equal('holdUntil' in by['cron:ingest:c'], false);
});

test('held alerts: hold still ahead, and never one already pushed', () => {
  const alerts = [{ key: 'a', holdUntil: NOW + 1 }, { key: 'b', holdUntil: NOW }, { key: 'c' }, { key: 'd', holdUntil: NOW + 1 }];
  assert.deepEqual([...heldAlerts(alerts, { d: NOW - H }, NOW)], ['a']);
  assert.deepEqual([...heldAlerts(alerts, Object.create({ a: 1 }), NOW)], ['a', 'd'], 'an inherited key is not a sent one');
});

const harness = (initial = {}) => {
  const store = { ...initial };
  const sent = [];
  const evented = [];
  return {
    store, sent, evented,
    readSent: async () => store,
    writeSent: async next => { for (const k of Object.keys(store)) delete store[k]; Object.assign(store, next); },
    send: async msg => { sent.push(msg); return { sent: true }; },
    events: async alerts => { evented.push(alerts.map(a => a.key)); return { made: alerts.length }; }
  };
};
const heldSnap = (holdUntil, extra = {}) => ({
  crons: { status: 'ok', data: [{ name: 'nas-mount', label: 'com.example.nas-mount', ok: false, state: 'failed', last: 'Overdue · log 10 h old', lastRunAt: NOW - 10 * H, ...(holdUntil ? { holdUntil } : {}), ...extra }] },
  ingestCrons: { status: 'ok', data: [] }
});

test('the notifier holds the push and the event of an alert a loop is checking, then lets it go', async () => {
  const h = harness();
  const first = await runNotifier({ snapshot: heldSnap(NOW + 5 * MIN), config: {}, now: NOW, ...h });
  assert.equal(first.sent, 0);
  assert.equal(first.held, 1);
  assert.deepEqual(h.evented, [[]], 'no event either');
  assert.deepEqual(h.store, {}, 'nothing recorded as sent');
  // The hold has passed (the loop escalated or ran out of settle time): it goes as always.
  const later = await runNotifier({ snapshot: heldSnap(NOW + 5 * MIN), config: {}, now: NOW + 5 * MIN, ...h });
  assert.equal(later.sent, 1);
  assert.equal(later.held, undefined);
  assert.deepEqual(h.evented[1], ['cron:launchd:com.example.nas-mount']);
});

test('a hold never re-pushes or forgets a key already pushed (a restart re-detects the loop)', async () => {
  const h = harness({ 'cron:launchd:com.example.nas-mount': NOW - H });
  const out = await runNotifier({ snapshot: heldSnap(NOW + 5 * MIN), config: {}, now: NOW, ...h });
  assert.equal(out.sent, 0);
  assert.equal(out.held, undefined, 'not held: Jeff already has it');
  assert.ok(Object.hasOwn(h.store, 'cron:launchd:com.example.nas-mount'), 'still remembered as sent');
  assert.deepEqual(h.evented, [['cron:launchd:com.example.nas-mount']], 'the event hook keeps seeing it, so it does not fire again');
});

test('an alert that went quiet is no alert at all: no push, no event', async () => {
  const h = harness();
  const quiet = { crons: { status: 'ok', data: [{ name: 'nas-mount', label: 'com.example.nas-mount', ok: true, state: 'quiet', last: 'Quiet · ran clean', lastRunAt: NOW - 10 * H }] }, ingestCrons: { status: 'ok', data: [] } };
  const out = await runNotifier({ snapshot: quiet, config: {}, now: NOW, ...h });
  assert.deepEqual([out.alerts, out.sent], [0, 0]);
  assert.deepEqual(h.evented, [[]]);
});
