import { expect, test } from 'claude-code/testing'
import {
  heat, paceNote, formatTokens, formatUntil, formatAgo, formatDate, bar, sparkline,
  envelopeOf, cronState, cronList, cronSummary, projectList, creditsView,
  groupTodos, cyclePriority, advanceStage, makeTodo, summaryText
} from '../hooks/model.js'
import { NOW, PAYLOAD, TODOS, clone } from './fixtures.ts'

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR

test('heat matches the web page: error at the threshold, warning from 70% of it, plain below', () => {
  expect(heat(85, 85)).toBe('error')
  expect(heat(60, 85)).toBe('warning')
  expect(heat(59, 85)).toBeUndefined()
})

test('pace wording is the web page\'s, and an unknown state says nothing rather than guess', () => {
  expect(paceNote({ state: 'ahead', projectedPct: 140 })).toBe('ahead of pace · projected 140% by reset')
  expect(paceNote({ state: 'unknown-window' })).toBe('window length not yet observed')
  expect(paceNote({ state: 'something-new' })).toBe('')
  expect(paceNote(null)).toBe('')
})

test('times read at minute precision, since the pane redraws on a timer, not every second', () => {
  expect(formatUntil(3 * HOUR + MIN)).toBe('3h 01m')
  expect(formatUntil(45 * MIN + 30_000)).toBe('45m')
  expect(formatUntil(3 * DAY + 4 * HOUR)).toBe('3d 4h')
  expect(formatUntil(-5 * MIN)).toBe('0m')
  expect(formatAgo(12_000)).toBe('12s ago')
  expect(formatAgo(4 * MIN)).toBe('4m ago')
  expect(formatAgo(3 * HOUR)).toBe('3h ago')
  expect(formatAgo(2 * DAY)).toBe('2d ago')
  expect(formatTokens(6_700_000)).toBe('6.7M')
  expect(formatTokens(null)).toBe('—')
})

test('a date-only string is a local calendar date, and an unreadable one is a dash, not a guess', () => {
  expect(formatDate('2026-10-21')).toBe('Oct 21')
  expect(formatDate('2026-11-05T07:59:00+00:00')).toBe('Nov 5')
  expect(formatDate('soon')).toBe('—')
  expect(formatDate(null)).toBe('—')
})

test('bars fill in proportion, clamp past 100, and an unknown percentage is hatched, never empty', () => {
  expect(bar(50, 10)).toBe('█████░░░░░')
  expect(bar(130, 4)).toBe('████')
  expect(bar(null, 4)).toBe('╌╌╌╌')
})

test('a sparkline needs two real readings, scales to at least 100, and never invents a point', () => {
  expect(sparkline([{ t: 1, pct: 10 }], 10)).toBeNull()
  expect(sparkline([{ t: 1, pct: 0 }, { t: 2, pct: 100 }], 10)).toBe('▁█')
  const many = Array.from({ length: 50 }, (_, i) => ({ t: i, pct: i * 2 }))
  const line = sparkline(many, 10)!
  expect(line.length).toBe(10)
  expect(line.endsWith('█')).toBe(true)
  expect(sparkline([{ t: 1, pct: 'x' }, { t: 2, pct: 5 }], 10)).toBeNull()
})

test('a missing envelope is unavailable, the strongest form of not knowing', () => {
  expect(envelopeOf({}, 'usage')).toMatchObject({ status: 'unavailable', data: null })
  expect(envelopeOf(null, 'usage').error).toMatch(/no response/)
  expect(envelopeOf(PAYLOAD, 'plan')).toMatchObject({ status: 'ok', data: { tier: 'Max' } })
})

// Failed, then unknown, then the rest by next run. The web page's comparator
// (ok === ok ? by next run : ok ? 1 : -1) is inconsistent for an unknown ok,
// ranking it before a failure one way and after it the other.
test('crons merge both feeds, failing first, then unknown, then by next run', () => {
  const list = cronList(PAYLOAD)
  expect(list.map(c => c.name)).toEqual(['nightly', 'cloud-digest', 'weekly-digest', 'fresh'])
  expect(list.map(cronState)).toEqual(['failed', 'unknown', 'ok', 'never'])
  expect(cronSummary(list)).toBe('1 failing · 4 scheduled · 1 unknown')
})

