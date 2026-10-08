import { expect, mock, test } from 'claude-code/testing'
import { NOW, PANE, PAYLOAD, TODOS, stubServer } from './fixtures.ts'

const SURFACES = ['terminal', 'desktop', 'mobile', 'vscode'] as const

// Every stub a session needs, registered before the test's first call on $.
function setup(on: any, opts: { surfaces?: string[], server?: Parameters<typeof stubServer>[1] } = {}) {
  const clock = mock.clock(on, { now: NOW })
  const seen = stubServer(on, opts.server)
  const opened: any[] = []
  const closed: any[] = []
  const submitted: any[] = []
  const saved = new Map<string, unknown>()
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
  on('session.surfaces', () => ({ value: opts.surfaces ?? ['terminal'] }))
  on('ui.open', ($: any, e: any) => { opened.push(e); return { value: { isPlaced: true } } })
  on('ui.close', ($: any, e: any) => { closed.push(e); return { value: undefined } })
  on('store.get', ($: any, e: any) => ({ value: saved.get(e.key) }))
  on('store.set', ($: any, e: any) => { saved.set(e.key, e.value); return { value: undefined } })
  on('prompt.submit', ($: any, e: any) => { submitted.push(e); return { text: e.text } })
  return { clock, seen, opened, closed, submitted, saved }
}

const start = ($: any, isInteractive = true) =>
  $.session.start({ surface: isInteractive ? 'terminal' : null, isInteractive, cwd: '/work' })

const run = ($: any, args = '', origin = { kind: 'composer' }) =>
  $.command.run({ command: 'control-room', args, origin, presentation: { isFullscreen: true, columns: 160 } })

// --- The command ---

test('/control-room summary prints the whole board as text', async ($, on) => {
  setup(on)
  await start($)
  const out = await run($, 'summary')
  expect(out.text).toContain('| Current session | 25% | 3h 01m |')
  expect(out.text).toContain('- **Credits** Cloud session credits $210.00 of $250.00 left')
  expect(out.text).toContain('- **P0** Retire the old NAS')
})

test('/control-room typed at the terminal opens the pane with the keyboard and prints nothing', async ($, on) => {
  const r = setup(on)
  await start($, false)
  const out = await run($)
  expect(r.opened).toEqual([expect.objectContaining({ id: 'control-room', title: 'Control Room', focus: true })])
  expect(out.text).toBeUndefined()
})

// Seen on 2026-10-08: the Claude iPad app draws no mod pane, only the row. A
// pane opened from the phone would sit on the mini's screen, polling for no one.
test('/control-room sent from a phone prints the summary and opens nothing', async ($, on) => {
  const r = setup(on, { surfaces: ['terminal', 'mobile'] })
  await start($, false)
  const out = await run($, '', { kind: 'bridge' })
  expect(r.opened).toEqual([])
  expect(out.text).toContain('| Current session | 25% | 3h 01m |')
})

test('/control-room with no surface that draws prints the summary and opens nothing', async ($, on) => {
  const r = setup(on, { surfaces: [] })
  await start($, false)
  const out = await run($, '', { kind: 'sdk' })
  expect(r.opened).toEqual([])
  expect(out.text).toContain('- **Projects** 1 of 3 running: invoice')
})

test('/control-room close closes the pane', async ($, on) => {
  const r = setup(on)
  await start($, false)
  await run($)
  await run($, 'close')
  expect(r.closed).toEqual([expect.objectContaining({ id: 'control-room' })])
})

test('an unknown argument explains the command instead of guessing', async ($, on) => {
  setup(on)
  await start($, false)
  const out = await run($, 'bogus')
  expect(out.text).toMatch(/Usage: \/control-room \[summary\|close\]/)
})

test('a server that never answers times out after 5 seconds and is reported as unreachable', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('http.fetch', async () => { await clock.sleep(60_000); return { value: { status: 200, ok: true, headers: {}, text: '{}' } } })
  await start($, false)
  const pending = run($, 'summary')
  await clock.advance(5_000)
  const out = await pending
  expect(out.text).toBe('**Control Room unreachable** at http://127.0.0.1:8322: timed out after 5s')
})

