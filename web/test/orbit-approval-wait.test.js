// Approval cards on the home screen (board e7427be1): Needs you names the card, its tool
// and the subagent that asked, and the Agents card's Now tab says the lead waits on one
// instead of "No agents running."; sw.js gives a reminder the approval's tag and lets it
// sound when it takes an older one's place. Every name and time is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { approvalTitle, waitCard } from '../src/lib/orbit/waiting.js';
import { approvalNote } from '../src/lib/orbit/live.js';

const NOW = new Date(2026, 10, 26, 15, 0).getTime();
const MIN = 60e3;
const wait = (extra = {}) => ({ who: 'Inventlead', kind: 'permission', since: NOW - 42 * MIN, key: 'needs-you:aaaaaaaaaaaa', tool: 'Bash', run: null, ...extra });

test('the card\'s title: whose, its tool and session; a word that is not plain is left out', () => {
  assert.equal(approvalTitle(wait()), 'Inventlead is waiting on an approval card (Bash)');
  assert.equal(approvalTitle(wait({ run: 'Inventrun', tool: 'Edit' })), 'Inventrun is waiting on an approval card (Edit, in Inventlead\'s session)');
  assert.equal(approvalTitle(wait({ tool: null })), 'Inventlead is waiting on an approval card');
  assert.equal(approvalTitle(wait({ who: null, tool: '<img src=x>', run: 'a\nb' })), 'A session is waiting on an approval card');
  assert.equal(approvalTitle(wait({ tool: 'an MCP tool' })), 'Inventlead is waiting on an approval card (an MCP tool)');
});

test('Needs you: a permission wait is the named card with where to answer; an idle wait keeps its old words', () => {
  const c = waitCard(wait(), NOW);
  assert.equal(c.title, 'Inventlead is waiting on an approval card (Bash)');
  assert.equal(c.what, 'Answer it on the Chat tab while its card is open, else in Discord or Inventlead\'s terminal. Waiting 42 min ago.');
  assert.equal(c.chip, 'Waiting');
  assert.equal(waitCard(wait({ kind: 'idle' }), NOW).title, 'Inventlead is waiting on an idle prompt');
});

test('the Now tab: with no run live, the oldest card and how long it has waited; none, and the old line stands', () => {
  assert.equal(approvalNote([wait({ since: NOW - 5 * MIN }), wait({ since: NOW - 91 * MIN, run: 'Inventrun' })], NOW),
    'No agent is working: Inventrun is waiting on an approval card (Bash, in Inventlead\'s session), for 1 h 31 min. 1 more card waits too. Needs you has it.');
  assert.equal(approvalNote([wait()], NOW), 'No agent is working: Inventlead is waiting on an approval card (Bash), for 42 min. Needs you has it.');
  assert.equal(approvalNote([wait({ kind: 'idle' })], NOW), null);
  assert.equal(approvalNote([wait({ since: 'soon' })], NOW), null);
  assert.equal(approvalNote(null, NOW), null);
});

test('sw.js: a reminder shares the approval\'s tag, and either sounds when it replaces one; a chat push does not renotify', async () => {
  const shown = [];
  const listeners = {};
  const self = {
    location: { origin: 'https://mini.example.ts.net' },
    addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); },
    skipWaiting: () => {},
    registration: { showNotification: async (title, opts) => { shown.push({ title, ...opts }); } },
    navigator: { setAppBadge: async () => {} },
    clients: { claim: async () => {}, matchAll: async () => [], openWindow: async () => {} }
  };
  vm.runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), { self, URL, Promise, String, Number, JSON });
  const push = async notification => { const waited = []; for (const fn of listeners.push) fn({ data: { json: () => ({ web_push: 8030, notification }) }, waitUntil: p => waited.push(p) }); await Promise.all(waited); };
  await push({ title: 'Jarvis', body: 'Inventlead has waited 10 min on an approval card. Answer it in Jarvis OS chat, Discord or the terminal.' });
  await push({ title: 'Jarvis', body: 'Jarvis needs an approval' });
  await push({ title: 'Jarvis', body: 'New message' });
  await push({ title: 'Local alert: x', body: 'Inventlead has waited 10 min on an approval card.' });
  assert.deepEqual(shown.map(n => [n.tag, n.renotify]), [['jos-approval', true], ['jos-approval', true], ['jos-chat', undefined], ['jos-local', undefined]]);
});
