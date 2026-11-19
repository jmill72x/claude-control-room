// The mod's alert lines (mod/hooks/model.js alertLabel, used by summaryText and by
// view.js's pane): a local script's alert (server/lib/local-alerts.mjs) says
// "(local script)" (Ultron's L2, 2026-11-19). The mod's own tests run only inside
// Claude Code's mod harness; model.js and view.js import nothing else, so they run here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertLabel, summaryText } from '../../mod/hooks/model.js';
import { paneTree } from '../../mod/hooks/view.js';

const LOCAL = { text: 'Jarvis failed to start', kind: 'local', key: 'local:jarvis-down:0123456789ab', about: 'jarvis-down' };
const LIMIT = { text: 'Weekly at 90%', kind: 'limit', key: 'limit:Weekly' };

test('alertLabel: a local alert says it came from a local script; any other alert keeps its words', () => {
  assert.equal(alertLabel(LOCAL), 'Jarvis failed to start (local script)');
  assert.equal(alertLabel(LIMIT), 'Weekly at 90%');
  assert.equal(alertLabel({ kind: 'local' }), '');
  assert.equal(alertLabel(null), '');
});

test('the /control-room summary labels a local alert', () => {
  const text = summaryText({ payload: { alerts: [LOCAL, LIMIT] }, todos: [], now: Date.now(), url: 'u' });
  assert.ok(text.includes('- **Jarvis failed to start (local script)**'), text.slice(0, 200));
  assert.ok(text.includes('- **Weekly at 90%**'));
  assert.ok(text.includes('**2 alerts**'));
});

test('the pane labels a local alert', () => {
  // Element constructors that keep their props, so the tree can be searched.
  const make = type => props => ({ type, props });
  const el = { Box: make('Box'), Text: make('Text'), Button: make('Button') };
  const st = { tab: 'usage', payload: { alerts: [LOCAL, LIMIT] }, fetchedAt: Date.now(), payloadError: null, todos: [] };
  const act = new Proxy({}, { get: () => () => {} });
  let tree;
  try {
    tree = paneTree(el, st, act, { now: Date.now(), columns: 80, url: 'u', surface: 'terminal' });
  } catch (err) {
    assert.fail(`the pane did not build: ${err?.message}`);
  }
  const texts = [];
  const walk = node => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Text') for (const c of node.props?.children ?? []) if (typeof c === 'string') texts.push(c);
    walk(node.props?.children);
  };
  walk(tree);
  assert.ok(texts.includes('▲ Jarvis failed to start (local script)'), texts.filter(t => t.startsWith('▲')).join(' | '));
  assert.ok(texts.includes('▲ Weekly at 90%'));
});
