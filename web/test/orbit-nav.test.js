// Swiping between the tabs (src/lib/orbit/nav.js) and the sticky tab bar's
// "stuck" test: which gesture moves to which tab, and what a swipe must leave
// alone (the screen edges, fields, dialogs, anything that scrolls sideways).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TAB_ORDER, swipeTab, blocksSwipe, navStuck, EDGE_PX, MIN_DX } from '../src/lib/orbit/nav.js';

const W = 820; // an iPad's width in portrait
const g = (over = {}) => ({ tab: 'board', startX: 400, dx: -120, dy: 10, ms: 250, width: W, ...over });

test('the tabs go Overview, Board, Chat, Feed', () => {
  assert.deepEqual(TAB_ORDER, ['overview', 'board', 'chat', 'feed']);
});

test('a swipe to the left goes to the next tab, to the right the one before', () => {
  assert.equal(swipeTab(g()), 'chat');
  assert.equal(swipeTab(g({ dx: 120 })), 'overview');
  assert.equal(swipeTab(g({ tab: 'overview' })), 'board');
  assert.equal(swipeTab(g({ tab: 'chat', dx: 120 })), 'board');
  assert.equal(swipeTab(g({ tab: 'chat' })), 'feed');
  assert.equal(swipeTab(g({ tab: 'feed', dx: 120 })), 'chat');
});

test('no tab past either end', () => {
  assert.equal(swipeTab(g({ tab: 'feed' })), null);
  assert.equal(swipeTab(g({ tab: 'overview', dx: 120 })), null);
  assert.equal(swipeTab(g({ tab: 'nope' })), null);
});

test('the same gesture works at phone, iPad and desktop widths', () => {
  for (const width of [390, 820, 1024, 1366]) assert.equal(swipeTab(g({ width, startX: width / 2 })), 'chat', `width ${width}`);
});

test('too short, too slow or too vertical is not a swipe', () => {
  assert.equal(swipeTab(g({ dx: -(MIN_DX - 1) })), null);
  assert.equal(swipeTab(g({ dx: -MIN_DX })), 'chat');
  assert.equal(swipeTab(g({ ms: 900 })), null);
  assert.equal(swipeTab(g({ dx: -120, dy: 70 })), null, 'mostly a scroll');
  assert.equal(swipeTab(g({ dx: -120, dy: -70 })), null);
  assert.equal(swipeTab(g({ dx: -120, dy: 55 })), 'chat');
});

test('a swipe from the screen\'s edge is left to the system (iOS back/forward)', () => {
  assert.equal(swipeTab(g({ startX: EDGE_PX - 1 })), null);
  assert.equal(swipeTab(g({ startX: W - EDGE_PX + 1 })), null);
  assert.equal(swipeTab(g({ startX: EDGE_PX + 1 })), 'chat');
});

// A stand-in for DOM elements and getComputedStyle.
const el = (over = {}) => ({ tagName: 'DIV', parentElement: null, isContentEditable: false, scrollWidth: 100, clientWidth: 100, getAttribute: () => null, ...over });
const styleOf = map => node => ({ overflowX: map.get(node) ?? 'visible' });

test('a touch inside something that scrolls sideways is not a swipe', () => {
  const lanes = el({ scrollWidth: 1400, clientWidth: 820 });
  const card = el({ parentElement: el({ parentElement: lanes }) });
  assert.equal(blocksSwipe(card, styleOf(new Map([[lanes, 'auto']]))), true);
  assert.equal(blocksSwipe(card, styleOf(new Map([[lanes, 'scroll']]))), true);
  assert.equal(blocksSwipe(card, styleOf(new Map([[lanes, 'hidden']]))), false, 'clipped, not scrollable');
  const fits = el({ scrollWidth: 820, clientWidth: 820 });
  assert.equal(blocksSwipe(el({ parentElement: fits }), styleOf(new Map([[fits, 'auto']]))), false, 'overflow: auto that fits does not scroll');
});

test('fields, editable text, dialogs and opted-out areas are left alone', () => {
  const none = styleOf(new Map());
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) assert.equal(blocksSwipe(el({ tagName }), none), true, tagName);
  assert.equal(blocksSwipe(el({ isContentEditable: true }), none), true);
  const attr = (name, value) => el({ getAttribute: n => (n === name ? value : null) });
  assert.equal(blocksSwipe(el({ parentElement: attr('role', 'dialog') }), none), true);
  assert.equal(blocksSwipe(el({ parentElement: attr('aria-modal', 'true') }), none), true);
  assert.equal(blocksSwipe(el({ parentElement: attr('data-noswipe', '') }), none), true);
  assert.equal(blocksSwipe(el({ parentElement: el() }), none), false, 'plain content swipes');
  assert.equal(blocksSwipe(null, none), false);
});

test('the tab bar is stuck once its slot has scrolled above the top', () => {
  assert.equal(navStuck({ isIntersecting: false, top: -60 }), true);
  assert.equal(navStuck({ isIntersecting: true, top: -10 }), false, 'still partly in view');
  assert.equal(navStuck({ isIntersecting: false, top: 900 }), false, 'below the fold is not stuck');
  assert.equal(navStuck(null), false);
});
