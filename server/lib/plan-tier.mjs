// `subscriptionType` from `claude auth status --json` is a coarse machine
// string, not the typography the design uses. Map the values known to exist
// today; anything unrecognised passes through unaltered rather than being
// guessed at or hidden — a future tier name is still worth showing raw.
const TIER_LABELS = {
  free: 'Free',
  pro: 'Pro',
  max_5x: 'Max — 5×',
  max5x: 'Max — 5×',
  max_20x: 'Max — 20×',
  max20x: 'Max — 20×',
  team: 'Team',
  enterprise: 'Enterprise'
};

export function planTierLabel(subscriptionType) {
  if (typeof subscriptionType !== 'string') return String(subscriptionType);
  const key = subscriptionType.trim().toLowerCase();
  return TIER_LABELS[key] ?? subscriptionType;
}