test('projects count running, and an unreadable running state is said, not summarised as idle', () => {
  expect(projectList(PAYLOAD).summary).toBe('1 running · 3 total')
  const p = clone(PAYLOAD) as any
  p.sessions.data.projects[1].running = null
  expect(projectList(p).summary).toBe('3 total · running unknown')
})

test('credits come from the account first, then the ingest feed, then config, and say when none exist', () => {
  expect(creditsView(PAYLOAD)).toMatchObject({ source: 'account', grants: [{ label: 'Cloud session credits', remaining: 210 }] })
  const ingest = clone(PAYLOAD) as any
  ingest.accountCredits = { data: null, status: 'unavailable', error: 'cache too old' }
  ingest.ingestCredits = { data: { balance: 12, updatedAt: '2026-10-01' }, status: 'ok' }
  expect(creditsView(ingest)).toMatchObject({ source: 'hand', balance: 12 })
  const none = clone(ingest) as any
  none.ingestCredits = { data: null, status: 'unavailable' }
  expect(creditsView(none)).toMatchObject({ source: null })
  expect(creditsView(none).reason).toMatch(/cache too old/)
})

test('stage groups are the three lanes, each sorted by priority with unset last', () => {
  const groups = groupTodos(TODOS, 'stage')
  expect(groups.map(g => g.title)).toEqual(['Idea', 'Doing', 'Done'])
  expect(groups[0].items.map(t => t.id)).toEqual(['t3', 't1', 't5'])
})

test('tag groups fold case, rank by best OPEN priority, and sink done items', () => {
  const groups = groupTodos(TODOS, 'tag')
  // Pi's only P0 is done, so Infra (open P0) leads and Pi (open P1) follows.
  expect(groups.map(g => g.title)).toEqual(['Infra', 'Pi', 'Docs', 'No tag'])
  expect(groups[1].items.map(t => t.id)).toEqual(['t1', 't2'])
})

test('priority cycles P0 to P3 then clears, and the stage cycles idea, doing, done, idea', () => {
  expect(cyclePriority({ id: 'a', text: 'x', lane: 'idea' })).toEqual({ id: 'a', text: 'x', lane: 'idea', priority: 'P0' })
  expect(cyclePriority({ id: 'a', text: 'x', lane: 'idea', priority: 'P3' })).toEqual({ id: 'a', text: 'x', lane: 'idea' })
  expect(advanceStage({ id: 'a', text: 'x', lane: 'done' }).lane).toBe('idea')
  expect(advanceStage({ id: 'a', text: 'x', lane: 'idea' }).lane).toBe('doing')
})

test('a new to-do is an idea, trimmed, with no tag rather than an empty one', () => {
  expect(makeTodo({ text: '  Buy hub ', tag: 'Infra' }, 'n1')).toEqual({ id: 'n1', text: 'Buy hub', lane: 'idea', tag: 'Infra' })
  expect(makeTodo({ text: 'Loose', tag: '' }, 'n2')).toEqual({ id: 'n2', text: 'Loose', lane: 'idea' })
  expect(makeTodo({ text: '   ', tag: 'Infra' }, 'n3')).toBeNull()
})

