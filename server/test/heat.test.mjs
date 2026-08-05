import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heat } from '../lib/heat.mjs';

test('at or above threshold is accent', () => {
  assert.equal(heat(85), '#ec3013');
  assert.equal(heat(100), '#ec3013');
  assert.equal(heat(118), '#ec3013');
});

test('at or above 70% of threshold is mid grey', () => {
  assert.equal(heat(60), '#605d5d');
  assert.equal(heat(84), '#605d5d');
});

test('below that is ink', () => {
  assert.equal(heat(0), '#201e1d');
  assert.equal(heat(59), '#201e1d');
});

test('threshold is configurable', () => {
  assert.equal(heat(70, 70), '#ec3013');
  assert.equal(heat(50, 70), '#605d5d');
});
