import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planTierLabel } from '../lib/plan-tier.mjs';

test('planTierLabel maps every known subscriptionType to the design typography', () => {
  assert.equal(planTierLabel('free'), 'Free');
  assert.equal(planTierLabel('pro'), 'Pro');
  assert.equal(planTierLabel('max_5x'), 'Max — 5×');
  assert.equal(planTierLabel('max5x'), 'Max — 5×');
  assert.equal(planTierLabel('max_20x'), 'Max — 20×');
  assert.equal(planTierLabel('max20x'), 'Max — 20×');
  assert.equal(planTierLabel('team'), 'Team');
  assert.equal(planTierLabel('enterprise'), 'Enterprise');
});

test('planTierLabel is case- and whitespace-insensitive on known values', () => {
  assert.equal(planTierLabel('PRO'), 'Pro');
  assert.equal(planTierLabel(' Max_5X '), 'Max — 5×');
});

test('planTierLabel passes an unrecognised value through unaltered rather than guessing', () => {
  assert.equal(planTierLabel('beta_tier'), 'beta_tier');
  assert.equal(planTierLabel('Some Future Tier'), 'Some Future Tier');
});
