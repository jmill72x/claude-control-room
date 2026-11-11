// The Feed tab (Jarvis OS Phase 2): what the page makes of GET /api/feed
// (server/lib/feed.mjs). The answer is checked again here, post by post, so one bad
// entry is left out rather than shown broken. Text is always text: Feed.jsx hands it
// to the chat's Markdown component, which never builds HTML from it. Checked by
// web/test/orbit-feed.test.js.
import { clock } from './page.js';

export const FEED_POLL_MS = 60_000;
export const KIND_LABEL = { brief: 'Morning brief', digest: 'Weekly digest' };
// A post longer than this is folded, with "Show all" to open it.
export const LONG_CHARS = 700;
export const LONG_LINES = 12;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = n => String(n).padStart(2, '0');
const isPost = x => x !== null && typeof x === 'object' && typeof x.id === 'string' && typeof x.agent === 'string'
  && Number.isFinite(x.at) && typeof x.text === 'string';

// An agent as Avatar wants it: the roster's name and place, or the key alone.
export function agentFor(key, roster) {
  const agents = Array.isArray(roster?.agents) ? roster.agents : [];
  const index = agents.findIndex(a => a.key === key);
  return index >= 0 ? { key, name: agents[index].name, index } : { key, name: String(key), index: -1 };
}

// What the tab shows for a filter (an agent's key, or null for all): the pins (the
// lead's newest brief and digest, newest first, shown with All or the lead's
// filter), the posts newest first, and the filter buttons: All, then each agent
// with posts in roster order, and the one picked even if it has none.
export function feedView(feed, { filter = null, roster } = {}) {
  const posts = (Array.isArray(feed?.posts) ? feed.posts : []).filter(isPost).sort((a, b) => b.at - a.at);
  const lead = roster?.agents?.[0]?.key ?? null;
  const pins = ['brief', 'digest']
    .map(kind => (isPost(feed?.pinned?.[kind]) ? { ...feed.pinned[kind], label: KIND_LABEL[kind] } : null))
    .filter(Boolean)
    .sort((a, b) => b.at - a.at);
  const counts = new Map();
  for (const x of [...posts, ...pins]) counts.set(x.agent, (counts.get(x.agent) ?? 0) + 1);
  const keys = (Array.isArray(roster?.agents) ? roster.agents.map(a => a.key) : []);
  for (const key of counts.keys()) if (!keys.includes(key)) keys.push(key);
  const filters = [{ key: null, name: 'All', count: posts.length + pins.length }];
  for (const key of keys) {
    if (counts.has(key) || key === filter) filters.push({ key, name: agentFor(key, roster).name, count: counts.get(key) ?? 0 });
  }
  if (filter !== null && !filters.some(f => f.key === filter)) filters.push({ key: filter, name: String(filter), count: 0 });
  return {
    pins: filter === null || filter === lead ? pins.filter(x => filter === null || x.agent === filter) : [],
    posts: filter === null ? posts : posts.filter(x => x.agent === filter),
    filters
  };
}

// discord-post opens a post's text with its title in bold: shown as the card's
// heading, so the body leaves it out. Only the post's own title, exactly.
export function bodyOf(post) {
  const title = post?.title;
  const text = String(post?.text ?? '');
  if (typeof title !== 'string' || title === '') return text;
  const head = `**${title}**`;
  if (text === head) return '';
  return text.startsWith(`${head}\n`) ? text.slice(head.length + 1) : text;
}

export const isLong = text => text.length > LONG_CHARS || text.split('\n').length > LONG_LINES;

// Today, Yesterday, or "Mon 11-09", in local time.
export function dayLabel(at, now) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const start = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(new Date(now)) - start(d)) / 86400e3);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return `${WEEKDAYS[d.getDay()]} ${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export const whenLabel = (at, now) => `${dayLabel(at, now)} · ${clock(at)}`;

// Under the list when the server left older posts out to keep the answer small.
export const droppedWords = n => (Number.isInteger(n) && n > 0 ? `${n} older post${n === 1 ? '' : 's'} left out to keep this page light.` : null);

// A refusal's status as the tab's state.
export const phaseForStatus = status => (status === 401 ? 'unpaired' : status === 403 ? 'forbidden' : 'error');

// The words for a feed with nothing to show, by the server's status.
export function emptyWords(status) {
  if (status === 'missing') return 'No posts yet. Each agent\'s posts show here from the first one discord-post keeps a copy of.';
  if (status === 'refused') return 'The feed folder failed its safety check, so nothing is shown. The service log says why.';
  if (status === 'off') return 'The feed is switched off in this server\'s config.';
  return 'No posts to show.';
}
