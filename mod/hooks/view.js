// The pane's tree, built from element constructors and plain state: no `$`
// here, so this file can be imported by the hooks module (which owns every
// mods API call) and its output checked by tests on each surface.
//
// Keys: every element a test or a person needs to reach carries one. Text
// takes no `key`, so a keyed line is a Box around its Text.

import {
  heat, paceNote, formatTokens, formatUntil, formatAgo, formatDate, daysUntil, money, bar, sparkline,
  envelopeOf, staleNote, cronState, cronList, cronSummary, projectList, creditsView,
  groupTodos, tagChoices, nextLaneTitle, clip, PRIORITIES
} from './model.js'

export const NO_TAG = '__none__'
export const TABS = [
  { key: 'usage', label: 'Usage', hotkey: '1' },
  { key: 'projects', label: 'Projects', hotkey: '2' },
  { key: 'todos', label: 'To-dos', hotkey: '3' }
]

const colored = c => (c ? { color: c } : {})

const CHIP_COLOR = { P0: 'error', P1: undefined, P2: 'subtle', P3: 'inactive' }
const CRON_MARK = { failed: '✕', ok: '✓', never: '·', unknown: '?' }
const CRON_WORD = { ok: 'OK', never: 'Not yet run', unknown: 'Unknown' }

export function paneTree(el, st, act, ctx) {
  const { Box, Text, Button } = el
  const now = ctx.now
  const width = Math.max(24, Math.floor(ctx.columns || 48))
  const barWidth = Math.min(48, width)
  // The mobile app draws no text field yet, so nothing that needs typing goes there.
  const canType = ctx.surface !== 'mobile'
  const payload = st.payload
  const threshold = envelopeOf(payload, 'config').data?.warnThreshold ?? 85

  const text = (children, props = {}) => Text({ ...props, children: [children] })
  const dim = s => text(s, { dimColor: true })
  const row = (children, props = {}) => Box({ flexDirection: 'row', columnGap: 1, ...props, children })
  const spread = (left, right) => row([left, right], { justifyContent: 'space-between' })
  const keyed = (key, children) => Box({ key, flexDirection: 'column', children })
  const heading = (title, aside) => row([text(title.toUpperCase(), { bold: true }), ...(aside ? [dim(aside)] : [])])
  const gap = () => text(' ')
  const envNote = env => {
    if (env.status === 'unavailable') return [text(`unavailable — ${env.error ?? 'no reading yet'}`, { color: 'warning' })]
    const note = staleNote(env, now)
    return note ? [text(note, { color: 'warning' })] : []
  }

  // --- Frame: tabs, status, alerts ---

  const tabs = row([
    ...TABS.map(t => Button({
      key: `tab-${t.key}`, label: t.label, hotkey: t.hotkey, plain: true,
      dimColor: st.tab !== t.key, onPress: () => act.tab(t.key)
    })),
    Button({ key: 'refresh', label: 'Refresh', hotkey: 'r', plain: true, dimColor: true, onPress: () => act.refresh() })
  ], { columnGap: 2, flexWrap: 'wrap' })

  let status
  if (st.payloadError && payload) {
    status = text(`unreachable: ${st.payloadError} · showing the reading from ${formatAgo(now - st.fetchedAt)}`, { color: 'error' })
  } else if (st.payloadError) {
    status = text(`Control Room unreachable at ${ctx.url}: ${st.payloadError}`, { color: 'error' })
  } else if (!payload) {
    status = dim('loading…')
  } else {
    status = dim(`updated ${formatAgo(now - st.fetchedAt)}`)
  }

  const alerts = Array.isArray(payload?.alerts)
    ? payload.alerts.filter(a => a?.text).map((a, i) => keyed(`alert-${i}`, [text(`▲ ${a.text}`, { color: 'error', bold: true })]))
    : []

  // --- Usage ---

  function usageTab() {
    const out = []
    const planEnv = envelopeOf(payload, 'plan')
    const tier = planEnv.status !== 'unavailable' ? planEnv.data?.tier : null
    const renews = envelopeOf(payload, 'config').data?.plan?.nextRenewal
    if (tier) {
      const days = renews ? daysUntil(renews, now) : null
      const parts = [tier]
      if (renews) parts.push(`renews ${formatDate(renews)}`)
      if (days !== null && days >= 0) parts.push(`${days} day${days === 1 ? '' : 's'} left`)
      out.push(keyed('plan', [text(parts.join(' · '), { bold: true })]))
    } else {
      out.push(keyed('plan', [text(`Plan unavailable — ${planEnv.error ?? 'no tier reported'}`, { color: 'warning' })]))
    }

    out.push(gap(), heading('Credits'))
    const credits = creditsView(payload)
    if (credits.source === 'account') {
      out.push(...envNote(credits.env))
      if (credits.grants.length === 0) out.push(dim('No included or promotional credit on the account'))
      credits.grants.forEach((g, i) => {
        const usedPct = g.limit > 0 && Number.isFinite(g.used) ? Math.round((g.used / g.limit) * 100) : null
        const days = g.expiresAt ? daysUntil(g.expiresAt, now) : null
        out.push(keyed(`credit-${i}`, [
          spread(text(g.label, { bold: true }), text(`${money(g.remaining)} of ${money(g.limit)} left`)),
          text(bar(usedPct, barWidth), colored(heat(usedPct, threshold)))
        ]))
        const expiry = g.expiresAt
          ? `expires ${formatDate(g.expiresAt)}` + (days !== null && days >= 0 ? ` · ${days} day${days === 1 ? '' : 's'} left` : '')
          : 'no expiry reported'
        out.push(keyed(`credit-${i}-expiry`, [text(expiry, days !== null && days <= 7 ? { color: 'error' } : { dimColor: true })]))
      })
      out.push(keyed('usage-credits', [spread(
        text('Usage credits'),
        credits.usageBalance !== null ? text(money(credits.usageBalance)) : dim('none reported')
      )]))
    } else if (credits.source === 'hand') {
      out.push(...envNote(credits.env))
      out.push(keyed('credits-hand', [
        spread(text(`${money(credits.balance)} balance`, { bold: true }), text(`${money(credits.spent)} of ${money(credits.monthlyLimit)}`)),
        dim(`hand-entered · updated ${formatDate(credits.updatedAt)}` + (credits.promoExpiresOn ? ` · promo expires ${formatDate(credits.promoExpiresOn)}` : ''))
      ]))
    } else {
      out.push(text(`unavailable — ${credits.reason}`, { color: 'warning' }))
    }

    out.push(gap(), heading('Against limits now'))
    const usage = envelopeOf(payload, 'usage')
    const limits = Array.isArray(usage.data?.limits) ? usage.data.limits : []
    out.push(...envNote(usage))
    const history = usage.data?.history
    const historyBroken = history && history.ok === false ? (history.readError ?? history.writeError ?? 'read or write failed') : null
    limits.forEach((l, i) => {
      const color = heat(l.pct, threshold)
      const at = Date.parse(l.resetsAt)
      const pace = l.pace && !(l.pace.state === 'unknown-window' && !Number.isFinite(at)) ? paceNote(l.pace) : ''
      const line = [Number.isFinite(at) ? `resets in ${formatUntil(at - now)}` : 'no reset time reported', pace].filter(Boolean).join(' · ')
      const spark = sparkline(l.series, Math.min(40, width))
      out.push(keyed(`limit-${i}`, [
        spread(text(l.label, { bold: true }), text(`${l.pct}%`, { bold: true, ...colored(color) })),
        text(bar(l.pct, barWidth), colored(color)),
        dim(line),
        historyBroken
          ? text(`history unavailable · ${historyBroken}`, { color: 'error' })
          : (spark ? text(spark, colored(color ?? 'subtle')) : dim('not enough history yet'))
      ]))
    })

    const sessions = envelopeOf(payload, 'sessions')
    const data = sessions.data
    out.push(gap(), heading('This week'))
    out.push(...envNote(sessions))
    if (data) {
      const missing = (data.unavailableRoots?.length ?? 0) + (data.unreadablePaths?.length ?? 0)
      if (missing > 0) out.push(text(`incomplete · ${missing} source${missing === 1 ? '' : 's'} could not be read`, { color: 'warning' }))
      const tokens = s => (s.measurable === false ? `${s.name} not measurable` : `${s.name} ${formatTokens(s.tokens)}`)
      out.push(keyed('week-surface', [text(`Surface  ${(data.bySurface ?? []).map(tokens).join(' · ') || '—'}`, { wrap: 'wrap' })]))
      out.push(keyed('week-project', [text(`Project  ${(data.byProject ?? []).map(tokens).join(' · ') || '—'}`, { wrap: 'wrap' })]))
      out.push(keyed('week-model', [text(`Model    ${(data.byModel ?? []).map(tokens).join(' · ') || '—'}`, { wrap: 'wrap' })]))
    }

    const behaviours = usage.data?.factors?.['7d']?.behaviours
    if (Array.isArray(behaviours) && behaviours.length) {
      out.push(gap(), heading('Drivers · 7d', 'this machine only, approximate'))
      behaviours.forEach((b, i) => out.push(keyed(`driver-${i}`, [text(`${b.pct}% ${b.text}`, { wrap: 'wrap' })])))
    }

    const recent = Array.isArray(data?.recentSessions) ? data.recentSessions : []
    if (recent.length) {
      out.push(gap(), heading('Recent sessions'))
      recent.forEach((s, i) => out.push(keyed(`session-${i}`, [spread(
        text(clip(`${s.when ?? ''} ${s.title ?? ''}`.trim(), width - 8), { wrap: 'truncate-end' }),
        dim(formatTokens(s.tokens))
      )])))
    }
    return out
  }

  // --- Projects and crons ---

  function projectsTab() {
    const out = []
    const sessions = envelopeOf(payload, 'sessions')
    const { items, summary } = projectList(payload)
    out.push(keyed('projects-summary', [heading('Projects', sessions.status === 'unavailable' ? '—' : summary)]))
    out.push(...envNote(sessions))
    items.forEach((p, i) => {
      const state = p.running === true ? 'running' : p.running === false ? 'idle' : 'unknown'
      out.push(keyed(`project-${i}`, [
        spread(
          row([text(state === 'running' ? '●' : state === 'idle' ? '○' : '?', colored(state === 'running' ? 'success' : undefined)), text(p.name, { bold: true }), dim(String(p.tool ?? '').toUpperCase())]),
          text(state, state === 'running' ? { color: 'success' } : state === 'unknown' ? { color: 'warning' } : { dimColor: true })
        ),
        dim(`  ${p.detail ?? ''}`)
      ]))
    })

    out.push(gap())
    const cronsEnv = envelopeOf(payload, 'crons')
    const list = cronList(payload)
    out.push(keyed('crons-summary', [heading('Crons', cronsEnv.status === 'unavailable' && list.length === 0 ? '—' : cronSummary(list))]))
    out.push(...envNote(cronsEnv))
    list.forEach((c, i) => {
      const state = cronState(c)
      const word = state === 'failed' ? (c.last ?? 'Failed') : CRON_WORD[state]
      const next = Number.isFinite(c.nextRunAt) ? `next in ${formatUntil(c.nextRunAt - now)}` : 'no next run'
      const color = state === 'failed' ? 'error' : state === 'unknown' ? 'warning' : undefined
      out.push(keyed(`cron-${i}`, [
        spread(row([text(CRON_MARK[state], colored(color)), text(c.name, { bold: true })]), text(word, { ...colored(color), ...(color ? {} : { dimColor: state !== 'ok' }) })),
        dim(`  ${c.schedule ?? ''} · ${next}`)
      ]))
    })
    return out
  }

  // --- To-dos ---

  function todosTab() {
    const out = []
    const todos = st.todos
    const doneCount = Array.isArray(todos) ? todos.filter(t => t.lane === 'done').length : 0
    out.push(row([
      dim('Group by'),
      Button({ key: 'group-stage', label: 'Stage', plain: true, dimColor: st.groupBy !== 'stage', onPress: () => act.groupBy('stage') }),
      Button({ key: 'group-tag', label: 'Tag', plain: true, dimColor: st.groupBy !== 'tag', onPress: () => act.groupBy('tag') }),
      // A side pane is narrow: finished work is counted, and listed on request.
      ...(doneCount > 0
        ? [Button({ key: 'toggle-done', label: st.showDone ? 'Hide done' : `Show done (${doneCount})`, plain: true, dimColor: true, onPress: () => act.toggleDone() })]
        : [])
    ], { columnGap: 2, flexWrap: 'wrap' }))
    if (st.todosError) out.push(keyed('todos-error', [text(st.todosError, { color: 'error' })]))
    if (st.saving) out.push(dim('saving…'))
    if (!Array.isArray(todos)) {
      out.push(text(st.payloadError ? 'To-dos unavailable while the server is unreachable' : 'loading…', { color: st.payloadError ? 'warning' : undefined, dimColor: !st.payloadError }))
      return out
    }

    groupTodos(todos, st.groupBy).forEach((g, gi) => {
      const items = st.showDone ? g.items : g.items.filter(t => t.lane !== 'done')
      const hidden = g.items.length - items.length
      const aside = hidden === 0 ? String(items.length) : items.length ? `${items.length} · ${hidden} done hidden` : `${hidden} hidden`
      out.push(gap(), keyed(`group-${gi}`, [heading(g.title, aside)]))
      for (const t of items) {
        const done = t.lane === 'done'
        const chip = PRIORITIES.includes(t.priority) ? t.priority : '—'
        const tagText = st.groupBy === 'stage' && t.tag ? clip(String(t.tag).toUpperCase(), 16) : ''
        // chip (2) + gap + label [+ gap + tag] must fit, or the row wraps mid-word.
        const budget = Math.max(8, width - 3 - (tagText ? tagText.length + 1 : 0))
        const label = clip(`${done ? '✓ ' : t.lane === 'doing' ? '› ' : ''}${String(t.text ?? '')}`, budget)
        const children = [row([
          text(chip.padEnd(2), { bold: chip === 'P0' || chip === 'P1', ...(chip === '—' ? { dimColor: true } : colored(CHIP_COLOR[chip])) }),
          Button({ key: `todo-${t.id}`, label, plain: true, dimColor: done, onPress: () => act.select(t.id) }),
          ...(tagText ? [dim(tagText)] : [])
        ])]
        if (st.selected === t.id) children.push(actions(t))
        if (canType && st.editing === t.id) {
          children.push(el.Input({ key: `edit-input-${t.id}`, label: 'Edit', value: t.text, submitLabel: 'save', autoFocus: true, onSubmit: v => act.saveEdit(t.id, v) }))
        }
        out.push(Box({ key: `item-${t.id}`, flexDirection: 'column', children }))
      }
    })

    out.push(gap())
    if (canType) {
      const tags = tagChoices(todos)
      const value = st.newTag === NO_TAG || tags.includes(st.newTag) ? st.newTag : NO_TAG
      out.push(heading('Add an idea'))
      out.push(el.Select({
        key: 'new-tag', label: 'Tag', value,
        options: [...tags.map(t => ({ value: t, label: t })), { value: NO_TAG, label: 'No tag' }],
        onSelect: v => act.setNewTag(v)
      }))
      out.push(el.Input({ key: 'new-todo', label: 'Idea', placeholder: 'type and press Enter', value: '', submitLabel: 'add', onSubmit: v => act.add(v) }))
    } else {
      out.push(keyed('add-hint', [dim('Add to-dos from the terminal, the desktop app, or the web dashboard.')]))
    }
    return out
  }

  function actions(t) {
    const next = PRIORITIES.indexOf(t.priority)
    const prioLabel = next === PRIORITIES.length - 1 ? 'Clear priority' : `Priority → ${PRIORITIES[next + 1]}`
    const buttons = [
      Button({ key: `prio-${t.id}`, label: prioLabel, onPress: () => act.cyclePriority(t.id) }),
      Button({ key: `stage-${t.id}`, label: `→ ${nextLaneTitle(t)}`, onPress: () => act.advance(t.id) }),
      Button({ key: `work-${t.id}`, label: 'Work on it', onPress: () => act.workOn(t.id) }),
      ...(canType ? [Button({ key: `edit-${t.id}`, label: 'Edit', onPress: () => act.edit(t.id) })] : []),
      ...(st.confirmDelete === t.id
        ? [
            Button({ key: `confirm-delete-${t.id}`, label: 'Confirm delete', onPress: () => act.remove(t.id) }),
            Button({ key: `keep-${t.id}`, label: 'Keep', onPress: () => act.keep() })
          ]
        : [Button({ key: `delete-${t.id}`, label: 'Delete', onPress: () => act.askDelete(t.id) })])
    ]
    return Box({ key: `actions-${t.id}`, flexDirection: 'row', flexWrap: 'wrap', columnGap: 1, paddingLeft: 3, children: buttons })
  }

  const body = st.tab === 'projects' ? projectsTab() : st.tab === 'todos' ? todosTab() : usageTab()
  return Box({
    flexDirection: 'column',
    children: [tabs, keyed('status', [status]), ...alerts, gap(), ...body]
  })
}

