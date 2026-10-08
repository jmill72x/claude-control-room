// Pure functions over the Control Room server's JSON: no `$`, no I/O, so the
// pane and the text summary share one set of rules and every rule is unit
// tested. The rules are the web page's (web/src), carried over as they are:
// a value the server could not read is said to be unknown, never drawn as 0.

export const PRIORITIES = ['P0', 'P1', 'P2', 'P3']

export const LANES = [
  { key: 'idea', title: 'Idea', next: 'doing' },
  { key: 'doing', title: 'Doing', next: 'done' },
  { key: 'done', title: 'Done', next: 'idea' }
]
const LANE = Object.fromEntries(LANES.map(l => [l.key, l]))

export const rank = p => (PRIORITIES.includes(p) ? PRIORITIES.indexOf(p) : PRIORITIES.length)
export const tagKey = t => (typeof t === 'string' ? t.trim().toLowerCase() : '')

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const BLOCKS = '▁▂▃▄▅▆▇█'
const pad = n => String(n).padStart(2, '0')
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
export const clip = (s, n) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s)

// Theme keys rather than colours, so the pane follows the user's theme.
// The web page's three tiers: accent at the threshold, mid from 70% of it.
export function heat(pct, threshold = 85) {
  if (!Number.isFinite(pct)) return undefined
  if (pct >= threshold) return 'error'
  if (pct >= threshold * 0.7) return 'warning'
  return undefined
}

// Each state says exactly what is known; an unrecognised one says nothing.
export function paceNote(pace) {
  if (!pace) return ''
  switch (pace.state) {
    case 'unknown-window': return 'window length not yet observed'
    case 'too-early': return 'too early to project'
    case 'window-ended': return 'window ended · awaiting a fresh reading'
    case 'ahead': return `ahead of pace · projected ${pace.projectedPct}% by reset`
    case 'under': return `under pace · projected ${pace.projectedPct}% by reset`
    case 'on': return `on pace · projected ${pace.projectedPct}% by reset`
    default: return ''
  }
}

export function formatTokens(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return String(n)
}

// Minute precision: the pane redraws on a timer, so a seconds countdown would
// be stale the moment it was drawn.
export function formatUntil(ms) {
  const total = Math.floor(Math.max(0, ms) / MIN)
  if (total < 60) return `${total}m`
  if (total < 24 * 60) return `${Math.floor(total / 60)}h ${pad(total % 60)}m`
  return `${Math.floor(total / (24 * 60))}d ${Math.floor((total % (24 * 60)) / 60)}h`
}

