// The Control Room as a pane in Claude Code, and as text where no pane draws.
//
// This module owns every mods API call; model.js holds the rules and view.js
// the drawing, both pure. The server stays the single source: the mod only
// reads /api/dashboard and /api/todos and writes /api/todos, exactly as the
// web page does, so the two can never disagree about what is true.

import { summaryText, cyclePriority, advanceStage, makeTodo, updateItem, removeItem, workPrompt } from './model.js'
import { paneTree, NO_TAG } from './view.js'

const PANE = 'control-room'
const TITLE = 'Control Room'
const DEFAULT_URL = 'http://127.0.0.1:8322'
// $.http.fetch has no timeout of its own. On 2026-10-02 the server went deaf
// for four days and every request to it hung; without this the pane would
// have hung with it.
const FETCH_TIMEOUT_MS = 5_000
// Requests that timed out but never settled. Past this many, polling waits
// for one to come back rather than piling more onto a dead socket.
const MAX_UNSETTLED = 4

let options = {}
let paneOpen = false
let refreshing = null
let unsettled = 0

const st = {
  tab: 'usage',
  groupBy: 'stage',
  selected: null,
  confirmDelete: null,
  editing: null,
  newTag: NO_TAG,
  showDone: false,
  payload: null,
  fetchedAt: null,
  payloadError: null,
  todos: null,
  todosError: null,
  saving: false
}

