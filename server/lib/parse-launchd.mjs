import { formatSchedule } from './humanize.mjs';

export function parseLaunchctlList(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\t+|\s{2,}/);
    if (parts.length < 3) continue;
    const [pidRaw, statusRaw, label] = parts;
    if (label === 'Label' || !label) continue;
    map.set(label, {
      pid: pidRaw === '-' ? null : Number(pidRaw),
      status: statusRaw === '-' ? null : Number(statusRaw)
    });
  }
  return map;
}

export function nextRun(cal, now) {
  if (!cal) return null;
  const hour = cal.Hour ?? 0;
  const minute = cal.Minute ?? 0;
  const base = new Date(now);
  const candidate = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute, 0, 0);

  if (cal.Weekday === undefined) {
    if (candidate.getTime() <= now) candidate.setDate(candidate.getDate() + 1);
    return candidate.getTime();
  }
  let delta = (cal.Weekday - candidate.getDay() + 7) % 7;
  if (delta === 0 && candidate.getTime() <= now) delta = 7;
  candidate.setDate(candidate.getDate() + delta);
  return candidate.getTime();
}

function readableName(label) {
  const tail = label.split('.').pop();
  return tail || label;
}

export function buildCron({ label, plist, statusRow }, now = Date.now()) {
  const cal = plist?.StartCalendarInterval ?? null;
  const interval = plist?.StartInterval ?? null;
  const status = statusRow?.status ?? null;
  const ok = status === null || status === 0;
  return {
    name: readableName(label),
    label,
    schedule: formatSchedule(cal, interval),
    nextRunAt: nextRun(cal, now),
    ok,
    last: ok ? 'OK' : `Failed · ${status}`
  };
}
