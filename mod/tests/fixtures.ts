// Synthetic data only. The repo is public and the project scrubbed real job
// and project names from its committed fixtures, so nothing here is captured.

export const NOW = Date.parse('2026-10-07T16:00:00Z')
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

const env = (data: unknown, over: Record<string, unknown> = {}) =>
  ({ data, fetchedAt: NOW - MIN, status: 'ok', error: null, ...over })

export const PAYLOAD = {
  usage: env({
    limits: [
      {
        label: 'Current session', pct: 25, resetsAt: new Date(NOW + 3 * HOUR + MIN).toISOString(),
        pace: { state: 'under', elapsed: 0.4, expectedPct: 40, projectedPct: 63 },
        series: [{ t: NOW - 2 * HOUR, pct: 10 }, { t: NOW - HOUR, pct: 18 }, { t: NOW, pct: 25 }]
      },
      {
        label: 'Weekly · all models', pct: 90, resetsAt: new Date(NOW + 3 * DAY + 4 * HOUR).toISOString(),
        pace: { state: 'ahead', elapsed: 0.5, expectedPct: 50, projectedPct: 140 },
        series: [{ t: NOW - DAY, pct: 60 }, { t: NOW, pct: 90 }]
      },
      {
        label: 'Weekly · Fable', pct: 8, resetsAt: null,
        pace: { state: 'unknown-window', elapsed: null, expectedPct: null, projectedPct: null },
        series: []
      }
    ],
    factors: { '7d': { requests: 120, sessions: 8, behaviours: [{ pct: 94, text: 'of your usage was at >150k context' }], top: [] } },
    history: { ok: true, readError: null, writeError: null }
  }),
  sessions: env({
    bySurface: [
      { name: 'Cowork', tokens: 0, measurable: true, pct: 0 },
      { name: 'Code', tokens: 6_700_000, measurable: true, pct: 100 },
      { name: 'Chat', tokens: null, measurable: false, pct: 0 }
    ],
    byProject: [
      { name: 'invoice', tokens: 4_200_000, pct: 63 },
      { name: 'Other', tokens: 2_500_000, pct: 37 }
    ],
    byModel: [{ name: 'Fable', tokens: 6_700_000, pct: 100 }],
    recentSessions: [
      { id: 's1', when: '14:02', title: 'Refactor the invoice exporter', surface: 'Code', model: 'Fable', tokens: 1_500_000, pct: 22 }
    ],
    projects: [
      { name: 'invoice', tool: 'Code', running: true, detail: 'edited 0m ago · main', tasks: null },
      { name: 'warehouse', tool: 'Code', running: false, detail: 'edited 2d ago · feat/etl', tasks: null },
      { name: 'board-notes', tool: 'Cowork', running: false, detail: 'edited 44d ago', tasks: null }
    ],
    unavailableRoots: [],
    unreadablePaths: []
  }),
  agents: env([]),
  crons: env([
    { name: 'nightly', label: 'net.example.nightly', schedule: 'Every day, 02:00', nextRunAt: NOW + 10 * HOUR, ok: false, state: 'failed', last: 'Failed · 1' },
    { name: 'weekly-digest', label: 'net.example.weekly-digest', schedule: 'Sundays, 04:00', nextRunAt: NOW + 4 * DAY, ok: true, state: 'ok', last: 'OK' },
    { name: 'fresh', label: 'net.example.fresh', schedule: 'Every 5 minutes', nextRunAt: null, ok: true, state: 'never', last: 'Not yet run' }
  ]),
  plan: env({ tier: 'Max' }),
  accountCredits: env({
    asOf: NOW - MIN,
    grants: [{ id: 'iguana_necktie', label: 'Cloud session credits', limit: 250, used: 40, remaining: 210, expiresAt: '2026-11-05T07:59:00+00:00' }],
    usageCredits: { balance: null, enabled: false }
  }),
  ingestCrons: env([{ name: 'cloud-digest', label: 'cloud-digest', schedule: 'Reported from elsewhere', nextRunAt: null }]),
  ingestProjects: env(null, { status: 'unavailable', fetchedAt: null }),
  ingestCredits: env(null, { status: 'unavailable', fetchedAt: null }),
  config: env({ warnThreshold: 85, showAlertBanner: true, plan: { nextRenewal: '2026-10-21', seats: '1 · none' }, credits: null, present: true, error: null }),
  alerts: [{ text: 'Weekly · all models at 90%', kind: 'limit', key: 'limit:Weekly · all models' }],
  serverTime: NOW
}

export const TODOS = [
  { id: 't1', text: 'Offsite backup to B2', lane: 'idea', tag: 'Pi', priority: 'P1' },
  { id: 't2', text: 'Mirror the disks', lane: 'done', tag: 'pi', priority: 'P0' },
  { id: 't3', text: 'Retire the old NAS', lane: 'idea', tag: 'Infra', priority: 'P0' },
  { id: 't4', text: 'Write the release notes', lane: 'doing', tag: 'Docs' },
  { id: 't5', text: 'Untagged thought', lane: 'idea' }
]

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))

const reply = (body: unknown, status = 200) =>
  ({ status, ok: status >= 200 && status < 300, headers: { 'content-type': 'application/json' }, text: JSON.stringify(body) })

type On = (event: string, hook: (...args: any[]) => unknown) => unknown

// Stands in for the Control Room server: answers $.http.fetch by path and
// method, and records every write so a test can read what the mod sent.
export function stubServer(on: On, opts: { dashboard?: unknown, todos?: unknown[], dashboardDeny?: string, putStatus?: number } = {}) {
  // `down` takes the server away mid-test: every request is then refused.
  let list = clone(opts.todos ?? TODOS)
  const seen = {
    dashboard: 0, todosGet: 0, puts: [] as any[], headers: [] as any[], down: false,
    // Stands for an edit made somewhere else, such as the web page.
    setList: (next: unknown[]) => { list = clone(next) }
  }
  on('http.fetch', (_$: unknown, e: any) => {
    const url = new URL(e.url)
    const method = e.init?.method ?? 'GET'
    if (seen.down) return { deny: 'connection refused' }
    if (url.pathname === '/api/dashboard') {
      seen.dashboard++
      if (opts.dashboardDeny) return { deny: opts.dashboardDeny }
      return { value: reply(opts.dashboard ?? PAYLOAD) }
    }
    if (url.pathname === '/api/todos' && method === 'GET') {
      seen.todosGet++
      return { value: reply(list) }
    }
    if (url.pathname === '/api/todos' && method === 'PUT') {
      const body = JSON.parse(e.init.body)
      seen.puts.push(body)
      seen.headers.push(e.init.headers)
      if (opts.putStatus && opts.putStatus !== 200) return { value: reply({ error: 'unknown priority: P9' }, opts.putStatus) }
      list = body
      return { value: reply(body) }
    }
    return { value: reply({ error: 'not found' }, 404) }
  })
  return seen
}

// What Claude Code passes a ui.render hook for this pane, apart from the surface.
export const PANE = {
  plugin: 'control-room',
  component: 'Pane',
  requestId: 'control-room',
  viewport: { columns: 160, rows: 50 },
  props: {
    title: 'Control Room',
    isFocused: true,
    bodyColumns: 56,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {}
  }
} as const