export function formatAgo(ms) {
  const s = Math.floor(Math.max(0, ms) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

// A bare YYYY-MM-DD is a calendar date, read as local midnight; a full
// timestamp is an instant, shown as the local date it falls on.
export function parseDate(value) {
  if (typeof value !== 'string' || !value) return null
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

export function formatDate(value) {
  const d = parseDate(value)
  return d ? `${MONTHS[d.getMonth()]} ${d.getDate()}` : '—'
}

export function daysUntil(value, now) {
  const d = parseDate(value)
  return d ? Math.ceil((d.getTime() - now) / DAY) : null
}

export const money = v => (Number.isFinite(v) ? `$${v.toFixed(2)}` : '—')

export function clockTime(now) {
  const d = new Date(now)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// An unknown percentage is hatched, never an empty bar, which would claim 0%.
export function bar(pct, width) {
  const w = Math.max(1, Math.floor(width))
  if (!Number.isFinite(pct)) return '╌'.repeat(w)
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * w)
  return '█'.repeat(filled) + '░'.repeat(w - filled)
}

// Real readings only. When there are more than fit, evenly spaced ones are
// kept (always the first and the newest); nothing is averaged or filled in.
// Scaled to at least 100, as the web sparkline is, so 5% does not look full.
export function sparkline(series, width) {
  const points = Array.isArray(series)
    ? series.filter(p => Number.isFinite(p?.t) && Number.isFinite(p?.pct))
    : []
  if (points.length < 2) return null
  const w = Math.max(2, Math.floor(width))
  const picked = points.length <= w
    ? points
    : Array.from({ length: w }, (_, i) => points[Math.round((i * (points.length - 1)) / (w - 1))])
  const max = Math.max(100, ...points.map(p => p.pct))
  return picked
    .map(p => BLOCKS[Math.min(7, Math.max(0, Math.round((p.pct / max) * 7)))])
    .join('')
}

// A missing envelope is the strongest form of unavailable: nothing was heard.
export function envelopeOf(payload, key) {
  const e = payload?.[key]
  if (isObject(e) && typeof e.status === 'string') {
    return { data: e.data ?? null, status: e.status, error: e.error ?? null, fetchedAt: e.fetchedAt ?? null }
  }
  return { data: null, status: 'unavailable', error: 'no response from the server yet', fetchedAt: null }
}

export function staleNote(env, now) {
  if (env.status !== 'stale') return ''
  return Number.isFinite(env.fetchedAt) ? `stale · ${formatAgo(now - env.fetchedAt)}` : 'stale'
}

const listOf = env => (Array.isArray(env.data) ? env.data : [])

// A cron launchd loaded but never ran has no exit status: not failing, not
// OK. An ingested cron that reports neither is unknown.
export function cronState(c) {
  if (c.state === 'ok' || c.state === 'failed' || c.state === 'never') return c.state
  if (c.ok === false) return 'failed'
  if (c.ok === true) return 'ok'
  return 'unknown'
}

const CRON_ORDER = { failed: 0, unknown: 1, never: 2, ok: 2 }

export function cronList(payload) {
  return [...listOf(envelopeOf(payload, 'crons')), ...listOf(envelopeOf(payload, 'ingestCrons'))]
    .map((c, i) => ({ c, i }))
    .sort((a, b) =>
      CRON_ORDER[cronState(a.c)] - CRON_ORDER[cronState(b.c)] ||
      (a.c.nextRunAt ?? Infinity) - (b.c.nextRunAt ?? Infinity) ||
      a.i - b.i)
    .map(x => x.c)
}

export function cronSummary(list) {
  const failing = list.filter(c => c.ok === false).length
  const unknown = list.filter(c => cronState(c) === 'unknown').length
  return `${failing} failing · ${list.length} scheduled` + (unknown > 0 ? ` · ${unknown} unknown` : '')
}

// `running` that is neither true nor false means the agents source could not
// be read, which is not the same fact as idle.
export function projectList(payload) {
  const items = [...listOf({ data: envelopeOf(payload, 'sessions').data?.projects }), ...listOf(envelopeOf(payload, 'ingestProjects'))]
  const runningUnknown = items.some(p => p.running !== true && p.running !== false)
  const summary = runningUnknown
    ? `${items.length} total · running unknown`
    : `${items.filter(p => p.running === true).length} running · ${items.length} total`
  return { items, summary, runningUnknown }
}

// The account's own usage response wins; hand-entered figures (the ingest
// feed, then config.json) only stand in when it cannot be read.
export function creditsView(payload) {
  const account = envelopeOf(payload, 'accountCredits')
  if (isObject(account.data) && Array.isArray(account.data.grants)) {
    const balance = account.data.usageCredits?.balance
    return { source: 'account', env: account, grants: account.data.grants, usageBalance: Number.isFinite(balance) ? balance : null }
  }
  const ingest = envelopeOf(payload, 'ingestCredits')
  const config = envelopeOf(payload, 'config')
  const fromIngest = isObject(ingest.data) ? ingest.data : null
  const hand = fromIngest ?? (isObject(config.data?.credits) ? config.data.credits : null)
  if (hand) {
    const dated = !hand.updatedAt && fromIngest && Number.isFinite(ingest.fetchedAt)
      ? new Date(ingest.fetchedAt).toISOString().slice(0, 10)
      : hand.updatedAt ?? null
    return {
      source: 'hand',
      env: fromIngest ? ingest : config,
      balance: Number.isFinite(hand.balance) ? hand.balance : null,
      spent: Number.isFinite(hand.spent) ? hand.spent : null,
      monthlyLimit: Number.isFinite(hand.monthlyLimit) ? hand.monthlyLimit : null,
      promoExpiresOn: hand.promoExpiresOn ?? null,
      updatedAt: dated
    }
  }
  return { source: null, reason: account.error ?? 'no credits source has reported' }
}

const byPriority = (a, b) => rank(a.priority) - rank(b.priority)

// Stage: the three lanes. Tag: one group per tag, case-folded, ranked by its
// best OPEN priority, done items sinking within it. Both as the web page.
export function groupTodos(todos, groupBy) {
  const list = Array.isArray(todos) ? todos : []
  if (groupBy !== 'tag') {
    return LANES.map(lane => ({ key: lane.key, title: lane.title, items: list.filter(t => t.lane === lane.key).sort(byPriority) }))
  }
  const map = new Map()
  for (const t of list) {
    const k = tagKey(t.tag)
    if (!map.has(k)) map.set(k, { key: `tag:${k}`, title: (typeof t.tag === 'string' && t.tag.trim()) || 'No tag', items: [] })
    map.get(k).items.push(t)
  }
  return [...map.values()]
    .map(g => {
      g.items.sort((a, b) => (a.lane === 'done') - (b.lane === 'done') || byPriority(a, b))
      const open = g.items.filter(t => t.lane !== 'done')
      return { ...g, best: open.length ? Math.min(...open.map(t => rank(t.priority))) : PRIORITIES.length + 1 }
    })
    .sort((a, b) => a.best - b.best || a.title.localeCompare(b.title))
    .map(({ best, ...g }) => g)
}

// Tags as the add box offers them: one per case-folded tag, first-seen casing.
export function tagChoices(todos) {
  const seen = new Map()
  for (const t of Array.isArray(todos) ? todos : []) {
    const k = tagKey(t.tag)
    if (k && !seen.has(k)) seen.set(k, t.tag.trim())
  }
  return [...seen.values()]
}

export function cyclePriority(todo) {
  const i = PRIORITIES.indexOf(todo.priority)
  if (i === PRIORITIES.length - 1) {
    const { priority: _dropped, ...rest } = todo
    return rest
  }
  return { ...todo, priority: PRIORITIES[i + 1] }
}

export function advanceStage(todo) {
  return { ...todo, lane: LANE[todo.lane]?.next ?? 'idea' }
}

export const nextLaneTitle = todo => LANE[LANE[todo.lane]?.next ?? 'idea'].title

export function makeTodo({ text, tag }, id) {
  const body = typeof text === 'string' ? text.trim() : ''
  if (!body) return null
  const label = typeof tag === 'string' ? tag.trim() : ''
  return label ? { id, text: body, lane: 'idea', tag: label } : { id, text: body, lane: 'idea' }
}

// `null` when the item is gone (changed elsewhere), so the caller writes nothing.
export function updateItem(list, id, change) {
  if (!list.some(t => t.id === id)) return null
  return list.map(t => (t.id === id ? change(t) : t))
}

export function removeItem(list, id) {
  if (!list.some(t => t.id === id)) return null
  return list.filter(t => t.id !== id)
}

export function workPrompt(todo) {
  const facts = [todo.tag, todo.priority].filter(Boolean).join(', ')
  return `Let's work on this to-do from my Control Room board: "${todo.text}"${facts ? ` [${facts}]` : ''}.`
}

const unavailable = env => `unavailable — ${env.error ?? 'no reading yet'}`
const withStale = (text, env, now) => {
  const note = staleNote(env, now)
  return note ? `${text} (${note})` : text
}

function limitsLine(payload, now) {
  const env = envelopeOf(payload, 'usage')
  const limits = Array.isArray(env.data?.limits) ? env.data.limits : null
  if (env.status === 'unavailable' || !limits) return `Limits: ${unavailable(env)}`
  const parts = limits.map(l => {
    const at = Date.parse(l.resetsAt)
    return `${l.label} ${l.pct}%` + (Number.isFinite(at) ? ` (resets in ${formatUntil(at - now)})` : '')
  })
  return withStale(`Limits: ${parts.join(' · ')}`, env, now)
}

function creditsLine(payload, now) {
  const view = creditsView(payload)
  if (view.source === 'account') {
    const grants = view.grants.map(g =>
      `${g.label} ${money(g.remaining)} of ${money(g.limit)} left` + (g.expiresAt ? `, expires ${formatDate(g.expiresAt)}` : ''))
    const parts = grants.length ? grants : ['no included or promotional credit']
    if (view.usageBalance !== null) parts.push(`usage credits ${money(view.usageBalance)}`)
    return withStale(`Credits: ${parts.join('; ')}`, view.env, now)
  }
  if (view.source === 'hand') {
    return withStale(`Credits: ${money(view.balance)} balance (hand-entered, updated ${formatDate(view.updatedAt)})`, view.env, now)
  }
  return `Credits: unavailable — ${view.reason}`
}

function planLine(payload, now) {
  const env = envelopeOf(payload, 'plan')
  const tier = env.status !== 'unavailable' ? env.data?.tier : null
  if (!tier) return `Plan: ${unavailable(env)}`
  const renews = envelopeOf(payload, 'config').data?.plan?.nextRenewal
  return withStale(`Plan: ${tier}` + (renews ? ` · renews ${formatDate(renews)}` : ''), env, now)
}

function projectsLine(payload, now) {
  const env = envelopeOf(payload, 'sessions')
  if (env.status === 'unavailable') return `Projects: ${unavailable(env)}`
  const { items, summary } = projectList(payload)
  const running = items.filter(p => p.running === true).map(p => p.name)
  return withStale(`Projects: ${summary}` + (running.length ? ` · running: ${running.join(', ')}` : ''), env, now)
}

function cronsLine(payload, now) {
  const env = envelopeOf(payload, 'crons')
  const ingest = envelopeOf(payload, 'ingestCrons')
  if (env.status === 'unavailable' && ingest.status === 'unavailable') return `Crons: ${unavailable(env)}`
  const list = cronList(payload)
  const failing = list.filter(c => cronState(c) === 'failed').map(c => c.name)
  return withStale(`Crons: ${cronSummary(list)}` + (failing.length ? ` · failing: ${failing.join(', ')}` : ''), env, now)
}

function todoLines(todos) {
  if (!Array.isArray(todos)) return ['To-dos: unavailable']
  const count = lane => todos.filter(t => t.lane === lane).length
  const lines = [`To-dos: ${count('doing')} doing · ${plural(count('idea'), 'idea')} · ${count('done')} done`]
  // Read on phones over Remote Control, so one line per item, not a paragraph.
  const tagged = t => `${clip(String(t.text ?? ''), 72)}${t.tag ? ` [${t.tag}]` : ''}`
  todos.filter(t => t.lane !== 'done' && rank(t.priority) <= 1).sort(byPriority).slice(0, 5)
    .forEach(t => lines.push(`  ${t.priority} ${tagged(t)}`))
  todos.filter(t => t.lane === 'doing' && rank(t.priority) > 1).slice(0, 3)
    .forEach(t => lines.push(`  Doing: ${tagged(t)}`))
  return lines
}

// The board as plain text, for a session where no pane can draw (`claude -p`,
// a phone over Remote Control). Claude reads it too, so it stays short.
export function summaryText({ payload, todos, now, url, error = null, fetchedAt = null }) {
  if (error && !payload) return `Control Room unreachable at ${url}: ${error}`
  const head = error
    ? `Control Room unreachable at ${url}: ${error}. Last reading, from ${Number.isFinite(fetchedAt) ? formatAgo(now - fetchedAt) : 'an unknown time'}:`
    : `Control Room · as of ${clockTime(now)}`
  const alerts = Array.isArray(payload?.alerts) ? payload.alerts.map(a => a?.text).filter(Boolean) : []
  return [
    head,
    `Alerts: ${alerts.length ? alerts.join(' · ') : 'none'}`,
    limitsLine(payload, now),
    creditsLine(payload, now),
    planLine(payload, now),
    projectsLine(payload, now),
    cronsLine(payload, now),
    ...todoLines(todos)
  ].join('\n')
}
