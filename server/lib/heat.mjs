export const INK = '#201e1d';
export const ACCENT = '#ec3013';
export const MID = '#605d5d';

export function heat(pct, threshold = 85) {
  if (pct >= threshold) return ACCENT;
  if (pct >= threshold * 0.7) return MID;
  return INK;
}
