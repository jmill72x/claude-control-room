// Tokens hour by hour, for the Orbit page's Burn panel and the week's heat map.
// Built from the per-request records the sessions collector already parses, so
// each request counts once and the figure is new tokens (no cache reads), the
// same as every other token figure on the dashboard. Hours are clock hours in the
// server's local time, which on the mini is the time its reader keeps.

const HOUR = 3600 * 1000;
const pad = n => String(n).padStart(2, '0');
const localDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const FAMILIES = ['opus', 'fable', 'sonnet', 'haiku', 'other'];

// Any model id the four names don't match (Mythos, a new model, a synthetic
// placeholder) is Other: counted, never dropped and never guessed into a family.
export function familyOf(model) {
  const id = String(model ?? '');
  if (/opus/i.test(id)) return 'opus';
  if (/fable/i.test(id)) return 'fable';
  if (/sonnet/i.test(id)) return 'sonnet';
  if (/haiku/i.test(id)) return 'haiku';
  return 'other';
}

const startOfHour = ts => {
  const d = new Date(ts);
  d.setMinutes(0, 0, 0);
  return d.getTime();
};

// `last24h`: the current clock hour and the 23 before it, oldest first, each
//   split by family.
// `lastHour`: the rolling 60 minutes up to now (Burn's headline figure).
// `week.days`: today and the 6 calendar days before it, oldest first, each with
//   24 local clock hours and a total. On the night the clocks go back, both 1 AMs
//   land in hour 1; on the night they go forward, hour 2 stays empty.
// `week.peak`: the week's busiest hour, or null when there was no use at all.
export function buildHourly(transcripts, now) {
  const first = startOfHour(now) - 23 * HOUR;
  const last24h = Array.from({ length: 24 }, (_, i) => {
    const bucket = { start: first + i * HOUR };
    for (const f of FAMILIES) bucket[f] = 0;
    return bucket;
  });

  const today = new Date(now);
  const days = [];
  for (let back = 6; back >= 0; back--) {
    // Built from (year, month, day) so a DST change can't shift a day's start.
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
    days.push({ date: localDate(start), start: start.getTime(), hours: new Array(24).fill(0), total: 0 });
  }

  let lastHour = 0;
  for (const t of transcripts ?? []) {
    for (const r of t?.records ?? []) {
      if (!Number.isFinite(r?.ts) || r.ts > now || !(r.tokens > 0)) continue;
      if (r.ts > now - HOUR) lastHour += r.tokens;
      if (r.ts >= first) last24h[Math.floor((r.ts - first) / HOUR)][familyOf(r.model)] += r.tokens;
      if (r.ts >= days[0].start) {
        let k = days.length - 1;
        while (r.ts < days[k].start) k--;
        days[k].hours[new Date(r.ts).getHours()] += r.tokens;
        days[k].total += r.tokens;
      }
    }
  }

  let peak = null;
  for (const d of days) {
    d.hours.forEach((tokens, hour) => {
      if (tokens > 0 && (peak === null || tokens > peak.tokens)) peak = { date: d.date, hour, tokens };
    });
  }
  return { last24h, lastHour, week: { days, peak } };
}
