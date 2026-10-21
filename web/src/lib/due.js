// The board's optional due date: `due` is a plain local date, YYYY-MM-DD, with
// no time of day (the server refuses anything else). Everything here works on
// those strings and on calendar-day numbers, never on Date objects in local
// time, so a viewer's timezone or a DST change cannot move a date by a day.

const DUE = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Days since 1970-01-01 for a YYYY-MM-DD string, or null if it is not one.
export const dayNumber = s => {
  const m = typeof s === 'string' && DUE.exec(s);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(ms) ? Math.round(ms / 86400000) : null;
};

export const hasDue = t => dayNumber(t?.due) !== null;

// Today on the viewer's clock, as YYYY-MM-DD. Jeff's devices and the mini are
// all on US Eastern, so this is the mini's date too.
export function localToday(now = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// What the card's chip says and how loud it is, or null for no chip.
//   overdue: the date has passed and the item is not done (red)
//   soon:    due today or within the next 2 days (amber, quiet)
//   later:   further out
//   done:    the item is done; the date is shown without colour
export function dueChip(due, lane, today) {
  const d = dayNumber(due);
  const t = dayNumber(today);
  if (d === null || t === null) return null;
  const diff = d - t;
  const weekday = WEEKDAYS[((d % 7) + 7 + 4) % 7]; // 1970-01-01 was a Thursday
  const date = due.slice(0, 4) === today.slice(0, 4) ? due.slice(5) : due;
  const state = lane === 'done' ? 'done' : diff < 0 ? 'overdue' : diff <= 2 ? 'soon' : 'later';
  let label;
  if (state === 'done') label = `Due ${weekday} ${date}`;
  else if (diff < 0) label = `Overdue ${weekday} ${date}`;
  else if (diff === 0) label = 'Due today';
  else if (diff === 1) label = 'Due tomorrow';
  else label = `Due ${weekday} ${date}`;
  return { label, state, title: `Due ${weekday} ${due}` };
}

// "Sort by due" within a group: dated items first, soonest first, then the
// undated ones. Array.prototype.sort is stable, so run this over a list already
// in its usual order and ties (the same date, or no date) keep that order.
export function byDue(a, b) {
  const da = dayNumber(a.due);
  const db = dayNumber(b.due);
  if (da === null && db === null) return 0;
  if (da === null) return 1;
  if (db === null) return -1;
  return da - db;
}