// The manifest's userConfig default fills dashboard_url in on every load, so
// DEFAULT_URL only stands in when options are missing entirely. To point the
// mod elsewhere, change the setting (pluginConfigs), not this constant: a test
// copy that edited only the constant once wrote to the live board.
const baseUrl = () => String(options.dashboard_url || DEFAULT_URL).replace(/\/+$/, '')
const messageOf = err => String(err?.message ?? err ?? 'unknown error')
const newId = () =>
  globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`

// Races a request against a timer from $.clock, so a hung server reads as a
// timeout, and counts requests that are still outstanding after one.
async function timed($, request) {
  unsettled += 1
  const settled = request.finally(() => { unsettled -= 1 })
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = $.clock.after(FETCH_TIMEOUT_MS, () => reject(new Error(`timed out after ${FETCH_TIMEOUT_MS / 1000}s`)))
  })
  try {
    return await Promise.race([settled, timeout])
  } finally {
    timer?.cancel()
  }
}

async function getJson($, path) {
  const res = await timed($, $.http.fetch(baseUrl() + path))
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return JSON.parse(res.text)
}

// Reads both endpoints. A failure never replaces the last good reading: the
// figures stay, and the error says why they are old.
async function refresh($) {
  if (refreshing) return refreshing
  if (unsettled >= MAX_UNSETTLED) {
    st.payloadError = `${unsettled} requests are still unanswered; waiting for one to return`
    $.ui.invalidate('ui.render')
    return
  }
  refreshing = (async () => {
    const [dashboard, todos] = await Promise.allSettled([getJson($, '/api/dashboard'), getJson($, '/api/todos')])
    if (dashboard.status === 'fulfilled') {
      st.payload = dashboard.value
      st.fetchedAt = await $.clock.now()
      st.payloadError = null
    } else {
      st.payloadError = messageOf(dashboard.reason)
    }
    if (todos.status === 'fulfilled' && Array.isArray(todos.value)) {
      st.todos = todos.value
      if (!st.todos.some(t => t.id === st.selected)) st.selected = null
    }
    $.ui.invalidate('ui.render')
  })()
  try {
    await refreshing
  } finally {
    refreshing = null
  }
}

// Read-modify-write against the server's current list, so an edit made on
// the web page a moment ago is not overwritten by this pane's older copy.
// `change` returns null when its item is gone, and then nothing is written.
async function saveTodos($, change) {
  st.saving = true
  st.todosError = null
  $.ui.invalidate('ui.render')
  try {
    const current = await getJson($, '/api/todos')
    if (!Array.isArray(current)) throw new Error('the server sent no list')
    const next = change(current)
    if (next === null) {
      st.todos = current
      st.todosError = 'That to-do changed elsewhere; showing the current list'
      return
    }
    const res = await timed($, $.http.fetch(baseUrl() + '/api/todos', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next)
    }))
    if (!res.ok) {
      let detail = ''
      try { detail = JSON.parse(res.text)?.error ?? '' } catch { detail = '' }
      // Show what the server holds, not the change it refused.
      st.todos = current
      st.todosError = `Not saved: HTTP ${res.status}${detail ? ` · ${detail}` : ''}`
      return
    }
    const written = JSON.parse(res.text)
    st.todos = Array.isArray(written) ? written : next
  } catch (err) {
    st.todosError = `Not saved: ${messageOf(err)}`
  } finally {
    st.saving = false
    $.ui.invalidate('ui.render')
  }
}

async function summary($) {
  return summaryText({
    payload: st.payload,
    todos: st.todos,
    now: await $.clock.now(),
    url: baseUrl(),
    error: st.payloadError,
    fetchedAt: st.fetchedAt
  })
}

const USAGE = 'Usage: /control-room [summary|close]. With no argument it opens the pane; summary prints the board as text; close closes the pane.'

export function register(on, opts) {
  options = opts ?? {}

  on('session.start', async ($, e, next) => {
    const saved = await $.store.get('groupBy')
    if (saved === 'tag' || saved === 'stage') st.groupBy = saved
    const every = Math.min(600, Math.max(10, Number(options.refresh_seconds) || 30)) * 1000
    $.clock.every(every, () => {
      if (paneOpen) void refresh($)
    })
    // Opened without being asked, so Claude Code places it only in a wide
    // terminal; it never takes the keyboard from the prompt.
    if (options.auto_open !== false && e.isInteractive && e.surface) {
      await $.ui.open({ id: PANE, title: TITLE })
      paneOpen = true
      void refresh($)
    }
    await $.command.register({
      name: 'control-room',
      description: 'Open the Control Room pane, or print the board as text with summary',
      argumentHint: '[summary|close]',
      immediate: true
    })
    return next(e)
  })

  on('command.run', { command: 'control-room' }, async ($, e) => {
    const arg = String(e.args ?? '').trim().toLowerCase()
    if (arg === 'close') {
      await $.ui.close({ id: PANE })
      paneOpen = false
      return {}
    }
    if (arg === 'summary') {
      await refresh($)
      return { text: await summary($) }
    }
    if (arg !== '') return { text: USAGE }
    // Text where no pane can be seen: nothing draws (claude -p, the Agent SDK),
    // or the command came over Remote Control. The Claude iPad app was checked
    // on 2026-10-08 and draws the command's row but no mod pane, and a pane
    // opened from there would only sit on the mini's screen, polling.
    if (e.origin?.kind === 'bridge' || (await $.session.surfaces()).length === 0) {
      await refresh($)
      return { text: await summary($) }
    }
    await $.ui.open({ id: PANE, title: TITLE, focus: true })
    paneOpen = true
    await refresh($)
    return {}
  })

  // An observer only: whatever happens here, the close goes ahead.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) paneOpen = false
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const el = $.ui.resolve(e)
    const now = await $.clock.now()
    const redraw = () => $.ui.invalidate('ui.render')
    const act = {
      tab: name => { st.tab = name; redraw() },
      refresh: () => refresh($),
      groupBy: g => {
        st.groupBy = g
        redraw()
        return $.store.set('groupBy', g)
      },
      select: id => {
        st.selected = st.selected === id ? null : id
        st.confirmDelete = null
        st.editing = null
        redraw()
      },
      cyclePriority: id => saveTodos($, list => updateItem(list, id, cyclePriority)),
      advance: id => saveTodos($, list => updateItem(list, id, advanceStage)),
      workOn: id => {
        const todo = (st.todos ?? []).find(t => t.id === id)
        if (!todo) return
        // Not awaited: it resolves only when the turn starts, which waits for
        // Claude to be idle.
        void $.prompt.submit({ text: workPrompt(todo), asUser: true })
      },
      askDelete: id => { st.confirmDelete = id; redraw() },
      keep: () => { st.confirmDelete = null; redraw() },
      remove: id => {
        st.confirmDelete = null
        st.selected = null
        return saveTodos($, list => removeItem(list, id))
      },
      edit: id => { st.editing = id; redraw() },
      saveEdit: (id, value) => {
        st.editing = null
        const body = String(value ?? '').trim()
        if (!body) { redraw(); return undefined }
        return saveTodos($, list => updateItem(list, id, t => ({ ...t, text: body })))
      },
      setNewTag: value => { st.newTag = value; redraw() },
      toggleDone: () => { st.showDone = !st.showDone; redraw() },
      add: value => {
        const todo = makeTodo({ text: value, tag: st.newTag === NO_TAG ? '' : st.newTag }, newId())
        if (!todo) return undefined
        return saveTodos($, list => [...list, todo])
      }
    }
    return paneTree(el, st, act, { now, columns: e.props.bodyColumns, surface: e.surface, url: baseUrl() })
  })
}