test('a refused connection is reported with the configured URL', { options: { dashboard_url: 'http://127.0.0.1:9999' } }, async ($, on) => {
  setup(on, { server: { dashboardDeny: 'connection refused' } })
  await start($, false)
  const out = await run($, 'summary')
  expect(out.text).toMatch(/^\*\*Control Room unreachable\*\* at http:\/\/127\.0\.0\.1:9999: .*connection refused/)
})

// --- Opening and polling ---

test('an interactive session opens the pane by itself, without taking the keyboard', async ($, on) => {
  const r = setup(on)
  await start($, true)
  expect(r.opened).toEqual([expect.objectContaining({ id: 'control-room' })])
  expect(r.opened[0].focus).toBeUndefined()
})

test('auto-open can be turned off, and a non-interactive session never opens it', { options: { auto_open: false } }, async ($, on) => {
  const r = setup(on)
  await start($, true)
  expect(r.opened).toEqual([])
})

test('a non-interactive session never opens the pane by itself', async ($, on) => {
  const r = setup(on)
  await start($, false)
  expect(r.opened).toEqual([])
})

test('an open pane re-reads the dashboard on the interval, and a closed one stops', { options: { refresh_seconds: 30 } }, async ($, on) => {
  const r = setup(on)
  await start($, false)
  await run($)
  const afterOpen = r.seen.dashboard
  await r.clock.advance(30_000)
  expect(r.seen.dashboard).toBe(afterOpen + 1)
  await run($, 'close')
  await r.clock.advance(90_000)
  expect(r.seen.dashboard).toBe(afterOpen + 1)
})

// --- The pane ---

test('the pane draws on every surface, and mobile gets no text fields', async ($, on) => {
  setup(on)
  await start($, false)
  await run($)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    for (const tab of ['tab-usage', 'tab-projects', 'tab-todos']) {
      await ui.press({ key: tab })
      await ui.drawn()
      if (surface === 'mobile') {
        expect(await ui.findAll({ type: 'Input' })).toEqual([])
        expect(await ui.findAll({ type: 'Select' })).toEqual([])
      }
    }
    await ui.unmount()
  }
})

test('the usage tab shows plan, credits, limits with heat, pace and resets', async ($, on) => {
  setup(on)
  await start($, false)
  await run($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'plan' }))?.text).toMatch(/Max · renews Oct 21/)
  expect((await ui.find({ key: 'credit-0' }))?.text).toMatch(/Cloud session credits.*\$210\.00 of \$250\.00 left/)
  expect((await ui.find({ key: 'credit-0-expiry' }))?.text).toMatch(/expires Nov 5/)
  expect((await ui.find({ key: 'usage-credits' }))?.text).toMatch(/none reported/)
  expect((await ui.find({ key: 'limit-0' }))?.text).toMatch(/Current session.*25%.*resets in 3h 01m.*under pace · projected 63% by reset/s)
  expect((await ui.find({ type: 'Text', text: '90%' }))?.props.color).toBe('error')
  expect((await ui.find({ key: 'limit-2' }))?.text).toMatch(/no reset time reported/)
  expect((await ui.find({ key: 'alert-0' }))?.text).toMatch(/Weekly · all models at 90%/)
  expect((await ui.find({ key: 'week-surface' }))?.text).toMatch(/Code 6\.7M.*Chat not measurable/)
})

test('the projects tab shows running state and crons, failing first', async ($, on) => {
  setup(on)
  await start($, false)
  await run($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-projects' })
  expect((await ui.find({ key: 'projects-summary' }))?.text).toMatch(/1 running · 3 total/)
  expect((await ui.find({ key: 'project-0' }))?.text).toMatch(/invoice.*running/)
  expect((await ui.find({ key: 'crons-summary' }))?.text).toMatch(/1 failing · 4 scheduled · 1 unknown/)
  expect((await ui.find({ key: 'cron-0' }))?.text).toMatch(/nightly.*Failed · 1/)
  expect((await ui.find({ key: 'cron-1' }))?.text).toMatch(/cloud-digest.*Unknown/)
})

test('an unreachable server keeps the last reading on screen, marked as such', async ($, on) => {
  const r = setup(on)
  await start($, false)
  await run($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'status' }))?.text).toMatch(/updated/)
  r.seen.down = true
  // Ten polls fail over these five minutes; none may replace the last reading.
  await r.clock.advance(5 * 60_000)
  expect((await ui.find({ key: 'plan' }))?.text).toMatch(/Max/)
  expect((await ui.find({ key: 'status' }))?.text).toMatch(/unreachable.*connection refused.*reading from 5m ago/)
})