// The summary is the command's output row, which every surface draws as
// markdown: a table for the limits, one short bullet per panel, and a first
// line that reads on after the "control-room:" prefix Claude Code adds.
test('the summary is markdown: alerts first, a limits table, one bullet per panel, to-dos by priority', () => {
  const text = summaryText({ payload: PAYLOAD, todos: TODOS, now: NOW, url: 'http://127.0.0.1:8322' })
  expect(text).toMatch(/^as of \d\d:\d\d · \*\*1 alert\*\*\n/)
  expect(text).toContain('- **Weekly · all models at 90%**')
  expect(text).toContain('| Limit | Used | Resets in |')
  expect(text).toContain('| Current session | 25% | 3h 01m |')
  expect(text).toContain('| Weekly · all models | 90% | 3d 4h |')
  expect(text).toContain('| Weekly · Fable | 8% | — |')
  expect(text).toContain('- **Credits** Cloud session credits $210.00 of $250.00 left, expires Nov 5')
  expect(text).toContain('- **Plan** Max, renews Oct 21')
  expect(text).toContain('- **Projects** 1 of 3 running: invoice')
  expect(text).toContain('- **Crons** 1 of 4 failing: nightly · 1 unknown')
  expect(text).toContain('**To-dos** 3 ideas · 1 doing · 1 done')
  expect(text).toContain('- **Doing** Write the release notes · Docs')
  expect(text.indexOf('- **P0** Retire the old NAS · Infra')).toBeLessThan(text.indexOf('- **P1** Offsite backup to B2 · Pi'))
  // A table must not touch the paragraph above it, or it renders as text.
  expect(text).toContain('\n\n| Limit |')
})

test('no alerts reads as such on the first line', () => {
  const p = clone(PAYLOAD) as any
  p.alerts = []
  expect(summaryText({ payload: p, todos: TODOS, now: NOW, url: 'u' })).toMatch(/^as of \d\d:\d\d · no alerts\n/)
})

test('the summary never prints a number for a panel it could not read', () => {
  const p = clone(PAYLOAD) as any
  p.usage = { data: null, status: 'unavailable', error: '/usage timed out', fetchedAt: null }
  const text = summaryText({ payload: p, todos: TODOS, now: NOW, url: 'http://127.0.0.1:8322' })
  expect(text).toMatch(/^- \*\*Limits\*\* unavailable — \/usage timed out$/m)
  expect(text).not.toContain('| Limit |')
})

test('a stale panel is marked with its age', () => {
  const p = clone(PAYLOAD) as any
  p.crons.status = 'stale'
  p.crons.fetchedAt = NOW - 12 * MIN
  expect(summaryText({ payload: p, todos: TODOS, now: NOW, url: 'u' })).toContain('- **Crons** 1 of 4 failing: nightly · 1 unknown *(stale · 12m ago)*')
})

test('a running state that could not be read is said, not counted as idle', () => {
  const p = clone(PAYLOAD) as any
  p.sessions.data.projects[1].running = null
  expect(summaryText({ payload: p, todos: TODOS, now: NOW, url: 'u' })).toContain('- **Projects** 3 total, running unknown')
})

test('an unreachable server says so, and shows the last reading only as the last reading', () => {
  const none = summaryText({ payload: null, todos: null, now: NOW, url: 'http://127.0.0.1:8322', error: 'timed out after 5s' })
  expect(none).toBe('**Control Room unreachable** at http://127.0.0.1:8322: timed out after 5s')
  const last = summaryText({ payload: PAYLOAD, todos: TODOS, now: NOW, url: 'http://127.0.0.1:8322', error: 'timed out after 5s', fetchedAt: NOW - 5 * MIN })
  expect(last).toMatch(/^\*\*Control Room unreachable\*\* at http:\/\/127\.0\.0\.1:8322: timed out after 5s\. Last reading, from 5m ago:\n/)
})

test('to-do text is escaped, so it cannot turn into markdown it never was', () => {
  const odd = { id: 'o', text: 'Fix *bold* and a|pipe in `code`', lane: 'idea', priority: 'P0' }
  expect(summaryText({ payload: PAYLOAD, todos: [odd], now: NOW, url: 'u' })).toContain('- **P0** Fix \\*bold\\* and a\\|pipe in \\`code\\`')
})

test('a long to-do is clipped in the summary, which is read on phones', () => {
  const long = { id: 'x', text: 'A'.repeat(200), lane: 'idea', tag: 'Pi', priority: 'P0' }
  const text = summaryText({ payload: PAYLOAD, todos: [long], now: NOW, url: 'u' })
  const line = text.split('\n').find(l => l.startsWith('- **P0**'))!
  expect(line.length).toBeLessThan(110)
  expect(line).toContain('…')
})
