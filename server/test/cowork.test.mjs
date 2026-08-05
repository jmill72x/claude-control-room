import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCoworkSession } from '../lib/cowork.mjs';

const RAW = {
  sessionId: 'local_9e7b3f21',
  cliSessionId: 'f6144e8c',
  cwd: '/Users/example/Library/Application Support/Claude/local-agent-mode-sessions/x/y/local_9e7b3f21/outputs',
  userSelectedFolders: ['/Users/example/CoworkSpace'],
  createdAt: 1785012248192,
  lastActivityAt: 1785012751392,
  model: 'claude-opus-5',
  isArchived: false,
  title: 'Cowork setup'
};

test('reads the fields the dashboard needs', () => {
  const s = parseCoworkSession(RAW);
  assert.equal(s.title, 'Cowork setup');
  assert.equal(s.model, 'claude-opus-5');
  assert.equal(s.lastActivityAt, 1785012751392);
  assert.equal(s.archived, false);
});

test('prefers the user-selected folder over the internal outputs path', () => {
  assert.equal(parseCoworkSession(RAW).folder, '/Users/example/CoworkSpace');
});

test('falls back to cwd when no folder was selected', () => {
  const s = parseCoworkSession({ ...RAW, userSelectedFolders: [] });
  assert.ok(s.folder.includes('outputs'));
});

test('an untitled session yields null rather than a placeholder', () => {
  assert.equal(parseCoworkSession({ ...RAW, title: undefined }).title, null);
});