// --- To-dos ---

const openTodos = async ($: any, surface: (typeof SURFACES)[number] = 'terminal') => {
  await start($, false)
  await run($)
  const ui = await $.ui.mount({ ...PANE, surface })
  await ui.press({ key: 'tab-todos' })
  return ui
}

test('to-dos group by stage with priority first, and by tag once asked, remembering the choice', async ($, on) => {
  const r = setup(on)
  const ui = await openTodos($)
  expect((await ui.find({ key: 'group-0' }))?.text).toMatch(/IDEA/)
  expect((await ui.find({ key: 'todo-t3' }))?.text).toMatch(/Retire the old NAS/)
  await ui.press({ key: 'group-tag' })
  expect(r.saved.get('groupBy')).toBe('tag')
  expect((await ui.find({ key: 'group-0' }))?.text).toMatch(/INFRA/)
})

test('cycling a priority writes the change through the server', async ($, on) => {
  const r = setup(on)
  const ui = await openTodos($)
  await ui.press({ key: 'todo-t1' })
  await ui.press({ key: 'prio-t1' })
  expect(r.seen.puts.length).toBe(1)
  expect(r.seen.puts[0].find((t: any) => t.id === 't1').priority).toBe('P2')
  expect(r.seen.headers[0]).toMatchObject({ 'Content-Type': 'application/json' })
})

test('moving a stage writes the next lane', async ($, on) => {
  const r = setup(on)
  const ui = await openTodos($)
  await ui.press({ key: 'todo-t4' })
  await ui.press({ key: 'stage-t4' })
  expect(r.seen.puts[0].find((t: any) => t.id === 't4').lane).toBe('done')
})

test('delete asks once more before it writes', async ($, on) => {
  const r = setup(on)
  const ui = await openTodos($)
  await ui.press({ key: 'todo-t5' })
  await ui.press({ key: 'delete-t5' })
  expect(r.seen.puts.length).toBe(0)
  await ui.press({ key: 'confirm-delete-t5' })
  expect(r.seen.puts[0].some((t: any) => t.id === 't5')).toBe(false)
  expect(r.seen.puts[0].length).toBe(TODOS.length - 1)
})

test('editing a to-do saves its new text', async ($, on) => {
  const r = setup(on)
  const ui = await openTodos($)
  await ui.press({ key: 'todo-t3' })
  await ui.press({ key: 'edit-t3' })
  await ui.input({ key: 'edit-input-t3', text: 'Retire the HP NAS' })
  expect(r.seen.puts[0].find((t: any) => t.id === 't3').text).toBe('Retire the HP NAS')
})

test('adding a to-do files it as an idea under the chosen tag', async ($, on) => {
  const r = setup(on)
  const ui = await openTodos($)
  await ui.select({ key: 'new-tag', value: 'Infra' })
  await ui.input({ key: 'new-todo', text: 'Buy the M3 hub' })
  const added = r.seen.puts[0].find((t: any) => t.text === 'Buy the M3 hub')
  expect(added).toMatchObject({ lane: 'idea', tag: 'Infra' })
  expect(typeof added.id).toBe('string')
})

test('work on it hands the to-do to Claude as the user\'s own request', async ($, on) => {
  const r = setup(on)
  const ui = await openTodos($)
  await ui.press({ key: 'todo-t3' })
  await ui.press({ key: 'work-t3' })
  expect(r.submitted.length).toBe(1)
  expect(r.submitted[0].text).toMatch(/Retire the old NAS/)
  // asUser shows on the prompt's origin: read bare, as the person's own words.
  expect(r.submitted[0].origin).toMatchObject({ kind: 'plugin', asUser: true })
})

