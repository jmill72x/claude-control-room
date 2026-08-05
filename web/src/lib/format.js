export const INK = '#201e1d', ACCENT = '#ec3013', MID = '#605d5d';

export function heat(pct, threshold = 85) {
  if (pct >= threshold) return ACCENT;
  if (pct >= threshold * 0.7) return MID;
  return INK;
}

export function formatCountdown(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

export function formatTokens(n) {
  if (n === null || n === undefined) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

// Returns '' rather than a guess when the renewal date is missing or unparseable:
// an empty header note is honest, "0 days left" is not.
export function billingCycleNote(renews, now = Date.now()) {
  if (!renews) return '';
  const at = Date.parse(renews);
  if (!Number.isFinite(at)) return '';
  const days = Math.max(0, Math.ceil((at - now) / 86400000));
  return `Billing cycle · ${days} day${days === 1 ? '' : 's'} left`;
}
