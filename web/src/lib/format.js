export const INK = '#201e1d', ACCENT = '#ec3013', MID = '#605d5d';

export function heat(pct, threshold = 85) {
  if (pct >= threshold) return ACCENT;
  if (pct >= threshold * 0.7) return MID;
  return INK;
}

// Each state says exactly what is known. 'unknown-window' and 'too-early' are
// not failures — they are honest reports that a projection would be a guess.
export function paceNote(pace) {
  if (!pace) return '';
  switch (pace.state) {
    case 'unknown-window': return 'window length not yet observed';
    case 'too-early': return 'too early to project';
    case 'ahead': return `ahead of pace · projected ${pace.projectedPct}% by reset`;
    case 'under': return `under pace · projected ${pace.projectedPct}% by reset`;
    case 'on': return `on pace · projected ${pace.projectedPct}% by reset`;
    default: return '';
  }
}

export function formatCountdown(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = n => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// The design spec prints dates as 'Aug 21, 2026', not as the raw ISO the config holds.
export function formatDate(value) {
  if (!value) return '—';
  const d = new Date(`${value}T00:00:00`);
  if (Number.isNaN(d.getTime())) return String(value);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

// A weekly window is days away, and 'resets 118:15:50' is unreadable. Use the
// clock format only where it is meaningful — under a day.
export function formatUntil(ms) {
  const total = Math.max(0, ms);
  if (total < 24 * 3600 * 1000) return formatCountdown(total);
  const d = Math.floor(total / (24 * 3600 * 1000));
  const h = Math.floor((total % (24 * 3600 * 1000)) / 3600000);
  return `${d}d ${h}h`;
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

// Before the first poll lands — and for the whole time the server is down — there
// is no envelope at all. A missing envelope is not "fine", it is the strongest
// form of unavailable: we have not heard anything. Every consumer must treat the
// two identically, so the normalisation lives here rather than at each call site.
export const NO_ENVELOPE = Object.freeze({
  data: null, fetchedAt: null, status: 'unavailable', error: 'no response from the server yet'
});

export function envelopeOf(envelope) {
  return envelope && typeof envelope === 'object' && typeof envelope.status === 'string'
    ? envelope
    : NO_ENVELOPE;
}

// A count derived from missing data is a fabrication. Render an em dash instead.
// `undefined` (no payload yet, or a dead server) must dash exactly like an
// explicit 'unavailable' — the earlier `status === 'unavailable'` test let a
// missing envelope through and printed "0 running · 0 total" as fact.
export function summaryOrDash(envelope, text) {
  return envelopeOf(envelope).status === 'unavailable' ? '—' : text;
}

// An ingest feed is written by whatever posted to it. A payload that is not the
// array every consumer assumes must be ignored *visibly*, never spread (which
// throws) and never silently dropped (which understates).
export function arrayFrom(envelope) {
  const data = envelope?.data;
  if (data === null || data === undefined) return { items: [], invalid: false };
  if (Array.isArray(data)) return { items: data, invalid: false };
  return { items: [], invalid: true };
}