test('a refused save says so and shows the server\'s list, not the unsaved one', async ($, on) => {
  const r = setup(on, { server: { putStatus: 400 } })
  const ui = await openTodos($)
  await ui.press({ key: 'todo-t1' })
  await ui.press({ key: 'prio-t1' })
  expect((await ui.find({ key: 'todos-error' }))?.text).toMatch(/Not saved.*400/)
  expect((await ui.find({ key: 'item-t1' }))?.text).toMatch(/P1/)
})

test('on mobile the to-dos still move, prioritise and hand off, with no typing needed', async ($, on) => {
  const r = setup(on)
  const ui = await openTodos($, 'mobile')
  await ui.press({ key: 'todo-t1' })
  await ui.press({ key: 'prio-t1' })
  expect(r.seen.puts.length).toBe(1)
  expect(await ui.find({ key: 'edit-t1' })).toBeUndefined()
  expect((await ui.find({ key: 'add-hint' }))?.text).toMatch(/Add to-dos from/)
})

test('a save starts from the server\'s current list, so an edit made on the web page survives', async ($, on) => {
  const r = setup(on)
  const ui = await openTodos($)
  // After the pane loaded, someone renames t3 on the web page.
  r.seen.setList(TODOS.map(t => (t.id === 't3' ? { ...t, text: 'Retire the NAS (edited on the web)' } : t)))
  await ui.press({ key: 'todo-t1' })
  await ui.press({ key: 'prio-t1' })
  const written = r.seen.puts[0]
  expect(written.find((t: any) => t.id === 't3').text).toBe('Retire the NAS (edited on the web)')
  expect(written.find((t: any) => t.id === 't1').priority).toBe('P2')
})

test('a change to an item deleted elsewhere writes nothing and says so', async ($, on) => {
  const r = setup(on)
  const ui = await openTodos($)
  await ui.press({ key: 'todo-t1' })
  r.seen.setList(TODOS.filter(t => t.id !== 't1'))
  await ui.press({ key: 'prio-t1' })
  expect(r.seen.puts.length).toBe(0)
  expect((await ui.find({ key: 'todos-error' }))?.text).toMatch(/changed elsewhere/)
  expect(await ui.find({ key: 'item-t1' })).toBeUndefined()
})

test('requests that never come back are capped, so polling cannot pile onto a dead server', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  let calls = 0
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('http.fetch', async () => { calls++; await clock.sleep(10 * 60_000); return { value: { status: 200, ok: true, headers: {}, text: '{}' } } })
  await start($, false)
  for (let i = 0; i < 2; i++) {
    const pending = run($, 'summary')
    await clock.advance(5_000)
    await pending
  }
  expect(calls).toBe(4)
  const out = await run($, 'summary')
  expect(calls).toBe(4)
  expect(out.text).toMatch(/4 requests are still unanswered/)
})

test('done items are hidden by default, counted, and shown on request', async ($, on) => {
  setup(on)
  const ui = await openTodos($)
  expect(await ui.find({ key: 'item-t2' })).toBeUndefined()
  expect((await ui.find({ key: 'toggle-done' }))?.text).toMatch(/Show done \(1\)/)
  await ui.press({ key: 'toggle-done' })
  expect((await ui.find({ key: 'item-t2' }))?.text).toMatch(/Mirror the disks/)
  expect((await ui.find({ key: 'toggle-done' }))?.text).toMatch(/Hide done/)
})

test('a long to-do is clipped so its chip and tag still fit the pane', async ($, on) => {
  const long = { id: 'long', text: 'L'.repeat(150), lane: 'idea', tag: 'Fantasy football', priority: 'P1' }
  setup(on, { server: { todos: [long] } })
  await start($, false)
  await run($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 40 } })
  await ui.press({ key: 'tab-todos' })
  const label = String((await ui.find({ key: 'todo-long' }))?.props.label ?? '')
  // chip (2) + gap (1) + label + gap (1) + tag must fit in 40 columns
  expect(2 + 1 + label.length + 1 + 'FANTASY FOOTBALL'.length).toBeLessThan(41)
  expect(label.endsWith('…')).toBe(true)
})
