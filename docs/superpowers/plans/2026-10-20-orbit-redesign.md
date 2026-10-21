# Control Room redesign (Orbit, round 4): phased build plan

**Status:** written 2026-10-20 by Pepper. Jeff approved it the same day, and at 20:45 ET
answered its seven decisions: "Go with her picks", so each one is (a). Phase 0 was built and
staged that night. When a phase starts, it gets a task-by-task plan of its own, in the
format the other plans in this folder use.

**Goal:** build the round 4 "Orbit" design that Jeff approved on 2026-10-20 ("Add the health
strip and start"). The result is one page with an Overview tab and a Board tab under a navy
header that carries a health strip. The Overview's panels follow his order, and every number
on the page is real.

**The spec:** the round 4 page of Jeff's design canvas (private), file
`project/OrbitV2.dc.html`. The iPhone version on the same page (`OrbitV2Phone.dc.html`) is
the same component at 390 px wide. It is one interactive component that holds both tabs, with a
Mon 10-19 snapshot of real data typed into it. We build from its markup and its data model,
not by porting its code, and none of its sample data enters this repo.

## The phases at a glance

| Phase | What ships | Effort | What Jeff sees afterwards | Waits on |
|---|---|---|---|---|
| 0 | Transcript reading that can't overflow | S | Nothing new. The token totals stay complete through Jarvis's long weeks | Built and staged 10-20; Jeff's C&P, then a restart |
| 1 | The new page, beside today's: header and tabs, Usage limits, Next 24 hours, Burn, the week's heat map, and the whole Board tab | L | `/orbit.html` on the iPad and iPhone, with real limits, burn and heat map, and the restyled board with add, edit and move | — |
| 2 | The health strip | M | Jobs and five service chips under the title. Tap one for its details | Jarvis (a narrow job-status mode), Vision, Ultron |
| 3 | The agent views | M | The agent work map, Today agent by agent and Latest runs, all from real runs | — |
| 4 | Waiting on you | M | The count, the three tiles and the cards at the top of the Overview, To push, and "You" events on Next 24 hours | Jarvis filling the new fields, Ultron |
| 5 | The flip | S | `/` is the new page. The old one stays at `/classic.html` for a week, then goes | Jeff's word |
| 6 | The OpenTelemetry cross-check (the approved usage-by-agent item) | M | Nothing, unless the two token counts disagree | Ultron vets the settings, Vision sets them |

Effort is rough. S is about one working session for Pepper plus review, M about two, and L
three or four. Review rounds, Jeff's C&P and the restarts set the calendar pace.

If review runs long, Phase 1 can ship in two steps: 1a (header, tabs, Usage limits and the
Board tab), then 1b (Next 24 hours, Burn and the heat map).

## Decisions for Jeff

**Decided 2026-10-20, 20:45 ET.** Jeff's answer was "Go with her picks", so each decision
below is its option (a), the one marked Chosen.

1. **Which token figure the new panels show.** The mock's figures were counted with cache
   reads, and before the 10-20 fix that counts each request once. Its Sunday 10-18 reads
   1.72B. Counted the way the rest of the dashboard counts (new tokens, each request once),
   that Sunday was 19.5M. With cache reads it was 662M.
   - (a) New tokens, the same figure as everywhere else on the dashboard and in the mod.
     Burn, the heat map, the node sizes and the per-run figures will read about 80 to 90
     times smaller than the mock on a busy day. **Chosen.**
   - (b) New tokens plus cache reads, which reads about 2.5 times smaller than the mock.
     But cache reads track how long a conversation has run, not how much work was done, and
     "tokens" would mean two different things on one page.
2. **Card titles.** A board item is one text field today. On 10-20 the 82 open items ran
   from 20 to 1,073 characters (median 252), and the first sentence fit in 72 characters for
   only 19 of them.
   - (a) An optional `title` that Jarvis writes on every new item and backfills on the open
     ones, with the first sentence as a fallback. **Chosen.**
   - (b) The fallback only, cut to 72 characters.
3. **How an item says it is waiting on Jeff.**
   - (a) One optional `ask` field: what he does, why it matters, decide or do, and an
     optional time of day. Due soon is worked out from the item's `due` date, so an item
     moves into it on its own as the day nears. **Chosen.**
   - (b) An explicit group field that Jarvis keeps current.
4. **How the health strip knows Jarvis is up.** The services item on the board has been
   waiting on this.
   - (a) `claude agents --json`, which the dashboard already reads every 30 s, lists a
     session named Jarvis (jarvis-start runs `claude -n Jarvis`) with its process. Listed
     means up. It needs no new file and no change to Jarvis, and it stays green while he is
     idle overnight. It can't tell whether Discord is connected. **Chosen.**
   - (b) A file Jarvis touches every turn (the earlier pick). It needs a hook in his
     settings, and it reads as stale whenever he is idle.
5. **Where the agents' names, avatars and the tag-to-owner map live.**
   - (a) In `server/config.json`, which is gitignored, with the avatars served from Jarvis's
     avatar folder. The public repo keeps a neutral example. **Chosen**, per "real info in
     the dashboard, anonymized in the repo".
   - (b) Committed: 256 px avatars under `web/public/avatars/`, and the map in code. The
     avatars are original art, so licensing isn't the concern. Anonymity is.
6. **Deleting an item.** The design has no delete, so today's × goes.
   - (a) No delete, as designed. A dead item moves to Done, which is already the board's
     rule. **Chosen.**
   - (b) Keep a delete behind a confirmation.
7. **Where the agent views get their numbers first.** The approved OpenTelemetry item
   planned the Agents panel on OpenTelemetry, after Ultron and Vision.
   - (a) From the transcripts and the subagent meta files now (Phase 3), with OpenTelemetry
     added later as an independent cross-check (Phase 6). Nothing waits on three other
     agents, and the views get a week of history on day one. **Chosen.**
   - (b) Wait for OpenTelemetry, which only counts sessions started after it is set up.

The plan also sets these without asking. P0 and "no priority" stay, since the server
accepts both and Ultron's criticals were P0. The Area list comes from the tags in use, so an
item tagged Test or Docs keeps its tag when it is edited. There is no search, per Jeff on
10-20.

## Ground rules

- A value is real, or it says it is unknown. A zero or a guess never stands in for a
  missing source.
- `server/` stays free of dependencies, and the web page adds no runtime dependency. Geist
  and Geist Mono are served from the repo under the SIL Open Font License, with the licence
  file beside them. They are not loaded from Google at runtime.
- The repo is public. No board content, real job labels, repo names, agents' task lines or
  personal paths go into code, fixtures, tests or screenshots. Real names live in
  `server/config.json`.
- Never aim a test write at :8322. Tests and browser checks use a scratch server with an
  invented board.
- `npm run build` in `web/` is a live deploy, because the service serves `web/dist` from
  disk. Every build must work against the server that is running, which is why Phase 1
  ships beside the current page.
- No new `claude -p` is planned. Any that appears passes `--strict-mcp-config` and
  `--permission-mode manual`.
- Baseline: 421 server tests pass, in local time and in `TZ=Asia/Tokyo` (checked 10-20). The
  mod's test kit has 52 tests (per `mod/README.md`; not run for this plan).

## Panel by panel: where each number comes from

| Panel | Source today | Missing | How it gets filled | Phase |
|---|---|---|---|---|
| Title, date, tabs | — | The open count on the Board tab | `/api/todos`, which the page reads once for both tabs | 1 |
| "Updated N s ago" | `serverTime` in `/api/dashboard` | — | Now minus `serverTime`. Amber past 3 minutes, red when the last poll failed (today's connection bar moves here) | 1 |
| Alerts | The alert bar | A place in the design | A strip under the header while `showAlertBanner` is on. Dropping it would hide alerts the page shows today | 1 |
| Health strip | In part: `crons` judges scheduled jobs from `launchctl list` | Jarvis's verdicts, the always-on services, the Pi, Jarvis | Jarvis's job-status check, the agents list, the Pi watch's state | 2 |
| Waiting on you | Nothing | Which items wait on Jeff, what he does and why, and staged commits | `ask` on board items, and Jarvis's `git-read` on each repo | 4 |
| Usage limits: rings, three columns, countdown | `/usage` every 5 minutes | The last window's final percent (the faint arc) | The usage history (30 days): the last reading before each limit's latest reset | 1 |
| Credits and plan chips | The usage cache in `~/.claude.json`, `claude auth status`, config | — | As today | 1 |
| Agent work map, Today agent by agent, Latest runs | Tokens by session and folder only | Who ran, when, on what, and with how many tokens | Subagent `.meta.json` files, `agentSetting` on routine runs and the Jarvis session's name, read along with the transcripts already parsed | 3 |
| Next 24 hours | Next runs from the plists, resets from `/usage` | Friendly names, and Jeff's own items | A label-to-name map in config, then `ask.time` together with `due` | 1, 4 |
| Burn | Weekly totals by model | Hour by hour, by model | The same per-request records, grouped by clock hour | 1 |
| This week, hour by hour | Nothing | 7 days by 24 hours | The same records | 1 |
| Board tab | `/api/todos` | Titles, owners, and when an item was done | `title`, the owner from the tag, and `doneAt` | 1 |

The approved design drops these panels from today's page: the pace tick and projection, the
sparklines, the usage drivers, By surface, By project, By model, Recent sessions and the
Projects column. The server keeps computing what the alerts and the mod still use: pace
feeds the projection alert, and the mod shows all of it.

## Phase 0: transcript reading that can't overflow (S)

Measured 10-20: each minute, the sessions collector reads every transcript changed in the
last 7 days into one string. That was 174 files with usage, in about 3.8 s and about 700 MB
in a fresh process, and the service itself held about 690 MB. Node can't hold a string
longer than about 512 MiB. Jarvis's current transcript was 145 MB after about 31 hours, and
another long session's reached 159 MB. At that rate it passes the limit before Sunday's
restart. The read then fails and the file is listed as unreadable. The page does say that
the totals are incomplete, but every total is then missing Jarvis's own session.

- Read each transcript line by line from a stream, never as one string.
- Remember each file's parsed requests by size, modification time and inode, so an
  unchanged file isn't parsed again. The step that counts a copied request once runs across the remembered
  results each time.
- Tests: the streaming parser returns the same requests as today's on the existing
  fixtures. An unchanged file isn't read again, and a grown one is. Before and after are
  measured side by side on the real transcripts, totals only, as on 10-20.
- It ships alone, with Jeff's C&P and a restart, and needs no web build. Phase 3 reads the
  same files, so this work also prepares for it.

## Phase 1: the new page, beside today's (L)

Server:

- Hourly series from the per-request records: the last 24 clock hours by model family, the
  last 60 minutes, and the last 7 days by 24 hours with each day's total and the week's peak
  hour. The families are Opus, Fable, Sonnet and Haiku, and Other takes any other model id,
  Mythos included. Hours are local time, as the mini keeps it. The figures are new tokens,
  unless decision 1 goes the other way.
- `lastWindowPct` for each limit, from the history store. It is left out when the history
  doesn't reach back that far.
- Board fields (see "Board API changes"): the checks for `title`, `owner` and `doneAt`. The
  `ask` check also lands in this phase, so Phase 4 needs no server change for it.
- The roster block in config (decision 5), and a route, `/avatars/<key>.png`, that serves
  files from the folder config names. It takes a strict name pattern, sends a day's cache
  header, and reaches no other path.
- `/api/dashboard` sends the page only the config fields it shows: the thresholds, the plan,
  the credits and the roster's display fields. The new paths and commands in config never
  reach the page, and this allowlist ships before any of them goes into `config.json`.

Web:

- A second entry, `orbit.html`, built beside `index.html` with Vite's multi-page build. The
  classic page is untouched. `/orbit.html` works against the server that is running, and a
  panel whose data that server doesn't send yet says so.
- The design's tokens: navy, paper, the orange accent and Geist. Tap targets are at least
  44 px, and the animations respect Reduce Motion.
- The header and tabs. The tab is kept in the address (`#overview`, `#board` and
  `#board/<id>`), so Back works and "Open on the board" can link straight to an item.
- Usage limits: the rings, the three columns and the chips.
- Next 24 hours: the next run of each calendar job within 24 hours, plus any limit reset.
  Jobs that run every few minutes are left out.
- Burn and the heat map. The heat map's shades scale to the week's busiest hour, because the
  mock's fixed steps assumed figures that included cache reads.
- The Board tab, as designed:
  - The summary band: the open count, the priority bar, the doing and done counts, and owner
    chips that filter the board.
  - The controls: the priority filter, sort by priority or due date, and the New item form.
  - The lanes: Doing; Ideas, the top 8 and then "Show all"; and Done, the 8 finished most
    recently, then "N older done items are not shown".
  - The cards: an avatar, a priority chip and a due chip. An opened card shows the detail,
    priority chips, the due date with Clear, Edit text and the move buttons. Due chips keep
    today's rules.
- Saving keeps today's protections, moved into a `useBoard` hook. Every PUT carries
  `If-Match`, saves go one at a time, and a 409 or 428 re-reads the board and says the
  change wasn't saved. The board is re-read when the tab comes back into view, and every
  minute while it is visible. One thing is new: after a save, the page takes the list the
  server returns, because the server may have added `doneAt`.
- Owner: the agent whose area the item's tag is, from config, unless the item names an
  `owner`. A tag with no agent shows a neutral initial.

Jeff sees `/orbit.html` with his real limits, burn and heat map, and the restyled board.
Card titles fall back to first sentences until Jarvis fills in `title`. The classic page is
unchanged at `/`.

## Phase 2: the health strip (M)

The Jobs chip covers the 15 scheduled LaunchAgents:

- The verdict comes from Jarvis's job-status check (`jarvis/status.py`, `jobs()`): state and
  last exit code from `launchctl print`, the log's age against what the job's schedule
  allows, and "not loaded". The dashboard calls it rather than copying it, so the morning
  brief and the dashboard can never disagree about a job.
- Today `job-status --json` also reads the board, checks four URLs (two of them over the
  internet), runs the LinkedIn status script (a Keychain read and a call to LinkedIn) and
  asks tmux. The dashboard must not set those off every minute. It waits on a narrow mode
  from Jarvis, such as `job-status --json --only jobs`, that runs `jobs()` alone. The
  dashboard calls it every 60 s, with a timeout, from a path in config. Until that mode
  exists, the chip says "not set up".
- The schedules and next runs stay with the dashboard's own plist reading, which Next 24
  hours already uses. The `crons` block keeps its shape for the mod and the alerts, but its
  OK or failed comes from job-status when that answers, so there is one verdict everywhere.
- The chip reads "all OK" or "N failed". A job that hasn't run yet says so, and doesn't
  count as failed. The details list each job with its schedule and state.

The service chips come from the same call, and each always-on job is judged by whether it
is running:

- Control Room: this server. Its line shows when it started, and its last watchdog restart
  if there was one.
- Tunnel and Review page: their KeepAlive jobs.
- Pi: the state the Pi watch (Vision's, every 5 minutes) last wrote, up or down. It counts
  only while the watch's own log is fresh, and otherwise reads "unknown". Reading that file
  as a fixed format needs Vision's OK.
- Jarvis: see decision 4.

Alerts: a failed job or a down service can push through the existing notifier. The push
carries a count ("1 job failed"), never a label, as the push-alerts plan requires. Pepper's
suggestion is to build this with the phase.

## Phase 3: the agent views (M)

Checked on the mini on 10-20:

- Each subagent run is `<session>/subagents/agent-*.jsonl`, with a `.meta.json` beside it
  holding `agentType` (such as `pepper`), the brief's one-line `description` and `finished`.
  In the last 7 days there were 104 runs, all one level deep, and none without its
  transcript.
- A routine run started with `--agent` (Ultron's sweep and audit, Shuri's scout) is a
  top-level session whose lines carry `agentSetting`.
- Jarvis's own session carries `agent-name` and `custom-title` lines that read Jarvis.
- The dashboard's own `/usage` polls carry no usage, and never count.

The rules:

- A run belongs to its `agentType` or `agentSetting` when that agent is on the roster. Any
  other subagent (general-purpose, Explore, a fork) under a Jarvis session counts as "Jarvis
  helpers". Anything else is "Other" and stays off the map.
- A run's time is its first request. Its tokens are the sum of its requests, each request
  counted once. Its task is the meta file's description, or for a routine, the routine's
  name from config.
- The work map: each node's area follows its tokens over 7 days, with a floor so an idle
  agent still shows. The badge is runs today, and a pulse means a request in the last hour.
  Jarvis's badge counts every run today.
- Today agent by agent: a lane for each agent, plus Jarvis helpers and Scheduled. Each run
  is a dot at its start time, sized by its tokens, with a line at "now". Scheduled marks the
  calendar jobs whose time today has passed: solid when job-status shows a run since, and
  hollow when it doesn't. Before Phase 2 ships, the marks show the schedule only.
- Latest runs: the 10 most recent.
- `/api/dashboard` gains an `agents` block, built from the parse the collector already does.
  It holds each agent's 7-day tokens, runs today and last activity, and the runs of the last
  7 days (time, agent, task and tokens).

The tests use invented sessions, meta files and agent names. This phase closes the board's
Agents panel item.

**Built 2026-10-21, where it differs from the above:** the block is `sessions.agentWork`,
since `agents` already names the live-sessions panel, and today's run counts are worked out
on the page in the viewer's day. A `--agent` run takes the name of its agent's own job that
fell due in the 15 minutes before it started, and is otherwise a "Direct run". The morning
brief and the weekly digest run with no `--agent` and no name, so they stay "Other"; NEXT.md
§9 has the config hook that would change that. The same change raised the board's PUT cap
and closed three of Ultron's 2026-10-21 findings (NEXT.md §9).

## Phase 4: Waiting on you (M)

- The count, and three tiles. Tapping a tile shows only its cards.
  - Due soon: open items with an `ask` whose `due` is within 7 days, or past. The card's
    chip shows the weekday, plus `ask.time` when there is one. The card is dark when the
    item is due today or tomorrow, or overdue.
  - Decide or do: the other open items with an `ask`. The chip says Decide or Do.
  - To push: each repo under `~/Projects` with staged changes, or with commits its upstream
    doesn't have. Every 5 minutes the server runs Jarvis's hardened
    `bin/git-read <repo> status --porcelain=v2 --branch` (its own git, with no hooks and no
    global config), and keeps only counts and the branch name. A branch with no upstream
    doesn't count, so a build branch that is deliberately unpushed stays quiet. The card's
    owner comes from a repo-to-agent map in config. On 10-20 this tile would have read 2.
- A card opens in place. It shows What you do (`ask.what`), Why it matters (`ask.why`), the
  owner's avatar, the priority and the area, and "Open on the board", which opens the Board
  tab on that item.
- Next 24 hours gains "You: <title>" for items whose `due` and `ask.time` fall within the
  next 24 hours.
- Jarvis fills in `ask` as he writes the board (his instructions change through Jarvis and
  Jeff). Until he does, the panel says that nothing is waiting.

## Phase 5: the flip (S)

When Jeff says so, the new page becomes `index.html` and the old one `classic.html`. A week
later, the old page, its components and its CSS are deleted, and README and NEXT.md are
rewritten for the new page.

## Phase 6: the OpenTelemetry cross-check (M, later)

This is the approved usage-by-agent item, in its agreed order: Ultron vets the settings,
Vision sets them, Pepper builds the receiver, and Jarvis tags the routines. Claude Code's
token metrics carry agent names when `OTEL_LOG_TOOL_DETAILS=1` is set (its changelog says
so; not yet tried here).

By then, Phase 3 already shows usage by agent from the transcripts, so OpenTelemetry becomes
a second, independent count. The receiver takes metrics only, as OTLP over HTTP with JSON,
with a size cap, on its own loopback port that Tailscale Serve doesn't forward. It compares
its per-agent totals with the transcripts' totals and flags any gap. That check would have
caught 10-20's 3x over-count on the day it started. The item's other half, plan percentages
from the status line's `rate_limits`, gets weighed against the `/usage` poll at that point.

## Board API changes

The list stays a bare JSON array. GET and PUT, the `ETag` and `If-Match` check, the 409 and
428 answers, the history copies and `restore-todos.mjs` don't change.

The new fields are optional. Every PUT checks them, and a bad one gets a 400 that names the
item and the field, with nothing written. They are stored and returned as sent.

| Field | Type | Rules |
|---|---|---|
| `title` | string | Up to 120 characters. Absent or `""` means none |
| `ask` | object | `what` (up to 500 characters), `why` (up to 300), `kind` (`decide` or `do`), and an optional `time` (`HH:MM`, 24-hour, local). Absent or `null` means the item doesn't wait on Jeff |
| `owner` | string | An agent key, which overrides the tag's owner |
| `doneAt` | string | Set by the server, as below. A writer may send one (ISO 8601) |

`doneAt`: on each write, the server compares the new board with the one it replaces, which
it already reads for the history copy.

- An item that enters Done without a `doneAt` gets the write's time.
- An item that leaves Done loses it.
- An item still in Done that arrives without one gets its old value back, so a writer that
  rebuilds its items can't wipe it.

Items finished before this change have no `doneAt`, and the Done lane lists them after the
dated ones.

Who has to change what:

- The server: the checks and `doneAt`, in `server/todos.mjs`, and the README's table of
  fields.
- The page: the new Board tab, and taking the server's list after a save.
- The mod: nothing. It spreads each item on every change, so new fields survive, and it
  already takes the server's answer. One new test proves a round trip keeps `title`, `ask`
  and `doneAt`. Editing an item's text in the pane leaves `title` alone. Later, if wanted,
  the pane and the summary can show `title`.
- Jarvis: his write path doesn't change (id, text, lane and tag are required, and every other
  field is kept). He writes `title` and `ask`, backfills `title` on the open items in one
  pass, and may read both in the morning brief. `status.py` reads text, tag, lane, priority
  and due today.

The tests cover:

- each field's round trip;
- a 400 for a bad `kind`, a bad `time` and an overlong `title`;
- `doneAt` being set, kept, restored and dropped;
- the `ETag` moving when the server adds `doneAt`;
- a stale `If-Match` still getting 409, and a browser PUT with no `If-Match` still getting
  428;
- a plain curl PUT still writing;
- a restore following the `doneAt` rules.

Every new test is mutation-checked (revert the behaviour, and watch the test fail), and runs
in both time zones.

## Card titles

- `text` stays the whole item. The morning brief, the mod, `/control-room summary` and
  Shuri's scout keep working unchanged.
- `title` is a short label: 60 characters is the aim, 120 the limit.
- When there is no `title`, the card shows the first sentence of `text`, cut at a word
  boundary to 72 characters, with an ellipsis.
- The opened card's detail is `text`. When `text` starts with the title, the repeat is left
  off the screen, but not off the disk.
- Edit text: Title edits `title`, Detail edits `text` and Area edits `tag`.
- An item added with the form gets `title` from the title, and `text` from the title
  followed by the detail (or from the title alone).

## Security

What doesn't change: the server binds `127.0.0.1`, the tailnet reaches it only through
Tailscale Serve, and writes keep their guards (JSON only, the same origin, and 256 KB at
most).

The new reads are all local and read-only:

- job-status, in its narrow mode: `launchctl print` for each job, the plists, the logs' ages
  and the routines' heartbeat files. Its output already passes through Jarvis's secret
  redaction.
- `git-read` on each repo. Only counts and branch names leave the collector, never paths or
  diffs.
- The subagent meta files, and two kinds of line in the transcripts the collector already
  reads.
- The Pi watch's state file, and the avatar folder.

New on the tailnet: job names and states, repo names and branches, the agents' task lines
and the `ask` text. All of it is already on the mini, and anyone who can open the dashboard
will be able to see it.

Kept off: the new paths and commands in config (the page gets an allowlist), calls to a
third-party font service (Geist is served locally), and the OpenTelemetry port (its own
loopback port, which isn't forwarded).

For Ultron to vet before Phases 2 and 4 ship:

1. The dashboard's LaunchAgent running job-status and `git-read` from paths in config: what
   that grants, and whether the narrow mode really stays away from the Keychain, LinkedIn
   and the network.
2. The extra data on the tailnet, against the tailnet's ACLs and devices. His console
   checklist already covers both.
3. How the avatar route handles paths.
4. Before Phase 6, the OpenTelemetry settings (`OTEL_LOG_TOOL_DETAILS=1` exports agent,
   skill and MCP server names) and the receiver's port.
5. Optional: installing Playwright's WebKit on the mini, so that Safari can be tested there
   too.

## Verification

- Server: Node's built-in test runner, run in local time and in `TZ=Asia/Tokyo`. Every new
  test is mutation-checked, and every fixture is invented.
- Web logic: the web package has no test runner today. The pure parts (the title fallback,
  the Waiting on you grouping, the heat map's shades, timeline placement and card states) go
  in `web/src/lib/`, tested with `node --test`, which needs no install.
- The page: a scratch server on another port, made of the request handler, the static
  handler and a temporary board of invented items, fed a canned dashboard payload. It is
  driven with playwright-cli in Chromium at 390, 820 and 1440 px, to check that:
  - nothing scrolls sideways at 390 px outside the two timelines;
  - tap targets are at least 44 px;
  - the tabs and deep links work;
  - add, edit and move work;
  - the 409 path works end to end when a second writer saves first.
- The mod: `claude plugin test` and `claude plugin validate .`, plus the new round-trip
  test.
- Safari: Playwright has no WebKit on the mini, so Safari on the iPad and the iPhone is
  Jeff's check after each phase. The list:
  1. Both tabs, Back, and "Open on the board" (from Phase 4).
  2. Add an item with a due date. Open it, change its priority, set and clear the date, use
     Edit text, move it, then reload: all of it stuck.
  3. iPhone portrait: nothing scrolls sideways except inside Today and Next 24 hours.
  4. The rings fill once, and not at all with Reduce Motion on.
  5. Airplane mode for four minutes: "Updated" turns amber and says the page isn't current.
  6. Phase 2: each health chip opens its details. Phase 4: a tile filters, and a card opens.
- Screenshots come only from the scratch server's invented data.
- Each phase gets a review against this plan, then Jeff's C&P. When the server changed, a
  restart follows (by Vision or Jeff), and the web build comes only after that restart.

## Asks of other agents, through Jarvis

- Jarvis: the narrow job-status mode (Phase 2). Agreement on `title`, `ask` and `owner`,
  then filling them in, with a one-pass backfill of titles on the open items (Phases 1 and
  4). Confirming the routine names for runs started with `--agent`.
- Vision: an OK to read the Pi watch's state file as up or down, and confirmation that the
  five always-on services are the right list.
- Ultron: the five points under "Security".

## Out of scope

Search on the board (not now, per Jeff). The board's `created` stamps and the done lane's
archive, which have their own item. The "needs you" session state and the "quiet" flag
(NEXT.md §6). A dark theme, which isn't in the design. A restyle of the Claude Code mod.

## Risks

- Every source here is undocumented and can change in any Claude Code release (README,
  "Fragility"). The new ones are the subagent meta files, `agentSetting` and the
  `agent-name` lines. The JSON from job-status and `git-read` is Jarvis's, and his repo
  tests it.
- The mock's numbers (decision 1). Jeff will see much smaller figures than the ones he
  approved on the canvas.
- The design hard-codes lists that the page must derive instead: the Area options, three
  priorities and seven agents.
- Phases 2 and 4 depend on changes from Jarvis. Phases 0, 1 and 3 don't.
