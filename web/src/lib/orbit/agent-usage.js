// The Agents card's Tokens tab: each agent's tokens as Claude Code's own OpenTelemetry
// metrics count them, beside the transcripts' count of the same hours (Orbit Phase 6,
// board 1e46584d). Plain functions over the `otel` panel the server builds
// (server/lib/otel.mjs, buildOtelPanel), checked by web/test/orbit-agent-usage.test.js.
import { compactTokens, unavailable, ago } from './page.js';
import { agentOf } from './board.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = n => String(n).padStart(2, '0');
const dayLabel = ts => {
  const d = new Date(ts);
  return `${WEEKDAYS[d.getDay()]} ${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export const USAGE_WORDS = Object.freeze({
  oldServer: 'The server running now does not send usage by agent. It arrives with its next restart.',
  unset: 'Usage by agent from OpenTelemetry is off on this server: config has no otel block.',
  off: 'Usage by agent from OpenTelemetry is off on this server (otel.enabled is false).',
  failed: "The OpenTelemetry receiver isn't running: it could not listen on its port. The service log says why.",
  waiting: 'No data yet. The receiver is listening on this machine; the figures arrive once Claude Code sends its metrics.',
  noRoster: 'No agents are listed in config, so no usage has anyone to belong to.',
  redacted: 'Some agents arrived named only "custom", so their tokens count to the lead or to Other. OTEL_LOG_TOOL_DETAILS=1 names them.',
  checkLater: 'The check with the transcripts starts after the first full hour.'
});

const VERDICT_WORDS = { matches: 'matches the transcripts', small: 'too little to check' };
const TOTAL_WORDS = { matches: 'they match', differs: 'they differ', small: 'too little to check' };

// The cross-check's words for one count pair: `differs` names the transcripts' figure.
export function checkWords(row) {
  if (!row) return null;
  if (row.verdict === 'differs') return `transcripts say ${compactTokens(row.transcripts)}`;
  return VERDICT_WORDS[row.verdict] ?? null;
}

// The tab's view: `note` when there is nothing to draw (and why), otherwise one row per
// roster agent in roster order, an Other row, the total line, and the sub line.
export function usageView({ env, roster, now }) {
  const empty = note => ({ note, rows: [], other: null, total: null, sub: null, redacted: false, differs: 0, checkNote: null });
  if (!env || typeof env !== 'object' || typeof env.status !== 'string') return empty(USAGE_WORDS.oldServer);
  if (env.status === 'unavailable') return empty(unavailable(env));
  const otel = env.data;
  if (!otel || typeof otel !== 'object') return empty(USAGE_WORDS.oldServer);
  if (otel.state === 'unset' || otel.state === 'off' || otel.state === 'failed' || otel.state === 'waiting') return empty(USAGE_WORDS[otel.state]);
  if (otel.state !== 'on') return empty(USAGE_WORDS.oldServer);
  if (!(roster?.agents?.length > 0)) return empty(USAGE_WORDS.noRoster);

  const byKey = new Map((Array.isArray(otel.agents) ? otel.agents : []).map(a => [a.key, a]));
  const checkOf = new Map((otel.check?.rows ?? []).map(r => [r.key, r]));
  const rows = roster.agents.map(a => {
    const got = byKey.get(a.key) ?? {};
    const check = checkOf.get(a.key) ?? null;
    return {
      key: a.key,
      agent: agentOf(a.key, roster),
      name: a.name,
      day: compactTokens(got.tokens24h ?? 0),
      week: compactTokens(got.tokens7d ?? 0),
      check: checkWords(check),
      differs: check?.verdict === 'differs'
    };
  });
  const other = otel.other ? { day: compactTokens(otel.other.tokens24h ?? 0), week: compactTokens(otel.other.tokens7d ?? 0) } : null;
  const hours = otel.check ? Math.round((otel.check.to - otel.check.from) / 3600e3) : 0;
  const total = otel.check?.total ? {
    text: `All sessions, last ${hours} h: ${compactTokens(otel.check.total.otel)} from OpenTelemetry, ${compactTokens(otel.check.total.transcripts)} in the transcripts`,
    verdict: otel.check.total.verdict,
    words: TOTAL_WORDS[otel.check.total.verdict] ?? null
  } : null;
  const since = Number.isFinite(otel.since) ? dayLabel(otel.since) : null;
  // Claude Code sends metrics only while it runs, so a quiet night shows here as an old time.
  const fresh = Number.isFinite(otel.lastAt) && Number.isFinite(now) && now - otel.lastAt > 15 * 60e3 ? ` · last metrics ${ago(now - otel.lastAt)}` : '';
  return {
    note: null,
    rows,
    other,
    total,
    sub: `new tokens from OpenTelemetry${since ? ` since ${since}` : ''}${fresh}`,
    redacted: otel.redacted === true,
    differs: rows.filter(r => r.differs).length + (otel.check?.total?.verdict === 'differs' ? 1 : 0),
    checkNote: otel.check ? null : USAGE_WORDS.checkLater
  };
}
