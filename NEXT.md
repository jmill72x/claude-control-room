# Next

What's unfinished on this dashboard, written so a fresh session can pick it up cold.
The README covers setup and architecture; this file is only the open items.

## 1. Remote access — done via Tailscale Serve

Remote access is set up. `tailscale serve --bg --http=80 8322` is running on the
host, and the dashboard is reachable at `http://<mini-hostname>.<tailnet>.ts.net/`
from any device on the tailnet, from anywhere — see the README's **"Remote
access"** section for the command, exactly what it does and does not expose, and how
to turn it off.

**No code change was needed or made.** The service still binds `127.0.0.1` only (see
`server.mjs`); it is not reachable from the LAN, only from the tailnet, verified live.

**Remaining nicety, not a blocker: turn on HTTPS.** The tailnet doesn't have HTTPS
certificates enabled yet, so `tailscale serve` is running in `--http=80` mode — real
WireGuard encryption between devices, but plain HTTP inside that tunnel, not `https://`.
The upgrade is two steps, both documented in the README: enable HTTPS Certificates for
the tailnet in the Tailscale admin console's DNS settings, then re-run
`tailscale serve --bg 8322` (no `--http=80`) to pick up a real cert. Worth doing
because it also restores a secure context in the browser, which matters for the
`crypto.randomUUID()` fallback documented in `web/src/components/Lanes.jsx` — that
fallback is currently exercised on every tailnet visit, not just a hypothetical one.

**Cloudflare Tunnel + Access remains documented as the alternative route**, for a
device that can't run Tailscale, but it has not been applied and there is no plan to
apply it unless that need comes up — see the README's **"Alternative: Cloudflare
Tunnel + Access"** subsection for the exact ingress-rule stanza and Access policy
steps. It was deliberately never applied: this machine already runs a `cloudflared`
tunnel serving an unrelated production service (a LinkedIn review tool), and editing
that tunnel's live config to add a route was judged not worth the risk of breaking it
unattended. Any future session that adds the route should apply it by hand, reading
the current tunnel config first, not via a script.

**If it is ever applied, the Access policy must go on before or with the route, never
after.** The hostname becomes publicly reachable the instant the ingress rule exists —
Cloudflare doesn't gate on the Access policy being present, it gates on you having
added one. This dashboard renders account usage, project names, and spend figures, so
a route that outlives an unprotected minute is a real exposure, not a theoretical one.

## 2. Open bugs

The four review findings that used to be parked here were all fixed in `ee1e1df`
(2026-09-11). These are the ones still open:

- **Done 2026-10-20 (`83a2e0e`, live since the 21:47 restart that day): a transcript can
  no longer outgrow what the sessions collector can read.** Each file is streamed a line at
  a time and read again only when its size, mtime or inode changes (Orbit plan Phase 0,
  README, "Transcripts are read as a stream"). Measured before it shipped, on the real
  transcripts with one `now`: the same totals as HEAD (56.538M new tokens, 175 files), a
  first pass in 2.1 s peaking at 276 MB (HEAD: 3.4 s and 1.55 GB), later passes about
  0.1 s. The `/usage` poll passes `--no-session-persistence`. Jarvis's checks after the
  restart all passed: sessions, usage and credits `ok` with no unreadable paths, the
  week's totals in line, and no new poll transcripts 11 minutes later while the credits
  kept refreshing.

- **Fixed in the Orbit Phase 2 change (`7f1b070`, live 2026-10-21): a monthly or
  quarterly job's schedule read "Every day".** `calendarPhrase()` ignored `Day` and `Month`. It now says
  them, and entries that differ only in their month or only in their weekday share one
  phrase: "1st of Jan, Apr, Jul and Oct, 06:30", "Mondays to Fridays, 07:30".

- **Staged 2026-10-30, waits on Jeff's C&P and a restart: the server starts `claude`
  about 12 times an hour instead of about 133.** Jeff's "go" of 10-30. Open Claude Code
  bugs (#102265, #88583) show a short-lived `claude` that exits mid-renewal can blank the
  shared sign-in; a likely, unverified trigger of the 10-21 lapse. The 30 s
  `claude agents --json` poll is gone (the mod's Projects tab lists projects with no
  running state, and says "N total"; so did the first dashboard, removed 2026-11-18,
  §14), and `claude auth status` runs
  daily. `/usage` stays every 5 minutes: an hourly schedule was built and Jeff rejected
  it the same day ("the usage bars can't be updating that infrequently with a 5 hr
  window"); its code is not in the change. README, "How often the server starts
  `claude`". This closes the P3 "agents poll reads the Keychain every 30 s" (found
  2026-10-21 by sampling the live service's children starting `security`). Checks after
  the restart: `/api/dashboard` has no `agents` key; `usage`, `plan` and
  `accountCredits` read ok; ten minutes of sampling the service's children shows two
  `claude -p /usage` and no `claude agents`. It needed `npm run build` in `web/` for the
  first dashboard's page (built 10-30; that page is gone since 11-18, §14).

- **Done 2026-10-20 (`f16b659`, live since the 11:21 restart that day): token usage counts
  each API request once, not once per transcript line.** The week's new tokens read 3x
  lower. README, "The token figures count each API request once".

- **P2: the server lost its HTTP listener while staying alive.** From Sep 28 to Oct 2
  the process kept running, collectors still ticking, but held no listening socket,
  so every request hung. The root cause is unknown. Since `e725dbb` the server checks
  its own `/api/health` every minute and exits after three failures in a row, so
  launchd restarts it (see the README), but that watchdog has never been seen firing
  for real. Next step: look for `watchdog:` lines in `~/Library/Logs/control-room.log`;
  the first one is the moment to dig into the cause. Since 2026-10-19 (once the service
  restarts on that code) every log line starts with its UTC time, so a `watchdog:` line
  can be lined up against the `control room on` restart after it, the Mac's sleep and
  wake (`pmset -g log`) and the system log for the same minutes.

- **P3: `cachedUsageUtilization` vanished from `~/.claude.json` for ten minutes.** On
  2026-10-08, after Claude Code auto-updated itself to 2.1.295, the cached usage
  response the credits panel reads was missing from 19:35 to 19:45 local, then came
  back. The panel stayed honest, showing the last good figures marked stale. Cause
  unknown; watch for a repeat, especially the morning after a CLI update.


## 3. Known-unknowable data (don't go looking for these)

- **Chat (claude.ai) usage** has no local source at all and never will — those
  conversations are server-side, and the client never writes per-conversation token
  usage to disk anywhere. The UI labels it "not measurable locally" rather than
  showing zero.
- **Open-task counts per project** are `null` end-to-end. No source on this machine
  (agents JSON, session logs, anything else) reliably supplies one.
- **Plan tier** comes from `claude auth status --json`'s `subscriptionType`, on a
  daily timer (hourly until 2026-10-30). It's real but coarse, and has been observed to lag an actual plan
  change by a couple of days.
- **Renewal date and seat count** are hand-entered in `server/config.json`
  (`plan.renews`, `plan.cycle`, `plan.seats`) — nothing on this machine exposes
  either one. `plan.renews` is an anchor date that the server rolls forward to the
  next actual occurrence (`server/lib/renewal.mjs`); it still has to be re-anchored
  by hand if the billing date ever changes for a reason other than normal renewal.

## 4. Fragility warning

Every data source this dashboard reads is an undocumented file layout or CLI output
format that can change in any Claude Code release, with no compatibility guarantee.
Before trusting a panel that starts looking wrong, re-verify against the live machine
using the procedure in **§2 ("Research findings") of
`docs/superpowers/specs/2026-08-05-claude-control-room-design.md`** — it documents
exactly how each source was confirmed the first time and is the template for
re-confirming it.

The four surfaces this depends on, any of which can shift silently:

1. `claude -p "/usage"` text output (parsed by label, not position, but a reworded
   or restructured panel can still break the parser)
2. `claude auth status --json`'s `subscriptionType` (`claude agents --json` was
   the second surface until 2026-10-30, when its poll was dropped)
3. the two transcript roots (Claude Code's `~/.claude/projects/**/*.jsonl` and the
   Cowork local-agent-mode session directory)
4. `launchctl list` output plus the `~/Library/LaunchAgents/*.plist` files it reads
   alongside

## 5. Source-health: diagnose *why* a panel is unavailable, not just that it is

Raised during the Phase 2 design (pace, history, usage-drivers) but not built —
it wasn't in the approved spec for that work, so it's recorded here instead.

Right now `unavailable` means one thing to the UI regardless of cause. From the
outside, a `/usage` output format that Anthropic reworded and a `claude` binary
that crashed or isn't on the service's `PATH` look identical: same status,
same blank panel, same shrug. The dashboard has no way to tell you which one
it is, so every investigation starts from zero.

The fix is cheap relative to the payoff: have the parsers report what they
matched, not just whether they succeeded outright. `parse-usage.mjs` already
knows, line by line, whether a limit line matched `LIMIT_RE`, whether the
factors block's window-counts header matched, and how many behaviour/top
lines parsed under it — that information exists during parsing and is
discarded the moment the function returns. Surfacing it (something like
"matched 2 of 3 expected limit lines" or "factors header matched, 0 of 4
behaviour lines recognized") turns a silent unavailable into an actual
diagnosis: a partial match points straight at a reworded format, a total
match failure points at the CLI itself (not on `PATH`, timed out, auth
expired, etc.).

This is the highest-value follow-up on the table because it's aimed at the
project's central fact, not an edge case: every source this dashboard reads —
`/usage` text, `claude auth status --json`, the
transcript file layout, `launchctl`'s output — is undocumented and
unversioned (see "Fragility warning" above), and any of it can change in any
Claude Code release without notice. The question isn't whether a parser will
eventually drift out from under this dashboard, it's how long that will take
to notice and diagnose once it does. Right now the answer is "however long it
takes to manually re-run the source-of-truth verification in the design
spec." A parser that reports its own match rate shrinks that to reading one
line of status.

**A `/control-room doctor` command would put this in front of a person.** The idea comes
from SessionDeck (§6): one line per source with its last success, its last error, and a
"format drift suspected" flag when a file that exists stops parsing, as opposed to one
that is simply missing. Telling those apart needs the match rates above. The 2026-10-08
credits flake (§2) took several manual checks to diagnose; this would have made it one.
It should also count usage lines that lack a `requestId` or message id: those count one
line at a time, so a release that stopped writing either would bring back the 3x of
2026-10-20 (§2) with no error anywhere.

## 6. On hold: ideas from SessionDeck

Raised 2026-10-15: SessionDeck (`len5ky/sessiondeck`), an editor extension that tracks
live agent sessions. **Take the ideas only, never its code.** It is source-available, not
open source, and its license bars distributing modified copies; this repo is public, so
anything built from these has to be our own code. Waiting on a go-ahead; nothing is built.

- **A "needs you" session state.** Claude Code's Notification, Stop and UserPromptSubmit
  hooks post straight to this server, so the Projects column and the mod pane can show
  working, needs you, finished-unread and idle (`claude agents --json` only ever reports
  busy or idle), and ntfy can push "a session needs you". It needs a hook entry in
  `~/.claude/settings.json`, which only Jeff can add.
- **A "quiet" flag.** A working session that has been silent far longer than its current
  tool normally takes keeps its status but gains "quiet 12m" (SessionDeck allows 5
  minutes for a file read and 15 for a shell command). It flags a possible hang without
  inventing a state, and comes almost free once the first idea exists.

The third idea, a `/control-room doctor` command, is folded into §5.

## 7. Working on it

```bash
cd server && npm test                       # unit tests, no network, no shelling out
cd web && npm run build                     # produces web/dist, which the server serves
launchctl kickstart -k gui/$(id -u)/<your-service-label>   # restart the running service (Vision's and Jeff's job, not the agent's)
```

Config (`server/config.json`, gitignored) and the to-do board (`server/todos.json`,
gitignored) both live under `server/` and are edited directly on the machine running
the service — see the README's Configuration section for the field-by-field
reference. There is no separate staging step: edit the file, restart the service,
done.

## 8. Ranked improvements for the Jarvis era (2026-10-19)

Jeff asked "How can we improve the control panel?" on the day Jarvis went live. Jarvis now
writes the board several times a day, the agents run as subagents of one Jarvis session,
and Jeff reads mostly from an iPad or iPhone. Ranked. Items 1, 2 and 7 and the cron sort
bug were built the same day, committed and pushed, and live after the restart (the live
`GET /api/todos` sends an `ETag`, checked 2026-10-19 evening):

1. **Done (2026-10-19): a stale tab can no longer revert Jarvis's board edits.** The board
   has a revision (a hash of `todos.json`), sent as an `ETag`; a PUT with an old
   `If-Match` gets 409 and writes nothing, and the page re-reads the board on a 409, when
   the tab comes back into view, and every minute while visible. A PUT with no `If-Match`
   still writes (curl, Jarvis, the mod); one from a browser gets 428, which stops tabs
   loaded before the change. README, "Two writers, one board". Tests:
   `server/test/board-revision.test.mjs`. Left open: the mod still PUTs without
   `If-Match` (it re-reads just before writing, so its window is milliseconds); making it
   send the ETag from that GET is a few lines in `saveTodos()` plus a `claude plugin test`
   run.
2. **Done (2026-10-19): the board is second below 1024px**, after Usage and ahead of
   Projects. A board-first version went live that afternoon; Jeff saw it on his iPhone and
   wanted "usage first ... the to dos as 2 instead of 3", so Projects now carries the CSS
   `order` and drops to the end (the keyboard still walks 01, 02, 03). Checked at 390, 820
   and 1440 px against a test server and on the live page at 390. The Usage column is about
   1,800 px tall on a phone, so the board starts about two screens down. The Orbit redesign
   (§9) replaces this layout, with the board in a tab of its own. The labels still read 01,
   03, 02.
3. **An Agents panel** (M). **Built as Phase 3 of the Orbit plan (live 2026-10-21,
   §9):** the agent work map, Today agent by agent and Latest runs put runs to agents by a
   subagent's `agentType`, a `--agent` run's `agent-setting` line and the lead session's
   `agent-name`, never by working directory. Usage by agent through OpenTelemetry
   (approved 2026-10-20) is Phase 6, a cross-check that Ultron vets first.
4. **Watch the always-on services** (S–M, not built). `collectors/crons.mjs` keeps only
   plists with a schedule, so the always-on ones never appear. Checked 10-19:
   `control-room`, `cloudflared.mini` and `linkedin-review` are `KeepAlive` and show a PID
   in `launchctl list`, so "PID and last exit" works for them. **`com.jeff.jarvis` is not:**
   it is `KeepAlive false`, runs `jarvis/bin/jarvis-start` once at load and exits, so it
   shows no PID while Jarvis is perfectly alive. **Built as Phase 2 of the Orbit plan (§9),
   the health strip.**
5. **Board fields for a co-owned board** (M). Add `created` (the P3 item on the board), an
   optional `owner` (agent name) and a done-lane archive (37 of 86 items are done). There is
   no Control Room tag: this dashboard's items sit under Bug, Feature and Infra, so the board
   can't group them. Plan: the store stamps `created` on items that lack it (never
   overwrites it); `owner` is a free-text field the page shows as a chip; "archive" moves
   done items older than 14 days into `todos-archive.json` behind a "show archived" link.
   The Orbit plan (§9) takes `owner` and a done time (`doneAt`) into its Phase 1; `created`
   and the archive stay here.
6. **Source health / `/control-room doctor`** (M, §5 above). Also serve it as a small JSON
   status Jarvis can read for the morning brief, so "is the dashboard right?" is one GET.
7. **Done (2026-10-19): the service log is timestamped.** Every `console` line and the
   Discord poster's output start with the UTC time (`server/lib/log-stamp.mjs`). This
   unblocks the listener-loss item in §2 the next time it happens.

8. **Done (2026-10-19), live: optional due dates.** Jeff said "Yes" to Jarvis's proposal.
   Committed as `65312ba`; the service restarted and `web/dist` was rebuilt at 20:20 that
   evening, and 13 board items carried a date on 10-20. Each item may carry `due`
   (`YYYY-MM-DD`, a plain local date); the server stores it as sent and refuses a malformed
   one with 400 (unknown lanes and bad priorities are 400 too, not 500). The page shows a
   chip (red when overdue and not done, quiet amber within 2 days), edits it with a native
   date input plus Clear, offers a date beside the Idea and Doing add boxes, and has a
   per-viewer "Sort by: Due" switch. README, "The board's items". Tests:
   `server/test/due-date.test.mjs`; the page was checked in headless Chromium at 390 and
   1440 px against a scratch server, and Jeff checked the date input in Safari on his
   iPhone on 2026-10-20 ("Seems to be working"). Left open: the Claude Code mod neither
   shows nor edits `due` (it keeps it, since it spreads items when it changes them).

Also done the same day: the web page's cron sort (failed, then unknown, then the rest by
next run, the mod's order, in `sortCrons()` in `web/src/lib/format.js`); before, an
ingested cron with no `ok` ranked before or after a failure depending on the browser.

## 9. The Orbit redesign (approved 2026-10-20)

Jeff approved round 4 of the Orbit design on 2026-10-20 ("Add the health strip and
start"). The phased build plan is `docs/superpowers/plans/2026-10-20-orbit-redesign.md`:

- Phase 0: transcript reading that can't overflow (§2).
- Phase 1: the new page beside today's, Board tab included.
- Phase 2: the health strip.
- Phase 3: the agent views.
- Phase 4: Waiting on you.
- Phase 5: the flip (live 2026-11-10, below), then the first dashboard's deletion
  (built 2026-11-18, §14). The Orbit page is the only page.
- Phase 6: the OpenTelemetry cross-check.

Jeff approved the plan on 2026-10-20 (committed as `5c577e3`), and that evening answered
its seven decisions: "Go with her picks", which is (a) on all seven. The plan supersedes
the build notes in §8.3 to §8.5 wherever the two differ.

- **Phase 0 is live** (`83a2e0e`, restarted 2026-10-20 21:47 ET, §2).
- **Jeff's Safari checks passed on the iPhone and iPad on 2026-10-21** ("Orbit looks good
  on both iPhone & ipad"), covering Phases 1 to 4. Playwright has no WebKit here, so his
  devices are the Safari check.
- **Phase 1 is live** (`3b78c2a`, restarted 2026-10-21 10:07 ET, then the live build;
  every post-restart check passed). Jarvis added the `roster` and `jobs` blocks to
  `config.json` and wrote `title` on every open item.
- **Phase 3 is live** (`8a41768`, restarted 2026-10-21 11:31 ET, then the live build;
  every post-restart check passed, and the first board save after it returned 200). The
  agent work map, Today agent by agent and Latest runs (README, "The Orbit page"), with
  Ultron's board findings: the 1 MiB board cap and its 75% alert, type checks, no control
  or text-direction characters in `title` and `ask`, and a fixed line for an unreadable
  `config.json`. CSP and nosniff on the static pages are in the hardening fix below.
- **What the map leaves out, by the plan's rules:** the 65 helpers of the session that
  built Jarvis (2026-10-17 to 10-19), which wasn't started as `claude -n Jarvis` and so
  isn't the lead's session; the morning brief and the weekly digest, which run with no
  `--agent` and no name; and whatever Jeff runs himself. The totals elsewhere count all
  of it. A hook that would put the brief and digest on Jarvis's lane, not built: the
  routine passes `-n <name>`, and its job in config names it (`"session": "<name>"`), so
  a top-level session whose `agent-name` matches is that job's run. Unverified: whether
  `claude -p -n` writes the `agent-name` line.
- **Phase 2 is live** (`7f1b070`, restarted 2026-10-21 14:53 ET, then the live build;
  every post-restart check passed: health ok, 15 jobs, the five service chips up or
  running, no label or path in `health`, and every cron with `lastRunAt` from the crons
  collector's second pass). The health strip (README, "The Orbit page", "The health
  strip" and "Security"):
  - Jobs: Jarvis's `job-status --json --only jobs` (jarvis `d88dc9b`), every minute, 20 s
    for the whole call. The crons panel takes its verdicts and `lastRunAt` too, so a
    Scheduled mark goes hollow for a due time with no run logged since.
  - Jarvis: **the process list, not `claude agents --json`** (decision 4 kept in spirit:
    listed means up, no heartbeat file). That poll's runs start `security` (§2), and
    nothing showed cleanly that they make no network call, which Jarvis asked for before
    a minute-by-minute read leaned on it.
  - Control Room: its start, plus one `launchctl print`. Tunnel and Review page: launchd's
    state, labelled "running". The Pi: the watch's state file under Vision's contract
    (the NAS watcher's README), unknown unless the watch's own job is OK.
  - Pushes: "1 job failed" and "1 service is down" (after 5 minutes down), counted,
    never named, never for the Pi or this server.
  - Self-restart reads "not run yet" until its first run, Sun 10-25.
- **Phase 4 is live** (`26edb73`, restarted 2026-10-21 17:56 ET, then the live build;
  every post-restart check passed: To push read 10 repos, all ok and none to push, with no
  path, `.git` or git-read output in the payload, and the panel counted 31 asks: 4 due
  soon and 27 to decide or do). Waiting on you at the top of the Overview, To push, and
  "You" events on Next 24 hours (README, "The Orbit page", "To push" and "Security"; the
  plan's Phase 4 has what differs from it):
  - Items: an open item with an `ask` waits. Due soon is a `due` within 7 days or past
    (dark for today, tomorrow and overdue); the rest are Decide or do. All cards show
    the first 9, then "Show all". A "You" event needs an ask with a `time`.
  - To push: `toPush` in config, git-read on each repo every 5 minutes with 10 s each
    and SIGKILL to the process group, `--untracked-files=no`, counts and branch names
    only. A branch with no upstream never counts; Jarvis's own repo has tracked its
    build branch's upstream since 10-21, so it counts like the others.
- **The hardening before Phase 5 is live (`bbd31de`, restarted 23:06 ET 2026-10-21),
  after Ultron's vet: no critical, high or medium finding; his three lows were folded
  into the same change.** Left: Jeff's Safari look. Ultron's leftovers
  from his 10-21 vets (README, "Security", "The program check" and "The board's items"):
  - A Content-Security-Policy, Ultron's (`default-src 'self'; object-src 'none';
    base-uri 'none'; frame-ancestors 'none'`) plus `form-action 'none'`, since
    `default-src` doesn't cover forms and the one form (the Board's New item) stops its
    own submit. nosniff on everything the static handler sends (both pages, their
    assets, the fallback and the refusals) and on every API answer. A server with no
    build now answers 404 "not built" as it was meant to, not an empty 200.
  - The lead's chip counts only the service user's own processes that are alive (`ps`
    with `uid=` and `stat=`; a stopped `T` or zombie `Z` one doesn't count).
  - job-status gets SIGKILL at its 20 s limit.
  - job-status and git-read start as `/usr/bin/python3 -I <path>` with the same short
    environment (git-read's list plus `xcrun_nocache=1`). At startup each launcher and
    the package it imports (`../jarvis`, everything in it) must pass the program check:
    this user's own, in folders owned by this user or root, none of it group- or
    world-writable. A launcher that passes runs from its real path; one that fails is
    left out with a `config:` line. The real launchers and package pass.
  - `title` and `ask` also refuse the zero-width space (U+200B), the word joiner
    (U+2060), the byte-order mark (U+FEFF) and the direction marks (U+200E, U+200F,
    U+061C). The joiners U+200C and U+200D stay allowed (Jarvis's call on Ultron's
    advice), since U+200D sits inside combined emoji. None of the 177 items on the live
    board (98 titles, 29 asks) held any of the wider set, read-only, 10-21.
  - Checks: 610 server tests and 80 web tests, in local time and Tokyo; 54 of 54
    mutations caught; the mod kit's 53 tests. Headless Chromium on two scratch servers
    with the same invented data, HEAD's code and this one: the classic page and
    `/orbit.html` (Overview, Board, an opened card on each) at 390 and 1440 px render the
    same on both, with no policy violation and no console error; the New item form
    (by its button and by Enter) and the classic page's add box still add items; and an
    injected inline `<style>`, `<script>`, `style` attribute, `eval` and a form that
    really submits are blocked on the new one only. One read-only pass on the real
    machine with the real settings in memory: both launchers and the package pass the
    check, job-status under `-I` with the short environment answers as with the whole
    one (19 jobs), To push reads all 10 repos, and the lead counts 1, as before.
  - After C&P: one restart (Jarvis's rollout), then nothing to build; the scratch build
    of the web is identical to the live one. Check the service log for `config:` lines
    after the restart. Phase 5 then waits only on Jeff's word.
- **Phase 5, the flip (Jeff's word, 2026-11-10: "Flip now").** `web/index.html` is the Orbit page and the old one is
  `web/classic.html` ("Control Room (classic)"); `/orbit.html` has no file and gets the
  Orbit page from the server's fallback (a test pins that), hash and all. No server
  change, so no restart: the web build alone put it live (2026-11-10, same bundle as the
  scratch build; the build before it is in that run's scratchpad only). Checks: 600 server tests (local
  and Tokyo) and 80 web tests; headless Chromium on a scratch server with an invented
  board, at 390 and 1440 px: `/`, `/orbit.html`, `#board`, `#board/<id>` on both, and
  `/classic.html` render with no sideways scroll, no policy violation and no console
  error; on both addresses the Board tab, Overview, a Waiting on you card, Open on the
  board and Back work; an injected inline script on `/` is blocked. After the live build,
  a read-only pass (no request but GET) of the live `/`, `/orbit.html`, `#board` on both
  and `/classic.html` at 390 and 1440: no policy violation, no console error. The one
  finding is old: the classic page scrolls sideways at 390 on the live data (440 px
  wide), with its CSS unchanged by the flip; it goes with the page. Safari is Jeff's
  look. **The second half, a week later, is built (2026-11-18, §14):** `classic.html`, its
  components and CSS and the `classic` Vite entry are deleted, and the README describes
  the Orbit page. The sideways scroll went with the page.

## 10. The Jarvis OS home screen (designed 2026-11-10; Phase 1a built, staged; Phase 2 Feed staged 11-11)

Jeff's pick of 2026-11-10: the Control Room becomes the one home screen (what's running,
what's waiting on you, today's routines, usage, approvals), built on the Orbit page. The
design is `docs/design/2026-11-10-jarvis-os-home.md`; Jeff answered its decisions on 11-10
(the doc's §9: all yes, approvals "both" buttons and Discord DMs, the product's name "Jarvis
OS" if it comes off, and a new Phase 2 direction: messaging with Jarvis inside Jarvis OS,
replacing Discord, pending Shuri's research). Step 0 was the Phase 5 flip (§9); its second
half (the first dashboard's deletion) was built 2026-11-18 (§14).

**Home merge (board f74ca819): eleven Overview sections become five, built 2026-11-14
overnight on `jos/home-merge` (worktree `~/Projects/.worktrees/ccr-home-merge`, from main
09facae); Jeff picked Usage before Agents 11-14 ("I think usage before agents").** Jeff
11-14: "Feels like we've got some duplicate sections now." The order
(`web/src/lib/orbit/home.js`): Needs you; Usage (rings up front, Burn and the heat map
behind a fold) beside Today's schedule (Today's routines over Next 24 hours, the loops'
line at its foot); Agents (tabs Now = Live agents with Stop, Today = Today agent by agent
over the work map, Recent = Latest runs); Loops only while a loop is open. Page only, no server change; README "The
Orbit page" has the details. Where each old section went:
Usage limits → Usage; Today's routines and Next 24 hours → Today's schedule; Live agents →
Agents/Now; agent work map and Today agent by agent → Agents/Today; Latest runs →
Agents/Recent; Burn and This week → Usage's fold; Loops → its own section while open, else
the line in Today's schedule; the phone's More fold is gone. Checked: web 243/243 and
server 1195/1195 in two TZs (server under umask 022, below); 27/27 mutants on the new
tests; headless Chromium 78/78 (tabs, keys, Stop sheet from the Now tab, the Board round
trip keeps the tab, both folds and their memory, 44 px buttons, no sideways scroll at
320/390/820/1180, an older server's missing blocks); screenshots before and after in
`~/.local/state/jarvis/outbox/home-merge/`. Open:
- Jeff's look and his call on the order: the board item's order puts Agents above Usage,
  against his 10-19 rule (usage in the first two blocks on a phone). Swapping is one line
  in `homeSections` plus its test.
- A loop open now sits last, where before it moved up under Usage limits on a phone.
- On an iPad held sideways (1180) Next 24 hours sits in the narrower right column and
  scrolls sideways; its label collisions for events close together (4:30 PM You item and
  a 5:34 PM reset) are as on main.
- The Overview stays light-only in dark mode, as on main (dark tokens cover Chat and Feed).
- Safari and real devices unverified (Chromium headless only).
- Go-live: Jeff's OK on the layout, C&P, then a web build (page only; no restart is
  needed for this branch, but a build is a live deploy, so build after the C&P).
- Found on the way: `acks.test.mjs` "an alert with no since" was a date bomb (a fixed
  `nextRunAt` against the real clock; failing about 11-13 08:54Z to 11-14 06:53Z), fixed
  in this branch's test only. "the store reads an absent file…" fails under umask 077 (the
  agent sandbox's), passes under 022: an environment fact, not a bug.

**War room slice 2 (board 83daafe7): Stop with Face ID, option B, built and staged
2026-11-13 on `jos/war-room-2` (from main a4946a5, worktree
`~/Projects/.worktrees/ccr-war-room-2`) and, in Jarvis's repo, `jos/war-room-stop` (from
build/v1 c7de21e, worktree `~/Projects/.worktrees/jarvis-war-room-stop`; channel 0.4.7),
not committed.** Jeff picked B with Face ID over Ultron's A. Design, the answers to
Ultron's two objections, C1-C6, tests and the go-live order: the design doc's "Built"
section. Open:
- Ultron's review 11-13: ship with fixes (1 medium, 9 low), all folded in and re-staged
  (design doc, "Ultron's review fixes"); his re-read of the fixes is next.
- Go-live: C&P both, restart the Control Room, release channel 0.4.7 and restart Jarvis
  through `jarvis-start`, set up Face ID on each approver device (`bin/chat-pair passkey
  <CODE>` at the mini), then one stop on a scratch background agent running `sleep 300`.
- Unverified until that first stop: TaskStop taking the id from `agent-<id>.jsonl`, and
  whether it ends a running Bash child; Safari and real Face ID; whether Jarvis's Bash
  prompts for `node .../stop-match.mjs` (an allow rule is Jarvis's and Jeff's call).
- `acks.test.mjs` "an alert with no since" was a date bomb, fixed on `jos/home-merge` (above).

**War room slice 1 (board 83daafe7): the Live agents panel, merged 2026-11-13 (main
a4946a5), not live.** Read-only: the agent runs going now, under Usage limits on the Overview
(README, "Live agents"). Shuri's pick 3 assumed the server "already polls `claude agents
--json`": it doesn't, since 2026-10-30, and the panel doesn't bring it back; it reads the
transcripts the sessions collector already reads (subagent meta files plus a new
run-ended signal in the parser). Live after a restart (Needs Jeff; a web build is a live
deploy, so build only with the restart). Open:
- Stop buttons: slice 2, above.
- Not verified on real devices or in Safari (Chromium headless only, 360-1440 px).
- A run stopped from outside (a TaskStop, a closed session) stays "live" until its
  15-minute window passes, marked "quiet" after 2 minutes.
- Unrelated, found while testing: `server/test/acks.test.mjs` "an alert with no since
  takes at most 24 hours over the route too" fails on main 08244d2 as well (1 of 1173).

**Exact Bash on approval cards (board 320ecc71 and 8ecf3ca9): Ultron's two conditions and
his 11-13 re-read fixes are merged (main e59ba37); the console test (step 10) ran 11-13 and
reworked the match (main 5cf038e), and Jeff's re-test of that passed 11-13 (the hook 18-23
ms after the relay, every text matched). Ultron's re-read of the rework left L1-L3 (board
9fba4216, 8b77e6e2): fixed and staged 2026-11-13 on `jos/exact-bash-4` (from main 5cf038e,
worktree `~/Projects/.worktrees/ccr-exact-bash-4`), not committed; `approvalsBash` stays `"deny"`.**
*What main has:* the 40-report cap (a dropped report makes every match a conflict until it
would have been forgotten), rivals counted store-wide while kept (2 minutes), each kept
report rechecking every open Bash card that shows an exact text (M1), a marked card
redrawn at once and an Allow on the pre-mark card a `changed` 409 with the card, not
counted toward lockout (L1), a Deny on it counted (L2, `exactWas`), the parity alert
wording (L3), the kit's plugins-off settings and step 10's checks (L4, L5). *In parity*
(live; Jeff's pick (b), 11-13) a conflict takes the text off the card, adds the mark
(`exactNote`) and keeps Allow; guarded makes the card Deny-only.
*What the console test found* (Jeff, 11-13, Claude Code 2.1.323, kit
`bin/exact-hook-check.mjs`; the first round used `cat` and `echo`, which run with no
prompt, so round 2 used `touch` and `printf`): (1) the PermissionRequest hook reports
**22-26 ms after** the channel's relay, every time, not before it; (2) the relay's
`input_preview` keeps `\n` and `\t` (a Write's `content` too); (3) the relay folds each run
of spaces to one, leading and trailing ones included (`printf 'a  b'` relayed as
`printf 'a b'`, two spaces either side of `touch t6.txt` as one). The kit then paired each
request with the report before it, which was the previous command's, so it printed
`ORDER FAIL` and `DIFFERS`: a kit bug, not a mismatch. *What the rework (5cf038e) changed:* the fold
(`foldWhitespace`) is now the relay's: runs of spaces only, never a line break or a tab
(it folded all whitespace). The window is 1 s before the relay to 2 s after (was 30 s / 5
s): a report from well before belongs to an earlier prompt. A card now usually opens with
no exact text; a report that lands inside its window and is its one candidate gives it the
text (its Deny-only reasons are worked out again over the text) and redraws it through the
existing path (`noteExact`, `exactSettled`); a conflict found then is handled as at open.
A tap that comes before the report is judged on the folded card (guarded: Deny-only;
parity: allowable as relayed); an Allow made on the folded card after the text arrived is
the `changed` 409 with the card (`exactGained` in the store), a Deny on it counts. The
store sends no redraw for a card whose first send is still being written. The kit pairs
each Bash request with the report inside that window, before or after, prints
`ORDER BEFORE` or `ORDER AFTER` with the gap in ms, `NO REPORT` when none came and
`NO REQUEST` for a report that met none, and compares with the new fold. Step 10's prompts
now need permission. *Tests:* server 1171 (main 1165; the one failure, `acks.test.mjs`
"an alert with no since takes at most 24 hours over the route too", fails on main too), in
both time zones; web 222 (unchanged; no page change, so no build). New: a replay of the
console test's exact timings and texts over the routes, guarded and parity, expecting the
exact text on every card, drawn then redrawn (fixture `server/test/fixtures/console-1113.mjs`),
the same replay through the kit, and the tap-order cases. 21 of 22 mutants caught; the
survivor was a redundant line, removed. *What `jos/exact-bash-4` changes (Ultron's 11-13
re-read):* L3, the shown hash (server `shownHash`, page `shownInput`) now covers the parity
note `exactNote`, as a last `{ note }` item, so a card that gained its text late and then
lost it to a rival no longer hashes like the folded card it started as; an Allow on any
earlier copy (folded, or with the gained text) is the `changed` 409, and a late rival's
mark now also sets `exactGained`, so a tap on the folded card before that mark is changed
too, not a counted refusal. L2, the page arms Allow on a copy of the card (`armedCopy`): a
redraw between the two taps disarms it, and the verdict hashes the copy the tap was made on
(the armed one for Allow, the drawn one for Deny), never the newest in the page's map. L1,
the wording says spacing may differ, not that line breaks fold (the parity notes, the
deny-mode reason, the card's "command, as relayed (spacing may differ)" label). Tests:
server 1173 (main 1171; the same `acks.test.mjs` failure as main), both time zones; web
222 (new assertions in existing tests: pinned hashes shared with the server's, the arm);
7 of 7 mutants caught. Web built to a scratch folder only. *Go-live:* Ultron re-reads
`jos/exact-bash-4`, C&P (the merge's web build ships the page half), then steps 11 to 13.
Nothing changes while `approvalsBash` is `"deny"`. *Unverified:* auto mode's fallback order
(the 11-13 results have no auto-mode lines); that a relay folds nothing but spaces in other
fields; the page's redraw of a gained text and the disarm on redraw in a real browser (the
arm's logic is unit-tested, the component wiring is not).

**Jarvis OS 6, self-healing loops (board b384cd92): designed 2026-11-12
(`docs/design/2026-11-12-self-healing-loops.md`). Loops 1 (board ea709def) and 2 (board
6af6f55e) are merged and live since 2026-11-15 (main 0b09e2d; config's `heal` block on,
the start line reads `heal: on, 6 targets`). Loop 3 (board 4afe7968, a restart of this
server after a merge) is built and staged 2026-11-15 on `jos/loop3` (from main 0b09e2d,
worktree `~/Projects/.worktrees/ccr-loop3`), not committed, not live; its part is the
last item of this paragraph.** Loop 1 marks a job "quiet, ran
clean" (grey, no push, no event)
when job-status calls it overdue for its log's age alone and two read-only `launchctl print`
readings show the run counter rose with exit 0 at both. It also lays the shared parts: the
catalog loader with its verb-floor check, the runner, the ledger (`server/data/heals.json`),
the kill switch (`~/.local/state/jarvis-os/heal-off`), `GET /api/loops` and a read-only
Loops panel. README, "Self-healing loops", has the mechanism and the config block.
- **Loop 1's go-live (what is left):** Jarvis adds the `heal` block to config.json
  (`enabled: true`, the NAS mount job as the one target with `["mark-quiet"]`) and the
  service restarts (config is read at start). With no block it logs `heal: unset` and
  changes nothing. (The C&P, build and first restart were done after f8cd1b1: the live
  panel says "Not set up".)
- **Undo:** `touch ~/.local/state/jarvis-os/heal-off` lifts every quiet mark within a minute
  with no restart, or `heal.enabled: false` with a restart.
- **Departures from the design, to defend:** (1) a calendar job is checked by the counter
  across its next due time, not by `missed-runs`, which judges by the same stale log time
  and would call a quiet job missed; (2) no `heal-done` event yet: an event wakes the lead,
  loop 1's done-means says no wake, and the released channel maps unknown event names to
  "unknown", so it waits for Jeff's answer to the design's question 3 and a channel change;
  (3) the caps count instances, not ledger lines, because the quiet marks live in memory and
  each restart re-checks (11 restarts on 11-11 would have spent the 3-a-day cap on one job);
  (4) a comeback within the hour means another instance, so the same one checked again after
  the kill switch or a restart is not refused.
- **For Ultron:** the runner (`lib/heal-runner.mjs`: order of the kill checks, ledger line
  before the mark, one attempt per instance), the floor check and `toolsFor`
  (`lib/heal.mjs`), the hold in `collectors/notifier.mjs` (an already-pushed key is never
  held), and the quiet downgrade (exit 0 at both readings, so a crash loop's rising counter
  can't pass).
- **Checked:** server 1137 tests (53 new) and web 217 (7 new), each in local time and `TZ=Asia/Tokyo`; 111
  mutants over the heal code all caught (two no-op baselines pass); the Loops panel headless
  (Chromium) at 390 and 1440 px in five modes (open, quiet, killed, not set up, a server
  without loops), no sideways scroll, no CSP violation. The live `launchctl print` output
  was read (read-only) for the field formats: `runs = N`, `last exit code = 0` or
  `(never exited)`, `run interval = 180 seconds`, and `last terminating signal` in place of
  an exit after a signal. **Unverified:** the counter's behaviour across sleep and wake and
  for a job running at the moment of a reading (fixtures only); Safari.
- **Not built (later loops, or follow-ups):** the "3 in 14 days" fix-item event (now the
  proactive check's `heals` rule, staged 2026-11-18, §16, which tells the lead); the loop count on the
  health strip; the morning brief still reads job-status directly, so it still calls a quiet
  job overdue (a Jarvis-side change: read `/api/loops`, or teach job-status the counter).
  Board 20620d37 (an acked job red after a restart) is next door but untouched: the runner
  runs after the crons pass's `whenAsked()` wait, so a first pass without job-status's
  answer has no `staleLog` entry and opens no loop.
- **Loop 2, a run missed during a restart (T2), merged and live 2026-11-15 (main 0b09e2d);
  Ultron reviewed it on 11-14: ship with fixes (1 medium, 7 low), all made.** Vision's
  read-only `missed-runs --since boot --json` runs at the first crons pass after a start and
  daily; a heal target it flags as missed in a restart (or a sure sleep gap) and not run
  since gets a card in Needs you (a fifth tile, Heals, only while one waits) with **Run it
  now** (targets listing `rerun-job`), **Ack until its next run** (`ack-until-next-run`) and
  **Not now**. Only a tap from an approver device on the page acts; Run it now ends in the
  catalog's fixed `/bin/launchctl kickstart gui/<uid>/<label>` (no `-k`), verified by the
  run counter and exit 0 within 10 minutes, else a T3 page. README, "Self-healing loops",
  has the mechanism; the files are `lib/heal-missed.mjs`, `lib/heal-routes.mjs`,
  `lib/heal-programs.mjs`, the catalog and program check in `lib/heal.mjs`, the Heals cards
  in `web/src/orbit/Waiting.jsx` and `web/src/lib/orbit/loops.js`.
  - **Ultron's review (11-14) and the fixes:** M1, a pass during the program's run could
    make a second card for the same instance: the instance is now in flight (`verifying`)
    before the program runs, a `tapped` line makes it spent, and the pass skips a card a
    tap took while it read launchd (each guard tested apart). L1: one exact, reviewed
    argument list per launchctl write verb (`PROGRAM_ARGS`). L2: no ack without the job's
    `lastRunAt` and `nextRunAt` (409). L3: tap log lines and the runner's `by` go through
    `oneLine`. L4: no uid-0 fallback; the uid must be the process's own at use. L5: an
    alerted, capped `heal-tap-refused` for a Shortcut key or a non-approver device. L7:
    the card reads and runs config's target label. His answers: no Face ID, the rate
    numbers stand, loop 3's `-k` is its own verb `launchctl:kickstart-kill` with its own
    list (design doc, loop 3 and §8).
  - **Accepted risk (Jeff, 2026-11-15, Ultron's L6):** `missed-runs` is not pinned by hash;
    it runs from the machine-setup tree, checked at start for ownership and write bits
    only. A change to that file (Vision's, through C&P) takes effect at the next run.
  - **Go-live (done 2026-11-15 up to step 4; step 5, Vision's live miss test, is still to
    do):** (1) Ultron's re-read of the fixes, if
    he wants one; (2) Jeff's C&P, and the merge's `cd web && npm
    run build` (page-only, safe before the restart: the old server sends no `proposals`,
    so no Heals tile shows); (3) Jarvis adds to config.json's `heal` block: `"enabled":
    true`, `"missedRuns": "/Users/<user>/Projects/machine-setup/bin/missed-runs"`, and
    targets, e.g. the Friday alert job with `["rerun-job", "ack-until-next-run"]` and the
    morning brief with `["ack-until-next-run"]` only (a late brief is no use); a backup of
    config.json first; (4) the service restart (Vision's LaunchAgent; Jeff runs it); the
    start line should read `heal: on, N targets; missed-runs set` with no `config:` line
    about `heal.missedRuns`; (5) the live check from the design: Vision makes a harmless
    test job miss its fire (unloaded over its fire time, with Jeff's OK), the server is
    restarted or the daily scan comes round, and Jeff taps Run it now on the iPhone; the
    log shows `heal: rerun-job started … by <device>`, then `healed`.
  - **Undo:** `touch ~/.local/state/jarvis-os/heal-off` turns every button off at once
    (no restart), or drop the targets' `rerun-job` (only the ack is offered), or
    `heal.enabled: false` with a restart; `git revert` + build takes the page part back.
  - **Departures from the design (Ultron accepted (3) with L2's condition, 11-14; the rest were noted, not reviewed):** (1) `catchUp: "offer" | "skip"` is the
    target's `actions` list, not a second key (one place to say what a card offers);
    (2) cards open only for a fire missed in a restart or a sure sleep gap, not every
    `needs_look` job: a job not loaded, a stale interval job or "no run since" with no
    outage is another class, and a kickstart can't fix the first; (3) the ack goes in
    without a live alert (the route's rule is "only a live alert"), because the missed
    run's log-age alert comes days later on the same instance (`lastRunAt`); it is still
    T2, made from config's label and the crons panel's times, never from the request;
    (4) the 2-hour expiry runs from the push, so a card made at night lasts until 09:00;
    (5) no `heal-proposed` event: same reason as loop 1's `heal-done` (the released channel
    names only the event types it knows, and an event wakes the lead); the card's push and
    the per-tap `heal-tap` alert carry it; (6) no Face ID on the tap (Stop has it): an
    approver device's Allow can already do more than run one configured job once
    (Ultron agreed).
  - **Checked (after Ultron's fixes):** server 1238 tests (43 new: 33 in
    `heal-missed.test.mjs`, 10 in `heal-routes.test.mjs` with the program-check, notify
    and server.mjs wiring checks), web 248 (5 new), each in local time and
    `TZ=Asia/Tokyo`; 96 mutants over the loop 2 code, its routes, the catalog's program
    check, the alert cap and the page logic: 95 caught, one equivalent (an element compare
    after the lengths already matched), two no-op baselines pass. The two
    `acks.test.mjs` route tests that failed on main from 11-14 (a fixed NEXT went past)
    were fixed in the test. Headless Chromium on a
    scratch server (port 8411, scratch data, a fake launchd and program runner) at 390 and
    1180, light and dark, four modes (card with a tap through an https shim, card over
    plain http, killed, no cards): 106 checks: the Heals tile first only while a card
    waits, buttons 44 px, no sideways scroll, no CSP violation, the tap runs the program
    once with the catalog's arguments, the card goes and the Loops panel shows the check,
    then healed; over plain http the Origin rule refuses and the card says so; killed,
    the buttons are off with the reason. Screenshots: `~/.local/state/jarvis/outbox/loop2/`.
  - **Unverified:** a real `launchctl kickstart` (never run; tests use a fake runner); a
    real `missed-runs` run by the server (its JSON shape read from the source, not from a
    live run); a tap from Safari on the iPhone (Chromium only; the https Origin path is
    covered by the route tests and the shim); how long real jobs take against the
    10-minute check (a long brief would page as `still-running`).
  - **Ultron's re-read low, N1 (board fe4d2bfe), fixed on `jos/loop3`:** a tap with an
    `Authorization` header raised the `heal-tap-refused` alert before the login check, so
    any caller that reached the port could spend ntfy's daily pushes. The alert now goes
    out only after the owner's login header passes (`requireLogin`, handed to the heal
    routes by the chat router); anyone else gets the login's 403, unalerted. The Shortcut
    routes' `shortcut-refused` has the same posture and is not changed here.
- **Loop 3, a restart of this server due after a merge (T2), staged 2026-11-15 on
  `jos/loop3`; Ultron reviewed it the same day: ship with fixes (1 medium, 10 lows), all
  made and restaged.** README, "Self-healing loops", has the mechanism. In short: at start
  the server reads its checkout's HEAD through git-read (`toPush.gitRead`); every 5
  minutes it reads the checkout (`status --porcelain=v2 --branch`) and, when `diff
  --name-only <start> <HEAD> -- server` lists files, shows **Restart the Control Room (N
  merges)** in Needs you (since board 2703904f, §15, also for the two page files read
  aloud runs in the server). A web/- or docs/-only merge opens nothing. A tap answers 202,
  then 3 s later runs `/bin/launchctl kickstart -k gui/<uid>/<label>` (config's `self`
  target, which must be `XPC_SERVICE_NAME` with launchd as the parent) in its own process
  group; the new process closes the `verifying` line as healed ("restarted on the new
  commit, <old> → <new>") or pages once. Files: `lib/heal-restart.mjs`, the catalog
  entry, verbs and `PROGRAM_ARGS` line and `t2ActsToday` in `lib/heal.mjs`,
  `runSelfRestart` and `createCheckoutReader` in `lib/heal-programs.mjs`,
  `parseLaunchdPid` in `lib/health.mjs`, `whenFirstPass` in `collectors/registry.mjs`,
  the routes in `lib/heal-routes.mjs`, the card in `web/src/lib/orbit/loops.js`.
  - **Ultron's review (11-15) and the fixes.** He agreed with all six picks (strict
    commit match, a clean first pass, `XPC_SERVICE_NAME` + ppid 1, no expiry, answer then
    the 3 s kick, `git:read` as T0). M1: a restart was offered on any HEAD change; now
    only onto a checkout fit to run (on `main`, no changed, staged or unmerged tracked
    file, cut output counted as changed, HEAD a descendant of the running commit by
    `rev-list --count <HEAD>..<start>` = 0), checked in the pass, at the tap, at the
    restart and by the new process before it calls it healed; an unfit one shows the
    card with its buttons off, the reason, and no push. L1: the restart reads the
    checkout again; moved or unfit means no restart (`cleared`, "moved" or the reason),
    and the card comes back. L2: the first pass is judged on its raw list (not a list is
    a failure); names are filtered for the ledger only. L3: the collectors failing at the
    tap go in the `verifying` line, the new process pages only for new failures, and the
    names show on the Loops panel. L4: an open line in a process whose heals are off,
    unset or whose catalog was refused is closed with one page
    (`heals-off-unchecked`). L5: a tap whose HEAD differs from the card's answers 409
    "it moved" and brings the card up to date. L6: card pushes capped at 1 an hour and 3
    a day, counted by `proposed` ledger marks. L7: one page for every line a start
    closes. L8: a launchctl timeout leaves the tap open (the minute's check or the new
    process decides), and a test pins that nothing in the server catches SIGTERM/SIGINT/
    SIGHUP. L9: at the tap, `launchctl print gui/<uid>/<label>` (a T0 read, now in the
    entry's verbs) must give this process's pid. L10: the heal routes throw without the
    login check. L11: loops 2 and 3 count the day's 20 T2 actions with one helper.
  - **The self-kill, thought through:** the answer, its log line and its `heal-tap`
    alert go out before the restart (3 s delay); the ledger line is on disk (temp file +
    rename) before the delay starts, so the new process can always check it; a tap whose
    answer was lost and is retried finds no card in the new process (404); a HEAD that
    keeps moving makes cards, never restarts: only a tap restarts, the new process never
    restarts on its own and offers no card while it checks one, each HEAD gets one
    attempt, and at most 3 restarts a day (`RESTARTS_PER_DAY`) plus the day's 20 T2
    actions across the loops. Lines are written before pages, so a process that dies
    between them never pages twice. If no process comes back at all, the channel's
    silent alert and the NAS box's page check are what notice (design).
  - **Go-live, in order (each gated):** (1) Ultron's re-read of the fixes, if he wants
    one; (2) Jeff's C&P and `cd web && npm run build` (page-only: the old server sends no
    restart card, so nothing shows until the restart); (3) Jarvis adds one target to
    config.json's `heal.targets`, a backup first: `"control-room": { "label":
    "net.milleradvisorypartners.control-room", "actions": ["restart-control-room"] }`;
    (4) the service restart, by hand this one last time (Jeff, Vision's LaunchAgent); the
    log should show `heal: restart-control-room watches the checkout from <hash>` and no
    `config:` or `not running as the launchd job` line; (5) at the next merge that touches
    server/ (the main checkout on main, clean), Jeff taps Restart it on the iPhone; the
    log shows the tap, then from the new pid `back on <hash>` and `healed (restarted)`.
  - **Undo:** `touch ~/.local/state/jarvis-os/heal-off` (no restart; a tap in its 3 s is
    cancelled too), or `"off": ["restart-control-room"]`, or drop the target, with a
    restart; `git revert` + build for the code.
  - **Departures from the design, to defend (Ultron accepted them 11-15):** (1) no expiry
    on the card: an expired card would leave the restart due with nothing offering it;
    (2) "touches server/" is the diff between the running commit and HEAD, so a change
    merged and taken back opens nothing; N counts first-parent commits touching server/;
    (3) git is read through git-read (log, show, diff, status, ls-files, rev-list and
    remote only), under a new T0 verb `git:read`; (4) a clean first pass means no
    collector failing that wasn't failing at the tap; (5) the check runs while the kill
    switch is on (it reports on a restart already made); (6) restart heals are left out of
    the weekly "keeps happening" counts. While a card is blocked, Restart is off but Not now
    stays on (Jeff, 2026-11-15: option b, the server's `canDecline`), so it can be
    dismissed; it then stays parked until HEAD moves. Otherwise the card goes by itself
    when the checkout is fit or HEAD moves back.
  - **Checked (after Ultron's fixes):** server 1282 tests (44 new over main: 41 in
    `heal-restart.test.mjs`, one on a real scratch git repo with `--no-ff` merges, a
    feature branch, a detached HEAD, a conflicted merge, tracked and untracked changes
    and a reset; 3 in `heal-routes.test.mjs`; loop 2's shared count in
    `heal-missed.test.mjs`; git-read's arguments), web 251 (3 new over main), each in local
    time and `TZ=Asia/Tokyo`. Mutants: 188 over the new and changed code (catalog,
    config, reader, loop, programs, registry, routes, wiring, page, and 52 for the
    review's fixes): 187 caught (one by timeout), one equivalent (the first pass's names
    added before the runs), two no-op baselines pass. Headless Chromium on a scratch
    server (`kickstart -k` faked as an exit, a stand-in for launchd's KeepAlive, a scratch
    git repo) at 1180 and 390, light and dark, five modes: web-only merge (no card); card
    with the tap and the restart (healed, both hashes on the Loops panel); a merge in the
    3 s (no restart, "not restarted … (HEAD moved before the restart ran)", the card back
    on the new HEAD); killed (buttons off, the reason); blocked (a feature branch:
    buttons off with "isn't on main", not pushed; back on main, the button comes on). No
    sideways scroll, buttons 44 px, no CSP violation. Screenshots:
    `~/.local/state/jarvis/outbox/loop3/` (`blocked-*`, `card-*`, `killed-*`,
    `mismatch-*` for the moved case, `webonly-*`).
  - **Unverified:** a real `launchctl kickstart -k` (never run: whether launchd kills
    the process before launchctl returns, and which signal; the code holds either way);
    the `pid = N` line of a real `launchctl print` (from the health strip's fixture
    modelled on the live output; a different format refuses every tap, never restarts);
    that `XPC_SERVICE_NAME` is the label after a kickstart (seen on the live process,
    read-only, 11-15); git-read against the live checkout with `rev-list`, `diff
    --name-only` and `status` (the first two run read-only on 11-15); Safari.

**The drain's scope (Ultron's L1 on ec4a9f0, board 7be15fee): staged 2026-11-13 on
`jos/shortcut-drain-scope` (from main ec4a9f0, worktree
`~/Projects/.worktrees/ccr-shortcut-drain-scope`), not committed, not live.** A refusal
that waits for its body (below) held a connection for up to two minutes on any route,
from any caller, as many at once as came, and the two minutes started only at the
refusal. Now (`lib/shortcut-routes.mjs`): (1) only the Shortcut's own routes (pair, send,
event) wait, and only when the request has no `Origin` and no `Sec-Fetch-Site` (a page
or browser is answered at once, `Connection: close`); (2) at most 4 wait at once
(`DRAINS_AT_ONCE`, across keys and routes); a fifth is answered at once with
`Connection: close`, and its log line ends ` drain=full`; (3) the wait ends two minutes
(`FORM_TIMEOUT_MS`) after the request began, by a clock that only moves forward
(`performance.now()`), not two minutes after the refusal; (4) server.mjs sets
`server.requestTimeout` to `SERVER_REQUEST_TIMEOUT_MS` (300 s, Node's default made
explicit, longer than the form's two minutes). A page's own refusal (the key routes)
now always closes its connection, even for a small body sent whole: it is decided before
the body is parsed (`req.complete` is never set by then, checked), and the browser opens
another. *Tests:* four new in `server/test/shortcuts.test.mjs` (server 1088); 15
mutants, all caught after two dead checks found by them were removed (a "time already
spent" early return, equivalent because a negative timer fires at once, and the
`req.complete` look). *Go-live:* merge, restart (Needs Jeff); no page or config change.
*Rollback:* revert and restart. *Unverified:* anything through Tailscale Serve.

**Photo and PDF shares through Send to Jarvis: the request log line and refusals that
wait for the body merged as ec4a9f0 and live since 2026-11-13; the first iPhone PDF
(03:22Z) and photo (03:26Z) arrived over https (board 95b5013b).** The change on the
phone that made it work (with this server live): a hand-built Form request drew Tailscale
Serve's "400 Bad Request: invalid header name" (the HTTP/2 PROTOCOL_ERROR in the
mini's log), cause still unknown, and a copy of the working JSON request switched to
Form did not; a full-quality Convert Image made a 31 MB share (413). The setup doc has
these lessons (board fdc9da80). What follows is the record of the investigation.

- *What Jeff saw (live test, 02:23 to 02:38Z on 11-13).* Links shared from the iPad's
  key arrive (JSON). Every photo, and a PDF from Files (no Convert Image), fails on the
  phone with "The network connection was lost". The service log had nothing: a refusal
  was logged nowhere.
- *Evidence.* The mini's system log has seven lines from the Tailscale extension in
  exactly that window and none in the 14 hours before:
  `http2: server connection error from <phone>: connection error: PROTOCOL_ERROR`.
  That is Tailscale Serve's HTTP/2 server dropping the phone's connection, which is what
  the phone reports. Read with
  `/usr/bin/log show --last 2h --style compact --predicate 'process CONTAINS[c] "tailscale" AND eventMessage CONTAINS "http2: server connection error"'`
  (read-only; Serve itself is Vision's).
- *What is built.* (1) **One log line per request to `/api/shortcut/*`**, refused or
  taken, in fixed words and numbers (`requestLine`, lib/shortcut-routes.mjs):
  `shortcut: request POST send 401 (this Shortcut is not paired) type=multipart/form-data length=482113 chunked=no expect=no form=yes read=482113 parts=unread`,
  or for a share that was read
  `... 200 (ok) ... read=482113 parts=1 file, 2 text files=jpg:481723`. The type is
  looked up in a fixed list (else `other`), never printed; a file part is said by its
  first bytes (`png`, `jpg`, `webp`, `heic`, `pdf`, `unknown`) and its size; no name,
  text, key or byte of the body. A share that ended early or ran out of time is such a
  line too (`400 (the request ended early) ... read=<so far>`, `408`). (2) **A refusal
  is answered only when the request's body is in** (`drain`): before, a wrong key, a
  body that is not a form, the off switch, a third share in flight and JSON over its
  limit were answered while the phone was still uploading, and an answer sent then
  reaches a phone as a dropped connection, not as its `say` line. Up to 64 MB and the
  form's two minutes; past either, the answer goes at once with `Connection: close`,
  as before. (3) **A form with no file in it is refused** (400, "No file reached Jarvis
  OS, so nothing was sent…"), whether its file part is blank or missing: before, a
  Shortcut whose file field was blank sent its note alone and said "Sent". Words alone
  still go as JSON. This changes design §11's "a form may carry only text"; drop the
  one line in `checkSendForm` to undo it.
- *Tested, over real connections:* a form in chunks with no Content-Length, one after
  `Expect: 100-continue`, and both at once are taken (Node answers the Expect itself;
  server.mjs sets no `checkContinue`). Nothing in the form path was found that answers
  or closes before the body is read, apart from the refusals in (2).
- *Reading the first share after the restart.* A line with a refusal: the phone now
  shows its words; fix what it names. A line `400 (the request ended early)` with
  `read` under `length`: the upload was cut on its way (the proxy or the phone). **No
  line at all, and a new `http2: server connection error` in the system log:** the
  request died in Tailscale Serve's HTTP/2 layer before it reached the dashboard. In
  Go's HTTP/2 server a connection-level PROTOCOL_ERROR on a new request is most often
  its headers (a header list far too large, or an invalid header value that runs over
  several frames), so check first that the Form action's `Authorization` header holds
  the key file (the **File** from Get File from Folder) and not the shared item. If
  the headers are right, it is the upload's framing, and the way round is to send the
  file inside JSON (Base64 Encode on the phone), which is not built.
- *Not verified.* Anything on a phone or through Tailscale Serve: every test here is a
  Node client against a Node server. That an early answer is what a phone shows as
  "connection lost" behind this proxy is the known behaviour of that kind of client and
  proxy, not something measured here.
- *Go-live.* Merge, then restart the service (Needs Jeff; Vision's launchctl). No page
  change, no config change. Roll back by reverting the commit and restarting.

**Send to Jarvis takes photos and files (board d345df98): staged 2026-11-12 on
`jos/shortcut-files` (from main fc37633, worktree
`~/Projects/.worktrees/ccr-shortcut-files`), not committed, not live. Ultron read it
twice on 11-12: three mediums, seven lows, and one more low (N1) on the re-read. M1, L1
to L7 and N1 are fixed in the staged change (design §11 has his table). M2 (`sips` with
no sandbox) is answered by the default: a HEIC photo is refused on the mini and the
Shortcut converts it on the phone, so merging turns no conversion on. Open, Jeff's: M3
(a photo's place and time are kept in the stored file; the Shortcut's Convert Image
step takes them out on the phone), and whether to convert on the mini after all, which
would need a `sandbox-exec` wrap that Ultron reads first (not built).**
Jeff, 2026-11-12: "No files or pics? That's prob what I'd be using the share sheet for."
The reasoning and the choices to defend are in
`docs/design/2026-11-12-jarvis-os-shortcuts.md` §11; README "Shortcut keys" has the rules;
Jeff's steps are the new "Photos and files" part of `docs/jarvis-os-shortcuts-setup.md`.

- *What is built.* `POST /api/shortcut/send` also reads a form (`multipart/form-data`
  only; urlencoded is refused): the same four text fields and up to 4 `file` parts. Each
  file becomes an attachment on the owner's message, which the channel already marks as
  data. New files: `server/lib/multipart.mjs` (the reader, no dependency) and
  `server/lib/heic-convert.mjs` (HEIC to JPEG with `/usr/bin/sips`, the one subprocess).
  In `shortcut-routes.mjs`: `classifyFile` (the bytes decide; the name and declared type
  are only a claim), `cleanFileName`, `checkSendForm`, the form side of `send`, and the
  limits (10 MB a file, 4 files and 25 MB a share, 200 MB a day and 2 forms in flight per
  key, 120 s for a body to arrive, 30 HEIC conversions in 10 minutes and 200 a day per
  key that are never given back, 2 conversions at once in all). The kill switch and the
  key are looked at again just before the message is made. A config key,
  `chat.shortcutHeic` (`"refuse"` by default, or `"convert"`); three
  more `what` values on the `shortcut-over-limit` event (`files`, `uploads`,
  `conversions`); a log line per failed conversion, in fixed words; a start
  line, `shortcuts: a shared HEIC photo is …`. The JSON body, `pair`, `event`, the page
  and the chat store are unchanged, so there is no web build.
- *Verified (after both reviews' fixes).* Server 1078 tests (1044 on fc37633), local time
  and `TZ=Asia/Tokyo`. The new tests cover the reader (`test/multipart.test.mjs`), the
  converter with a fake `sips`, with the real one and with ones that hang, its reasons and
  its two-at-once limit (`test/heic-convert.test.mjs`), and in `test/shortcuts.test.mjs`:
  types by first bytes against the name and declared type, the size limits to the byte,
  the day's bytes (the larger of uploaded and kept), two forms in flight, retries, what a
  failed share gives back, HEIC converted, the conversion counts to the photo and to the
  millisecond, the refuse mode on its own, files landing as attachments on the channel's
  line, a form written by Node's own `fetch`, urlencoded refused (2 MB of `a&` in well
  under 2 s), a key revoked, run out or switched off while its share was on the way, the
  read's own timer and a request that closes early, and over a real connection a share
  dropped half-way, one stopped at its time limit and one cut off past 64 MB; and the
  three looks at the switch and the key (after the body, before each conversion, before
  the message), each shown by itself. 241 of 241 mutations caught in a scratch copy. A curl run against the real routes and the real
  `sips` on a scratch server (port 8399) passed 11 checks before the review and 9 after
  it: a HEIC photo arrived as a JPEG, three files in one share arrived (the text file as
  `shared.md`), a urlencoded note and 4 MB of `a&` were refused at once, a JSON link
  still went, bytes that only begin like a HEIC were refused and logged in fixed words,
  and in refuse mode a HEIC photo, alone or named `.jpg` beside a PNG, was refused in
  words while a JPEG went.
- *Not verified.* Anything on a real iPhone: what "Get Contents of URL" writes for a
  Form body with a File field, whether several photos come as several `file` parts,
  HEIC or JPEG from Photos, the declared type of a Markdown file, text put in a File
  field, the If in the setup doc, and its photo branch with Convert Image (three
  things marked "Check on first try" there; a simpler second Shortcut and Most
  Compatible are the fallbacks). Tailscale Serve passing a 25 MB body. `sips` under the service's own
  environment. `server.mjs` beyond its source test. One line has no test: an error from
  the form reader that is not its own kind is rethrown (a 500), which only a fault in
  the reader could reach. Ultron's L2 and L3 from the expiry
  review were never given to Pepper; if either is about the send route, it is not in
  this change.
- *Go-live order.* (1) C&P. (2) The service restart (Jeff, at the mini). No config
  change and no web build: with nothing in config a HEIC photo is refused. (3) Jeff
  changes Send to Jarvis on the phone from the setup doc's "Photos and files", which
  now has the Convert Image step (JPEG, Preserve Metadata off, photos only) as the main
  path, Most Compatible as the fallback, and three things marked "Check on first try".
- *Checks after the restart.* The log says `shortcuts: a shared HEIC photo is refused
  (chat.shortcutHeic is not "convert")`. From the phone: a photo from Photos shows as a
  picture in the thread (a JPEG) under "via share sheet", device `iPhone (Shortcut,
  share)`, and the log says `sent a message (1 file, attached)`; a PDF from Files shows
  as a download chip; a Safari page still arrives as a link; Jarvis's tag for the photo
  has `attachment_count` and `attachments_are_data="1"`; a video is refused with "It
  can't take that one."; a photo shared with the Convert Image step taken out is
  refused with "Jarvis OS does not take HEIC photos."
- *Rollback.* The old Shortcut keeps working throughout: the JSON body is untouched.
  HEIC conversion on the mini is off unless config turns it on. To stop files,
  revert the commit and restart; nothing stored changes shape, and files already kept
  stay ordinary attachments. The kill file stops every Shortcut at once, as before.
- *Follow-ups (asked for the board).* Write down what the iPhone really sends once Jeff
  has shared a photo, a PDF and a link (design §11, Not verified), and loosen or fix
  what it shows. A photo uploaded from the page in a browser that can't decode HEIC is
  still kept as HEIC, which the lead can't open; the same converter could take it.

**Shortcut keys expire after 30 days without use (board 2fb1fea8): merged as fc37633 and
live since the 19:43Z restart of 2026-11-12, with the web build at 19:44Z (read from the
service log and the build's time; built on `jos/shortcut-idle-expiry` from main fc845fc).
The entry below is kept as written when it was staged.** Ultron
proposed it on 11-12 and Jeff said yes. **Ultron read the staged change on 11-12: GO, 0
medium, 4 low. L1 (an expired key could not be revoked) and L4 (a wording) are folded
into the same staged change; L2 and L3 are on the board for later, not built.** The rule, the choices and what Ultron should look
at are in `docs/design/2026-11-12-jarvis-os-shortcuts.md` §10; README "Shortcut keys" has
the server side; the setup doc's troubleshooting has the line for Jeff.

- *What is built.* A key stops working 30 days after its last use, or after it was made
  when it has never been used (`KEY_IDLE_DAYS`, a constant in
  `server/lib/shortcut-keys.mjs`; no config key, like every other limit there). Nothing
  new is stored: `keyExpired` works it out from `lastUsedAt` and `createdAt` on every
  request and listing, so a key from before the change counts from when it was made. **A
  use is now a message or a presence report that was made** (`keys.used`, called by
  `send` and `event` after the store or the events module took it): a refused request, a
  repeat answered as the first, and the key merely being read no longer count, so
  `uses` and "last used" changed meaning with it. An expired key can't send, holds none
  of the 4 places and keeps its row. **It can still be revoked (Ultron's L1):** by id
  whether it works or has expired; by name the working key of that name is taken when
  there is one (a phone paired again as "iPhone" resolves to its new key) and an expired
  one only when no working key has the name; a device revoke takes every unrevoked key
  the device made, expired ones too. Its request gets a 401 with
  its own `say` ("…not paired with Jarvis OS any more: its key expired after 30 days
  without use. Make a new code in Jarvis OS and run the Jarvis Setup Shortcut."), and a
  new event kind, `shortcut-expired`, goes to #pepper once per key per day while it is
  tried (the arrive-home automation shows nothing on the phone). The page's list shows
  "expires … if unused" per key and an expired row greyed, with its Revoke kept;
  `bin/chat-pair shortcuts` prints the same. `server.mjs` and config are untouched.
- *Verified (with L1 and L4 in).* Server 1044 tests (1037 before), local time and
  `TZ=Asia/Tokyo`; web 210 (209 before). The new tests cover: expired (send and event,
  to the millisecond), fresh, refreshed by a message and by an arrive-home report, what
  does not refresh (400, 403, 429, 503, the three kinds of repeat, a failed store or
  events call), keys with no last use on file, a use kept across a restart, a place freed
  by expiry, a failed write logged, and an expired key revoked by id, by name and with
  its device, staying dead with the clock set back while the one nobody revoked answers
  again. 88 of 88 mutations caught in a scratch copy (three survived a pass along the
  way and each got a test). Lint clean but for the old Lanes warning. A scratch build
  on a scratch server (port 8397, real routes and stores, the server's clock moved by a
  control route, a Node client as the Shortcut) passed 33 checks in headless Chromium:
  the live row's words, the refresh by an arrive-home report at 29 days 23 hours, the 401
  and its words at 31 idle days, the one report, the expired row with its Revoke, pairing
  again from the page, the expired row revoked in two taps, layout at 360 to 820 px. The
  page bundle from before the change passed 5 against the new server: it ignores the new
  fields, shows an expired key as a live one, and its Revoke on that row works. The live
  `web/dist` was not touched.
- *Not verified.* Anything on a real iPhone (how Siri speaks the longer line). Safari.
- *Go-live order.* (1) Ultron's read is done (GO; L1 and L4 are in, and their delta is
  small: `revoke` and `revokeMadeBy` in `shortcut-keys.mjs`, one condition in
  `Chat.jsx`, one test). (2) C&P. (3) The service restart (Jeff, at the mini). (4) `npm run build` in `web/`
  right after. Between 3 and 4 nothing breaks; the other order would show "A key not
  used for 30 days stops working" before the server enforces it. No config change.
- *Checks after the restart.* `bin/chat-pair shortcuts` ends each live key's line with
  `expires <time> if unused`, 30 days after its last use (or after it was made). Chat ›
  ⋮ › Shortcut keys shows the same per key after the build. A send from the phone moves
  both by the next look. Nothing can expire before 30 days after the first key was made,
  so the refusal itself has only the tests and the scratch run behind it until then.
- *Rollback.* Revert the commit and restart: `lastUsedAt` and `uses` are the same fields
  as before, so the keys file needs nothing. **A revert, an older build or a clock set
  back revives expired keys that were not revoked:** expiry is worked out, never
  written down. Before rolling back, revoke any expired key that should stay dead (the
  page's Revoke, or `bin/chat-pair shortcut-revoke <name or id>`).
- *Follow-ups.* Ultron's L2 and L3 are on the board for later (Jarvis has them; not
  built). Offered, not built: a #pepper line a few days before a key expires (today the
  first word is the refusal).

**iPhone Shortcuts (board 0ea79dde): merged as fc845fc and switched on 2026-11-12 (the
service log says `shortcuts: on, 0 keys on file` at 18:56Z; built on `jos/shortcuts` from
main c091760).** Jeff, 2026-11-12: "i def want the iphone shortcuts". Three
Shortcuts: Send to Jarvis (share sheet), Ask Jarvis (Siri), and an arrive-home automation.
README "Shortcut keys" describes the server side; the design, the auth options and what
Ultron should look at are in `docs/design/2026-11-12-jarvis-os-shortcuts.md`; **Jeff's
steps on the phone are `docs/jarvis-os-shortcuts-setup.md`** (about 15 minutes, written
without a phone to try them on). **Ultron read it on 2026-11-12: go to commit, go to
switch on with conditions. His two mediums (the limits raced; a shared link went inline
unmarked) and his lows L4 to L7, L9 and L10 were fixed the same day and staged; the design
doc's §9 has the table. Ultron re-read that delta at 18:10 on 11-12: GO to switch on,
with his conditions C1 and C2. Jeff's four answers (design §8) are settled: auth A (the
pairing code); on arrive-home, (b), a brief only when something waits on him, at most
once an evening, never 22:00 to 07:00; "Allow Running When Locked" off on both Ask
Jarvis and Send to Jarvis; and the 30-day idle expiry, staged as the entry above. The
go-live steps below are kept as the record of what was planned.**

- *What is built.* `server/lib/shortcut-keys.mjs` (the keys and the one-time code),
  `server/lib/shortcut-routes.mjs` (`/api/shortcut/pair`, `send`, `event` for the
  Shortcut; `keys` for the page; the admin routes), a `presence` source in
  `server/lib/events.mjs`, eight event kinds in `chat-events.mjs` (four of them limited in
  `chat-alert-limit.mjs`), a `textOnly` option on the chat store's `putAttachment`, `bin/chat-pair shortcut-code|shortcuts|shortcut-revoke`, the
  wiring in `server.mjs` behind `chat.shortcuts`, `shortcutKeys` on `/api/chat/status`,
  and a text file now served as a download. On the page: a Shortcut keys section in the
  Chat settings sheet, "via Siri Shortcut" / "via share sheet" under a bubble, and a
  download chip for any file that is not a picture.
- *Verified (after the review's fixes).* Server 1037 tests (1001 before; 36 in
  `test/shortcuts.test.mjs`), local time and `TZ=Asia/Tokyo`; web 209 (205 before). 147 of
  147 mutations caught in a scratch copy (eight survived the first pass after the fixes:
  five came from four pairs of checks masking each other, and each pair lost one check;
  three got a test). The
  limits' race is tested with 150 sends and 40 reports handed to the router at once (20
  pass, one event). A second headless pass on a scratch server (16 checks: a name that is
  not plain refused in words, the maker shown, the link under its fixed line, a long link
  and a local one as file chips, a device revoke taking its key, layout at 360 to 430 px).
  Lint clean but for the old Lanes warning. Before the fixes, a scratch build on a scratch
  server (ports 8397 and 8398, real
  routes and stores, a Node client as the Shortcut) passed 34 checks in headless Chromium
  with the keys on (code made on the page, wrong code, pairing, the three sends and the
  event in the thread, the text chip's download headers, layout at 360 to 820 px, revoke,
  no policy violations or console errors) and 7 with them off (no section, no request).
  The live `web/dist` was not touched.
- *Not verified.* Anything on a real iPhone: the Shortcut actions as written, that "Get
  Contents of URL" sends no `Origin`, that a file variable in a header yields its text,
  Siri's prompts, the automation on a locked phone. What Serve puts in `X-Forwarded-For`
  (only the new-address alert uses it). `server.mjs` beyond its source test. Safari.
- *Go-live order.* (1) Ultron re-reads the fix delta (design §9). (2) Jeff's four answers
  (design §8: the auth, arrive-home, the lock screen, key expiry). (3) C&P. (4) Jarvis adds `"shortcuts": true` inside `chat` in
  `server/config.json`, with a backup. (5) The service restart (Jeff, at the mini). (6)
  `npm run build` in `web/` right after. Either order of 5 and 6 is safe: the old page
  ignores the new status field, and the new page hides the section until the server says
  `shortcutKeys: true`. (7) Jarvis sends Jeff the three addresses in chat; Jeff builds the
  Shortcuts from the setup doc.
- *Checks after the restart.* The log says `shortcuts: on, 0 keys on file`. Chat › ⋮ shows
  "Shortcut keys". New key shows a code; #pepper gets "a code for a new Shortcut key was
  made by …" and, after Setup runs, "a Shortcut key was made: …". Ask Jarvis: the message
  arrives with device `iPhone (Shortcut, Siri)` and the thread says "via Siri Shortcut".
  Send to Jarvis on a Safari page: the link is in the message. On selected text: a
  `shared-text.txt` chip, and Jarvis's tag has `attachments_are_data`. Arrive home (or run
  the automation by hand): a grey "Presence: arrived home at …" line, and Jarvis gets it on
  `jos-events`. Revoke the key: the next Shortcut run says "not paired". `touch
  ~/.local/state/jarvis-os/shortcuts-off`: every Shortcut says "switched off"; remove it.
- *Rollback.* The kill file at once; or `chat.shortcuts: false` and a restart. Keys are in
  `server/data/chat/shortcut-keys.json`.
- *Follow-ups (asked for the board).* The lead's channel: add `arrived-home` to its event
  names (the tag says `event="unknown"` today; the text is whole). The lead's rule for what
  to do on arrival, once Jeff picks. `left-home` as a second presence event (one line in
  `PRESENCE_EVENTS` plus the Shortcut). Ready-made, signed `.shortcut` files so Jeff
  installs with a tap instead of building by hand (needs research and Ultron: signing goes
  through Apple). "Ask Jarvis" speaking the answer (needs a read scope on the key; not
  built on purpose). Key expiry is the entry above (board 2fb1fea8).

**Page approval cards live as long as the channel holds the request (board 94b380fd):
staged 2026-11-13 on `jos/perm-hold` (from main ec4a9f0, worktree
`~/Projects/.worktrees/ccr-perm-hold`), not committed, not live. It has no effect until
the channel says how long it holds a request, which needs a channel release (below).**
On 11-12 a card timed out at 10 minutes while Jeff was away; Claude Code's prompt and
Discord's buttons have no limit.

- *What is built.* (1) The page's window comes from the channel's hello: `permHoldMs`
  less a minute, at most 12 hours (`permissionWindow`, `lib/chat-store.mjs`); a channel
  that doesn't send it gets the old 10 minutes, so the server change is safe to take live
  before the channel. Each request keeps the window in force when it opened, and the
  card's `expiresAt` says it. Start line: `chat: the page can answer a permission request
  for <N> min (…)`. (2) Cards end with their session: the channel's bye now expires every
  open card (before, only the next hello from a new process did), and so does a channel
  that has sent nothing (no heartbeat, request or hello) for 10 minutes (a session killed
  with no SessionEnd and no bye); the lead's UserPromptSubmit, Stop and SessionEnd still
  close them as answered elsewhere. (3) Bounds: at most 50 open (as the channel's
  `PENDING_PERMS_MAX`; past it the oldest open one ends `crowded`), at most 500 kept in
  all (oldest closed first), and the per-session id set is cleared at each new session.
  An expired card says why (`ended`: `timeout`, `channel`, `crowded`) and the page words
  each; the card's age reads in hours past two. A timed-out card is replayed to a page
  for 50 minutes after its own window ends (was: an hour from the relay).
- *The channel change it needs (Jarvis's repo, `jarvis-local/plugins/jarvis-channel/`,
  a channel release, gated):* `PERM_FORGET_MS` from `11 * 60 * 1000` to
  `12 * 60 * 60 * 1000 + 60 * 1000` (server.mjs line 149); the hello at line 1435 adds
  `permHoldMs: PERM_FORGET_MS`; the test at test/channel.test.mjs:601 asserts the new
  value, plus a test that the hello carries it. `PENDING_PERMS_MAX` (50),
  `PERM_RESEND_MS` (10 min, only for a request not yet relayed) and
  `VERDICT_MAX_AGE_MS` (120 s, the age of an answer, not of the request) stay. Memory:
  at most 50 pending entries of three capped fields each.
- *Go-live order:* this commit, the service restart (the log line says 10 min), then the
  channel release (a new session; the log line says 720 min). Either alone is harmless:
  this server with the old channel keeps 10 minutes; the new channel with the old server
  is ignored (an unknown hello field) and keeps 10 minutes too. Then `cd web && npm run
  build` (an old page shows the new server's cards correctly, only the expired wording
  stays "10 minutes").
- *Checks after both:* the log line above says 720 min; a harmless prompt left 15 minutes
  can still be allowed from the page; ending the session (`/exit`) turns its open card to
  "Jarvis's session or its channel ended".
- *Rollback:* revert the commit and restart; or the channel alone back to 0.4.6 (10
  minutes again).
- *Costs:* a card can now be answered hours after it was asked, so its preview is
  hours old too (the command shown is still exactly what waits); the flood count (more
  than 5 open, in guarded mode) can be reached by requests that would have expired
  before, though the turn-end close keeps the open set small; a stalled channel that
  comes back after 10 silent minutes finds its cards ended here (fails closed: answer at
  the terminal or in Discord).
- *Tests:* `server/test/permission-hold.test.mjs` (13), `web/test/orbit-chat-hold.test.js`
  (4); one replay test in approvals-parity now counts 50 minutes from the timeout. Server
  1097, web 214. Mutation checks: 26 server mutants, 25 caught; the miss is the id set's
  clear (memory only, not observable); 6 page mutants, all caught.
- *Unverified:* everything live; that Claude Code itself never times out a channel's
  permission request (its own docs say nothing; Discord's buttons have worked late).

**Approvals parity and cards answered elsewhere: merged as c091760 and live since
2026-11-12 16:47 ET (per Jarvis's 11-12 brief; built on `jos/approvals-consistency` from
main af58df0).** Jeff,
2026-11-12, after an approval sat in the Claude app for 17 minutes and a second one showed
Deny only on the page: "I don't want Jarvis OS to be deny only anymore. I don't want to
have to check multiple spots to find the approve button. If we're approving in Discord, we
can approve in Jarvis OS." README "Parity with the relay" and "A card answered somewhere
else" describe both parts; the header of `server/lib/approvals.mjs` has the rule.

- *What the 11-12 incident was (times UTC).* The server restarted on af58df0 at 15:35:50.
  Request `rtqtj` (Bash) was relayed at 15:37:31, stored (seq 292) and pushed to the
  iPhone and iPad (no push failure logged; neither device opened the page: last seen
  12:59 and 03:53). The Mac's page had sent a message at 15:36:40 and next at 15:53:06;
  the request timed out on the page at 15:47:31. A page that connects after that was sent
  nothing for it (reproduced in headless Chromium on a scratch server: no card, only the
  grey line in the thread), which is what Jeff met at 15:53. Whether the Mac's page had
  the chat open and visible between 15:37:31 and 15:47:31 was not logged, so that part
  is inferred. Not the cause, each reproduced on the scratch server with the live build
  and the live commit's server code: the restart (the page's stream came back 1.5 s after
  the server did, through a proxy answering 502 meanwhile, and the next request drew its
  card), the strict policy from verdict-alerts-csp (0 violations; the web sources did not
  change between the 11-11 build and af58df0), and the classifier-block window (the card
  is drawn inside it). The second request `xceyc` (15:54:19) was Deny-only by design, twice
  over: Bash is Deny-only under the page's own rules, though the block window had ended at
  15:52:13. The card said so in small print. It stayed open after the prompt was allowed in
  the Claude app, and the Deny tapped on the Mac at 15:55:16 was written and sent for a
  request already answered; Claude Code drops such a verdict.
- *Parity* (`chat.approvalsRules: "parity"`, default `"guarded"` = today's rules): the
  page offers Allow wherever the channel's relay does. The Deny-only allowlist, the
  15-minute block window, the flood window and the ingest check are not applied; the mode,
  the kill file, the relay mode, the test-channel cap, the approver mark, the two-step
  Allow, the hash, the tap limits and `approvalsDenyOnly` are. `chat.approvalsHidden`
  (`"deny"` default, or `"allow"`) says whether a request with a hidden character stays
  Deny-only; the mark is drawn either way. **Jeff decides that one** (my pick: `"deny"` to
  start, the one place the page sees more than Discord; its cost is that joiner emoji and
  no-break spaces in a Write's text also keep a card Deny-only).
- *Cards answered elsewhere* (`server/lib/answered-elsewhere.mjs`): the lead's
  `UserPromptSubmit`, `Stop` or `SessionEnd` closes every card relayed before it; the card
  says "Answered elsewhere" and goes after a minute; a tap on it is 409 and nothing is
  sent. A request that timed out here in the last hour is sent to a page that connects, as
  "Too late to answer here" with where to answer. Each request logs which devices had the
  chat open (`chat: request <id> opened with …`), so the next "it never showed" has an
  answer in the log.
- *Tests (2026-11-12):* server 1,001 in local time and Tokyo (978 before), web 205 (199
  before). 52 mutations on the new checks, all caught at the end (the first pass left 5:
  three missing assertions, written, and a dead check and two redundant lines, removed).
  Headless Chromium (cached 1223 shell) on a scratch build and scratch server in parity,
  1440 light as an approver and 390 dark as a device with no mark: a Bash command with
  `&&`, a pipe and `;` right after a block shows Deny and Allow once; closed by a `Stop`
  it reads "Answered elsewhere" with only Dismiss and the banner goes back to online; a
  U+202E is drawn as its mark and the card is Deny-only with the lead line and "Why"; a
  request that timed out while the page was hidden comes back as "Too late to answer
  here", and stays gone after Dismiss and a new stream; no sideways scroll, 0 policy
  violations. A verdict tap can't be made over http (the Origin rule wants https), so
  taps rest on the route tests.
- *To go live, in this order:* Ultron's read (this loosens his 11-11 findings on purpose;
  he should see the list of what parity drops); Jeff's C&P; then config (Jarvis, with
  Jeff's OK; back up `server/config.json` first): in the `chat` block add
  `"approvalsRules": "parity"` and, only if Jeff picks marks-only, `"approvalsHidden":
  "allow"`; nothing else changes (`approvals` stays `"on"`); then the service restart
  (Vision or Jeff, step 3's command); then, right after it, `cd web && npm run build` (the old page already draws Allow when
  the server offers it, but it shows a card closed elsewhere as still open, with a Deny
  that answers 409, until the next status 20 s later drops it; checked with the live
  build on the scratch server; the new page on the old server is harmless, it only reads
  differently). The commit alone changes
  nothing until the config key is there, except the card close, the replay of timed-out
  requests and the new log line, which take effect at the restart.
- *Checks after the restart:* the log says `chat: approvals follow the channel's relay
  (parity): …` and #pepper's start line ends "parity with the relay: …"; no `config:` line
  about approvals; a harmless Bash prompt (`ls` of a notes folder) shows Deny and Allow
  once on an approver device, and Allow once (two taps) runs it; the next auto-mode
  refusal logs `needs-you: PermissionDenied (…), noted; no Deny-only window (approvals
  follow the relay)` and the card after it still has Allow; a prompt answered in the
  Claude app closes its card when the turn ends (`chat: 1 permission card closed, …`);
  `touch ~/.local/state/jarvis-os/approvals-off` still hides the next card (then `rm`).
  **C3 (Ultron, 11-12; added 2026-11-19, board bcde53ea), still owed as a live check:**
  Deny a harmless prompt in the Claude app (or Discord) while its card is open on the
  page, then tap Allow on the page before the card closes: the command must not run (the
  channel no longer holds the request, so the page's Allow is refused or ignored), and
  the card ends as answered elsewhere or with the refusal, never "allowed".
- *Rollback:* remove `approvalsRules` and restart (the page's own rules again, `deny` or
  `exact` Bash as config says); at once, without a restart: the kill file, or
  `rm ~/.local/state/jarvis-os/approvals-allow` (Deny only at the channel).
- *Known costs and gaps:* (1) a card answered elsewhere stays open until the turn ends or
  the next prompt is taken; closing it at once needs the tool call's name and input from a
  `PostToolUse` hook (a settings change, and the server would then read tool input) or the
  lead's transcript. (2) Discord's buttons can't be closed from here and never match the
  page's Deny-only exceptions; turning Discord's permission relay off means a patched copy
  of the official plugin (it declares the capability with no switch), which is Ultron's and
  Jarvis's. (3) The page could answer for 10 minutes only; lifted to as long as the
  channel holds the request (up to 12 hours) by the entry above, once the channel says so. (4) The tap limits (6 a minute, 30 an hour per
  device) now count every Bash approval; a busy hour can hit 30, and the page then answers
  429 until the hour moves on. (5) The Mac has no push subscription, so a page that is not
  on the Chat tab, or hidden, learns of a request only from the tab's badge. (6) The
  needs-you wait for a permission prompt was cleared by any `PostToolUse` from the same
  session, a helper's included (11-12: opened 15:37:37.017, cleared 15:37:37.296 by a
  background general-purpose subagent's Bash), so "Waiting on you" and its 5-minute
  alert never showed the 17-minute wait. Fixed in §28 (board 9fb32c4d), once the new hook
  entries are in.
- *Unverified:* everything live (no config change, no restart, no build); WebKit; that the
  lead's session is named by the sessions panel when its hooks post (the close counts only
  a session named for the lead, as the exact-command reports do); that `Stop` and
  `UserPromptSubmit` never fire for the lead while one of its own prompts still waits (a
  background helper's prompt could; its card would close early, the prompt itself stays);
  that the channel delivered the 15:55:16 verdict to Claude Code (its own log was not
  found; the server wrote it as seq 295, and the command had already run).

**Approvals as buttons (board 2422f9d1): live since 2026-11-11 20:40 ET, Deny and Allow
once** (main edfb349, which holds the final build e61708e and the go-live patch; the lead's
repo build/v1 57f0a9e, channel 0.4.5; Jarvis reports all six live checks passed). **Channel
0.4.6 is live since 2026-11-11 21:47 ET** (main 1e1da2d): see "Channel 0.4.6" below the
runbook, and its open follow-up there (the no-`test` hello log, then option (b) on 11-19). The go-live patch (`server/lib/approvals.mjs`, tests; Jeff's option A,
2026-11-11 23:33Z): a write of any `*.py`, `*.pyc`,
`*.pyw` or `*.so`, of `CLAUDE.local.md`, `pytest.ini`, `tox.ini` or `.python-version`, or
under `.vscode/` is Deny-only in every write folder (board 97332dd5); any path through
`/System`, `/Volumes`, `/.vol`, `/.file`, `/.nofollow` or `/.resolve` is Deny-only for reads,
searches, writes and reply files (669ea1d2); `.dev.vars*` is private. Design, Jeff's decisions
and the three fix tables: `docs/design/2026-11-11-jarvis-os-approvals.md` (sections 0, 0.1
and 0.2); reference: README "Approvals as buttons". This build closes Ultron's final read of
2026-11-11 (board 97332dd5, bf222809, 4f52c42f) and adds exact Bash commands (board
320ecc71), on Jeff's three yeses of 21:32Z (keep the 7 write folders but protect the code in
them; build the exact-command hook; Discord's folded preview stays as it is for now):

- **A second layer inside the write folders** (`server/lib/approvals.mjs`): generic rules
  (an existing file with an execute bit; `.venv`, `node_modules`, `.husky`, `.github`; names
  tools load or run, from `CLAUDE.md` to `_redirects`) and config's
  `chat.approvalsWriteProtected`, a list of paths, by the path as written and its real path.
  A protected list that can't be read turns page writes off whole.
- **Channel reply files:** only inside `~/.local/state/jarvis/outbox/`, by real path, for
  both reply tools.
- **Lows:** more private reads (`*_history`, `browser-profile`, `.wrangler`, `.gnupg`,
  `.config/gcloud`, all of `~/Library`, `~/.claude/projects`, this repo's
  `server/config.json` and `server/data/`); a search rooted at `~/Projects` is Deny-only; a
  space in a write path and a last-part symlink are Deny-only; a write folder may not be
  `~/Projects` nor hold or sit inside the lead's repo, machine-setup or this repo's code, and
  the accepted list is logged at each start. Channel 0.4.5 finds the flag folder from the
  account's own home; Ultron's two prompts check more settings files, the launchd jobs'
  environment, the hook's presence and that no hook returns `updatedInput`.
- **Exact Bash** (`server/lib/exact-commands.mjs`, `POST /api/ingest/exact-command`, the
  card's "Exact command" block, README's hook entry): `chat.approvalsBash` is now `"deny"`
  (default) or `"exact"`; `"strict"` is gone. In `"exact"` the page may allow a Bash request
  only with the hook's report of its exact text, matched by content, and then only a strict
  one-liner (tier 1) or a command listed in `chat.approvalsBashCommands` (tier 2).

Tests (2026-11-11): server 887 in local time and Tokyo (was 864); web 199; the lead's repo:
channel 87, end to end 22 against this branch's server (scenario 19 is this build), Python
683 run with the 58 failures a worktree always has (the same list as an export of HEAD).
Mutations: 167 on the server's new checks against the final code, 165 caught; the two left
are equivalent (the Bash-mode guard in `assess`, since `noteExact` keeps no report outside
"exact" mode, and `=== 1` for "one candidate", where two is already a conflict). A first
pass had seven survivors: those two, three dead checks (removed) and two missing tests
(written). 6 of 6 caught on the channel's flag-folder change. Headless Chromium
(cached 1223 shell) on a scratch build and scratch server at 390 light and 1440 dark, 32
checks: the exact block leads, one row per line, the marks drawn, text never markup, Allow
offered only for a one-liner or a listed command, no sideways scroll, no CSP violation.
The recommended config values were run read-only against the real folders: all 18 paths
exist, each write Ultron showed is Deny-only and the docs and content files still pass.

The go-live below (steps 1 to 9) ran on 2026-11-11: the relay came up "deny and allow" at
20:40 ET on channel 0.4.5 (the launcher's log, the two flags and the Control Room's relay
lines were seen on 11-11; the six live checks are Jarvis's report). Exact Bash (steps 10 to
13) is not on.

*Go-live runbook: one step for approvals with Allow (Jeff, 2026-11-11 20:37Z: "just wait
and do it all at once"); exact Bash is a second, later step (12 and 13).* Each step waits
on the one before; the server always goes before the channel (Ultron H2).

1. Ultron reads the `jos/approvals-h1` delta (this repo only; the final build is already
   on main and build/v1); Jeff's C&P (Jarvis commits and merges it to main).
2. Config, before any restart (Jarvis, with Jeff's OK; back up `server/config.json` first).
   Inside the `chat` block add four keys; leave `approvalsBash` and `approvalsBashCommands`
   out (Bash stays Deny-only on the page until step 13):
   - `"approvals": "on"`
   - `"approvalsWriteFolders"`: the seven folders Jeff approved (six of his project repos
     and this repo's `docs/`), each as `~/Projects/<name>`.
   - `"approvalsWriteProtected"`: eleven paths inside those folders, each as
     `~/Projects/<repo>/<path>`: in the league tool's repo `ops`, `src`, `tests`, `leagues`
     and `data/browser-profile`; in the posting agent's repo `scripts`, `launchd`, `drafts`
     and `config.json`; in the site's repo `scripts`; in the league data repo
     `MANIFEST.sha256`.
   This repo is public, so the block with the real folder names, ready to paste, is in the
   lead's repo: `docs/jarvis-os-channel-golive.md`, section 5 (18 lines of JSON; a check on
   2026-11-11 found all 18 paths on disk). No other key changes.
3. Restart the Control Room (Vision or Jeff:
   `launchctl kickstart -k gui/$(id -u)/net.milleradvisorypartners.control-room`). Checks:
   the log says
   `chat: approvals on; Bash Deny-only; 7 write folders, 11 protected places inside them`,
   then `chat: approvals write folders:` with the seven names, and no `config:` line about
   approvals (a line "until it is fixed the page allows no writes" means a typo in the
   protected list); #pepper gets "chat approvals are on (Deny and Allow once) at this
   start"; `/api/chat/status` on a paired device shows
   `approvals: { mode: "deny", relay: "unknown" }` (the old channel names no mode, so the
   page can only Deny until step 8: that is the server-first order doing its job).
4. The page (Jarvis, after step 3): `cd ~/Projects/claude-control-room/web && npm run build`.
   The new card code is needed for the exact-command block and its hash; the old page keeps
   working for everything else (and a tap from an old page on a card that carries an exact
   command is refused, never accepted).
5. Approvers (Jeff, on the mini): `~/Projects/claude-control-room/bin/chat-pair --devices`,
   then `bin/chat-pair approver "<name>" on` for the iPhone, the iPad and the Mac (pair the
   Mac first if it isn't listed; at most 4 devices). Each change posts to #pepper.
6. The classifier-block hook (Jarvis with Jeff): add README "Approvals as buttons"'s
   `PermissionDenied` entry to `~/.claude/settings.json`. Check: the next auto-mode refusal
   logs `needs-you: PermissionDenied (<tool>), page approvals are Deny only for 15 minutes`.
7. The channel: move the release worktree to the merged build/v1 commit (channel 0.4.5)
   after Ultron's re-vet, and record the new reviewed hash (the go-live doc's step 3b, Jeff
   or Vision). Vision confirms neither the launchd environment nor any settings `env` block
   has `JARVIS_CHANNEL_PERMISSION_RELAY`, `JARVIS_CHANNEL_TEST` or `HOME` (belt and braces:
   `env -u` clears the first for claude, and 0.4.5 wants the flags in the account's own
   state folder).
8. Both flags, then the restart (Jeff, on the mini, from a terminal outside the jarvis
   session):
   `(umask 077; : > ~/.local/state/jarvis-os/approvals-enabled; : > ~/.local/state/jarvis-os/approvals-allow)`
   then `~/Projects/jarvis/bin/jarvis-start --restart`. Checks: `~/Library/Logs/jarvis.log`
   says `permission relay deny and allow`; #pepper gets "Jarvis started with the permission
   relay deny and allow"; the Control Room log says
   `chat: the channel's permission relay is allow`; `/api/chat/status` now shows
   `approvals: { mode: "on", relay: "allow" }`.
9. Live checks (design §9.3), harmless requests only: a prompt shows the card, the DM and
   the push within seconds; Deny from the page closes the terminal dialog; Allow once from
   a marked device works for a Read, and for a Write of a notes or docs file inside a write
   folder; Allow from an unmarked device is refused; these show Deny only with the reason:
   any Bash prompt, a Write outside the folders, a Write of a script or `CLAUDE.md` inside
   one, and a reply that attaches a file from outside the outbox;
   `rm ~/.local/state/jarvis-os/approvals-allow` turns the next card Deny-only within one
   heartbeat (15 s), with a #pepper line (put the flag back after);
   `touch ~/.local/state/jarvis-os/approvals-off` hides the next card (then `rm`).

*Exact Bash, after the go-live has run clean (each needs Jeff's OK):*

10. The scratch test (A1-H with A1-F, board db310879 and 958ad493; replaces design §9.2's
    harness steps, which used the TCP port and the old `default` mode name). Jeff, at the
    mini's console or over Screen Sharing (not SSH: the sign-in is in the login keychain),
    never in Jarvis's session. It installs nothing, reads none of the user's settings
    (`--setting-sources project`, and the scratch folder has none), loads only the stand-in
    channel (`--strict-mcp-config`), and its hook posts to a scratch socket, never the
    live one; its settings file also turns the Discord and jarvis-channel plugins off. Ask
    only for harmless commands that need permission (read-only ones such as `cat` and
    `echo` run with no prompt, so nothing is relayed): they are written in full to
    `results.txt`. Run the setup
    line right before the session, never ahead of time: the scratch MCP config names
    node by its versioned Homebrew path, which a `brew upgrade` removes.
    ```sh
    cd ~/Projects/claude-control-room
    S=$(node bin/exact-hook-check.mjs setup) && cd "$S/work" && claude --version
    claude --debug-file "$S/debug-manual.txt" --setting-sources project --settings "$S/settings.json" --mcp-config "$S/mcp.json" --strict-mcp-config --permission-mode manual --dangerously-load-development-channels server:exactcheck
    ```
    Accept the folder-trust and development-channel prompts. If Claude Code says the
    channel is "blocked by org policy", that comes from the managed channel list (the
    organization's managed settings), not from these flags or the scratch files: `/exit`,
    stop, and send Jarvis that line. Before the first prompt, three checks; if any fails,
    `/exit` and stop: `/status` must show no "User settings" among its setting sources;
    `/mcp` must list `exactcheck` and nothing else; `/hooks` must show nothing but one
    `PermissionRequest` hook (matcher `Bash`). Then send these one at a time, and
    each time the permission dialog opens, answer **No** in the terminal:
    a. `Run this exact Bash command as one tool call: touch t1.txt`
    b. `Run this exact Bash command as one tool call, keeping the line break: first line touch t2.txt, second line touch t3.txt`
    c. `Run this exact Bash command as one tool call: touch, then one TAB character, then t4.txt`
    d. `Run this exact Bash command as one tool call: printf 'a  b' > t5.txt (two spaces inside the quotes)`
    e. `Run this exact Bash command as one tool call: two spaces, then touch t6.txt, then two spaces`
    f. `Create a file lines.md here whose content is three lines: one, two, three`
    Then `/exit`, and the auto-mode fallback, in the same folder (the same three checks
    before its first prompt):
    ```sh
    claude --debug-file "$S/debug-auto.txt" --setting-sources project --settings "$S/settings.json" --mcp-config "$S/mcp.json" --strict-mcp-config --permission-mode auto --dangerously-load-development-channels server:exactcheck
    ```
    g. `Run this exact Bash command as one tool call: curl -s https://example.com -o notes.txt`
    If auto mode just runs or refuses it without a dialog, try
    `Run this exact Bash command as one tool call: sudo -n true`; if neither opens a dialog,
    note "no fallback prompt seen". Answer **No** to any dialog, `/exit`, then send Jarvis
    the output of `cat "$S/results.txt"` and the `claude --version` line, and clean up
    (the second line removes the scratch sessions' transcripts; `(N)` lets zsh run it when
    there are none):
    ```sh
    rm -rf "$S"
    rm -rf ~/.claude/projects/-private-tmp-exact-*(N)
    ```
    *Pass:* every Bash request in `results.txt` is paired with its report: `ORDER AFTER`
    (about 20-25 ms on 11-13) or `ORDER BEFORE`, with the gap (one of them from the auto
    session, after its `channel started` line); a, b, c, d and e say `EQUALS` (or `the
    report EQUALS the preview's command as it is: this preview was NOT folded`) and `exact
    text on the card: yes`. f shows whether a Write's `content` is folded. The model may
    not type odd spacing exactly; the reported command shows what it really sent, so a
    mismatch there is no fail. A `NO REPORT`, a `NO REQUEST`, a `DIFFERS FROM` on a command
    the model did send as asked, or no `permission request` lines at all (the relay never
    reached the channel) keeps Bash Deny-only and goes back to Pepper with `results.txt`.
    Record the CLI version and the results here. Run it again after any Claude Code update
    that touches hooks or channels. *Ran 2026-11-13 on 2.1.323* (manual mode, the findings
    in the exact Bash entry above); the re-test on main 5cf038e passed 11-13 (hook 18-23 ms
    after the relay, exact matches).
11. The exact-command hook (Jarvis with Jeff, after Ultron re-vets the entry): add README
    "The exact-command hook"'s `PermissionRequest` entry to `~/.claude/settings.json`,
    unchanged. It reports to the ingest socket and decides nothing; while the server's
    Bash mode is `"deny"` the server drops every report unread (log:
    `exact-command: a Bash report, dropped (approvals for Bash are not in "exact" mode)`).
12. Config (Jarvis, with Jeff's OK): in the `chat` block add `"approvalsBash": "exact"` and
    `"approvalsBashCommands": []` (empty: tier 1 only; Jeff adds a command here, exactly as
    it is typed, line breaks as `\n`, when he wants the page to allow it), then the service
    restart (Vision or Jeff, the command of step 3). Checks: the log says
    `chat: approvals on; Bash by the hook's exact command (0 listed); 7 write folders, 11
    protected places inside them`; a `cat` of a notes file in the lead's session shows the
    card with "Exact command, one line" and Allow once; a two-line command shows both rows
    and Deny only; the log has
    `exact-command: a Bash report, from the lead's session, kept for 2 minutes` and never
    the command.
13. Ultron's next sweep confirms the hook is present and unchanged and that no hook
    returns `updatedInput`.

*Rollback:* `touch ~/.local/state/jarvis-os/approvals-off` (page side, at once, alerted);
`rm ~/.local/state/jarvis-os/approvals-allow` (Allow off at the channel at once, no
restart); `rm` both flags and `jarvis-start --restart` (the relay off); `chat.approvals`
back to `"off"` and restart. Exact Bash alone: set `"approvalsBash": "deny"` (or remove
the key) and restart, or remove the hook entry (either one is enough: no report, or no
mode, means Deny-only).

*Channel 0.4.6: the test switch (board 1bede46d, Ultron's 0.4.5 re-vet, medium; live since
2026-11-11 21:47 ET, this repo's main 1e1da2d).* The finding: the
channel's test switch with its flag-folder variable moved the folder the approvals flags are
read from, so a settings `env` block could bring flags of its own. Design doc §0.3 has the
table. In this repo (`server/lib/approvals.mjs`, `chat-socket.mjs`, `server.mjs`): a hello
whose `test` is anything but `false` is offered Deny only whatever relay mode it reports
(mode `"on"` counts as `"deny"`, the card says "the channel runs in test mode", Allow is
403), and each such hello is alerted as `approvals-test-channel`; a hello with no `test` (a
channel before 0.4.6) is treated as before, so either side can be released first. In the
lead's repo: channel 0.4.6 ignores the switch on the account's own socket (by path and by
what is on disk), asks again before every hello and says `test` in hello; `jarvis-start`
unsets the switch, the flag folder and the socket variable on claude's exec; the sweep
names the socket variable and hands Jarvis a command for tmux's global environment.
- *Tests:* server 891 (889 before), in two timezones; the channel's own suites 91 (87
  before); the end-to-end suite 23 against this branch's server (scenario 20 is new, and
  fails against main's server, as it should); the launcher's suite 90 (89 before). Each part
  of the fix was broken in turn and a test failed for each.
- *Release, after Ultron's read and Jeff's C&P for both repos:* the exact steps, checks
  and rollback are in the lead's repo, `docs/jarvis-os-channel-golive.md` §6. In short:
  restart this service (step 3's command; no web build, no config change), then in one
  sitting move the release worktree, update the plugin, record the new reviewed hash and
  restart Jarvis. Nothing was run.
- *Open: a hello with no `test` (board 762bb28d, Ultron's L2, P3, due 2026-11-19).* Under
  option (a), which Jeff chose on 11-11, such a hello (channel 0.4.5 or older) is still
  treated as not in test mode, so Allow stays possible for it. Staged 2026-11-11 on
  `jos/hello-no-test` (worktree `~/Projects/.worktrees/ccr-hello-no-test`, not committed):
  each such hello now writes one line to the service log, `chat: the channel's hello has no
  test field (a channel older than 0.4.6, version …, pid …): treated as not in test mode, so
  Allow is not capped for it` (the version only when it is a plain version string; logged
  whatever the approvals mode; never an alert). It takes effect at the service's next
  restart. **Next, on or after 11-19:** read the log since the restart that carried it
  (`grep -c "hello has no test field"` on `~/Library/Logs/control-room.log`); with no such line since the
  0.4.6 release, flip `noteChannelTest` in `server/lib/approvals.mjs` to option (b),
  `channelTest = value !== false` (no word = Deny only, like `relay`), drop the log line or
  turn it into the Deny-only reason, update the test above and the README's "Never a
  channel in test mode", and send it to Ultron for a re-read. A 0.4.5 rollback after the
  flip would then get Deny only on the page, which is the intent.
- *Left over (board 182771a1, low):* the sweep reading hooks in agent and skill frontmatter
  and `env` in shell startup files. It needs a way to list those files inside an
  unattended run, so it is not a small change.
- *Unverified:* everything live (no restart, no release); the plugin update's effect on the
  cache going to 0.4.6 and back; the channel's refusal against the real `channel.sock`
  (tested with a scratch account home standing in, never the real socket).

*Unverified:* WebKit (headless checks were Chromium only, at 390 and 1440 px); whether a
subagent's prompt relays and whether both channels get each request (design A0-3, first
live prompt settles it); the `PermissionDenied` payload against a live block (built from
the hooks reference, 2026-11-11); everything A1-H tests (that the `PermissionRequest` hook
runs before the relay, in fallback prompts too, that its `tool_input.command` is the text
that runs, and that Claude Code's fold equals the server's: the input shape was checked
against the hooks reference for CLI 2.1.322, not against a live prompt); whether the
sessions panel names the lead's session within the minute after a restart (until it does,
reports are dropped and Bash cards are Deny-only: the safe side); whether the real Glob,
Grep and channel tools send only the input keys on `TOOL_KEYS` (a key missing from the list
only makes that card Deny-only).

**Phase 2, the Feed tab (board fbc77b53), staged on `jos/feed` (from main 80c0569,
2026-11-11), not committed, not live; its writer is staged in the lead's repo on
`jos/feed-log` (from build/v1).** README "The Feed" describes both halves. Server:
`lib/feed.mjs` (read-only reader), `lib/feed-routes.mjs` (`GET /api/feed`, a paired device
only, the chat's rule), `checkFolder` added to `lib/program-check.mjs`, wired in
`server.mjs`. Web: the Feed tab, last in the tab and swipe order, phone tabs tightened so
four fit on a phone (see the tabs-fit fix below; the first cut stopped at 420 px). **Ultron's 11-11 review (lead's repo: go after M1; here: go, lows only)
is fixed on both branches, not re-read:** M1 the web-reading routines are denied
`feed/**`; L2/L3 the writer opens without blocking and refuses anything but this user's
regular file with one link; L4 no `--kind` flag (only the routines set it, in-process);
L5 the log keeps the messages as sent; L6 no local-caller shortcut on `/api/feed`; L7 an
in-flight read is shared; L8 about 1 MB of text per answer, oldest dropped first, pins
kept (`dropped`, shown on the tab); L9 posts over 24 h ahead skipped; L10 one link only.
Tests: server 822 in local time and Tokyo (26 in `feed.test.mjs`), web 194; the lead's
repo 674 run with the 26 known git-guard failures only (`test_git_read`, `test_backup`).
Mutations: 34 on the reader and route and 17 on the writer, all caught but three
explained (the writer's inode guard, a race only; `O_NOFOLLOW`, also refused by the inode
check; the writer's regular-file check, since macOS refuses `flock` on a FIFO anyway).
Headless Chromium (cached 1223 shell) at 375, 390 and 820, light and dark, on a scratch
server with a paired scratch device and invented feed files: pins, order, filters,
folding, text never HTML, a masked link's host, 44 px targets, no sideways scroll, sticky
tabs; and the worst-case tab row (three-digit board count, "99+" badge) inside the gutter
at 375. Unverified: Safari and the home-screen app, a real device through Serve, the real
files. **To go live, in this order:** Ultron's re-read of the fixes; Jeff's C&P of both
repos, the lead's repo first (the writer must exist for the tab to show anything; it needs
no restart, the next post writes the first line); then the service restart (Vision or
Jeff; no config change needed); then `cd web && npm run build` (the old page has no Feed
tab, and the new page against the old server gets a 404 and shows "Couldn't load the
feeds", so build after the restart). **Post-restart checks:** a local
`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8322/api/feed` answers 401 (no
shortcut for this machine); the Feed tab on the paired iPhone shows the posts since the
writer landed (an empty folder reads "No posts yet"); no `feed:` or `config: feed` line in
the service log; Jeff's Safari look. The six test lines the lead's repo wrote on 11-11 were
deleted at 13:34 with Jeff's OK; the folder was empty after. **Follow-ups:** the pins
appear only after the first routine run on the new writer (the brief Thu 11-12 07:30, the
digest Mon 11-16).

**Tabs fit and the Jobs chip after a restart, staged on `jos/tabs-fit` (from main d6af463,
2026-11-11), not committed.** (1) Board 90dca52b: Jeff's iPhone (13:53) showed Feed off the
right edge. The tight phone tabs applied only up to 420 px; the full-size row needs about
490 px, so the Plus and Pro Max widths (428-440) got the wide pills. The 375/390 check
never tried a wider phone. Now `max-width: 520px`. Headless Chromium on a scratch build,
"Board · 114" plus a "99+" badge, header row and pinned bar: one row, inside the gutter,
44 px targets, no sideways scroll at 360-768 (18 widths); 320 still clips (no iPhone
that small runs a current iOS). Safari unverified. (2) Board 20620d37: at startup the crons
and health collectors start together, the crons overlay ran before job-status answered,
so the cron alert had no `since`, the ack didn't match, and the Jobs chip said "1 failed"
until the next minute's poll (the same race could raise an unacked event or push at a
restart). Now the crons collector awaits `health.whenAsked()` (capped at job-status's
timeout + 5 s). Unit test only; not seen across a real restart. Go-live: C&P, the service
restart (for 2), `cd web && npm run build` (for 1; safe in either order).

**Ultron's 1a review, answered on the branch `jos/hardening` (2026-11-10 overnight, local
commits only):** a Host allowlist before every route (`server/lib/host-guard.mjs`; config's
`allowedHosts` names the Serve name, `hostCheck` is `"log"` until a day of clean logs, then
`"enforce"`); the ack file written by temp file and rename at mode 0600; an ack for an alert
with no `since` capped at 24 hours, with no 7-day choice on the page; `by` defaults to the
owner only when the request carries an `Origin` header, else `local`; and a display name two
jobs share marks no health row. README: "The Host check" under Security, the config table, and
"Acknowledging a known miss". The ack-notification push is built on `jos/ack-notice` (below).
Ultron's 11-11 re-review (go with conditions) is answered on the same branch: `readBody` answers
a fixed `invalid JSON` (Node 26's parser message quoted the body around the fault), and an
unknown `hostCheck` value enforces and logs a `config:` problem instead of falling back to log.
**Before the restart that takes it live, Jarvis adds to `config.json`:** `"allowedHosts":
["<the Serve name>"]` (no `hostCheck`, so it logs). **After it:** `grep host: ` on the service
log over a day; no line for the Serve name means the list is right, and `"hostCheck":
"enforce"` goes in with the next restart. A line naming a Host that Jeff's devices do use
means the list is missing that name (add it, don't enforce yet).

**The chat server (Shuri's spec, C2) is built on the branch `jos/chat-server` (from `jos/1b`,
2026-11-11 overnight, local commits only), not live.** README "The chat with the lead agent"
describes it: the JSONL store with seqs and an epoch, the channel's Unix socket (API v1,
one client at a time, `ack {seq, epoch}`), the page routes (pairing and the `__Host-jos`
cookie, messages, uploads, SSE with Last-Event-ID replay, single-use verdicts, status), the
admin socket and `bin/chat-pair`. Nothing listens until `config.json` has a `chat` block
with `login` and `hostCheck` is `"enforce"`. Web Push (C6) is built on `jos/push` (below).
**The Chat tab (C5) is built on the branch `jos/chat-ui` (from `jos/chat-server`, 2026-11-11,
local commits only), not live; README "The chat with the lead agent", its last bullet,
describes it.** A third tab at `#chat`: the pairing screen (name, code, poll, the two ways to
approve), the thread (owner right, lead left, day lines, quotes, edited, notices, ticks: one
on `delivered`, two once the lead's next chat message exists), older pages on scroll-up, SSE
with `Last-Event-ID` and a fresh open from `?after=` on visibility, online and pageshow, a
retry-safe composer (`clientId`, optimistic bubble, Retry and Discard), photos resized on a
canvas to 1568 px JPEG 0.85 with no `blob:` preview (name, size and dimensions instead), the
status banner (§2.6 words), permission cards pinned over the composer with equal Deny and
Allow once buttons (the relay is off at launch; cards appear only when a request exists),
and the settings sheet (devices, this device marked, two-tap Revoke, approve a code). Two
small server adds: `/api/pair/status` answers `{state: "paired", device, already: true}` to
a device that already holds a valid cookie (so the page never takes a 401 to learn it must
pair) and `/api/chat/status` names the asking device. Checks 11-11: 117 web tests (18 new,
28 of 29 web mutations caught, the one miss an equivalent mutant), 695 server tests in local
time and Tokyo, and headless Chromium at 390 and 1440 px in light and dark against a scratch
server (the Serve login header shimmed in by that server) with a fake channel on the socket:
pairing via `bin/chat-pair`, send and reply over SSE, ticks, a quote, an edit, reload resume,
a restart notice, a 3000x2000 PNG arriving as a 1568x1045 JPEG and opening full size, a
permission card answered with Allow, 60 older messages loading on scroll-up, the offline
banner when the fake channel stops heartbeating (a message sent then stays queued, no tick,
and is delivered once it is back), revoke from settings returning the pairing screen with the
cookie dead, no CSP violation, no console error, no sideways scroll; screenshots in the run's
scratchpad. Chromium treats `http://localhost` as secure, so the `__Host-` cookie worked
there; on the tailnet it needs Serve HTTPS. **Not verified:** Safari and the installed-app
(home screen) case, iOS Dynamic Type, HEIC decoding (Chromium can't; the file goes up as is
and the server accepts heic), the expired card's look (unit-tested only, 10 minutes), and the
stream after a real iOS suspend. **Ultron's five 11-11 lows on C5 are fixed on the
branch:** a paired device can't start a pairing and its pairing cookie is cleared by
`pair/status`; a revoke drops an approved uncollected pairing (so a stale approved pairing
can't mint a device after a revoke); a device revoking itself gets `__Host-jos` cleared;
each stream starts with no cards and a `status` with `openPermissions: 0` drops open ones;
offline wins over "waiting on you"; `unpaired()` clears the thread, cards and status; a 403
or 404 after the stream gave up stops the 3 s reopen loop with its phase. **Files beyond photos
(Jeff's ask before launch, same branch):** paste an image or PDF into the box, drop one on the
thread, and a paperclip that picks photos or PDFs; four files a message across both; the
server takes `application/pdf` from the page (sniffed by `%PDF-`, 10 MB, device-bound like a
photo, never text) and serves a PDF as `attachment` (a download: nothing PDF renders at the
page's origin; inline with `sandbox` would also stop Chromium's own viewer), the thread shows
it as a chip with name and size. The channel already fetches a pdf over `/v1/attachment`
unchanged (its `sniffKind` matches `%PDF-`; a server test fetches one the way it does; the
channel's own e2e suite was not run). Checks: 57 of 57 at 390 px in light and dark (paste,
PDF, drop, the four-file cap, the 404 stop, the self-revoke clearing the cookie); Safari and
iPad drag and drop are not verified. Tests now: 698 server (local time and Tokyo), 122 web. **Left for later:** a "Start over" on a pairing resumed
after a reload can't start a new one until the pending code expires (the server allows one
pending at a time, 10 minutes); the Chat tab mounts its stream only while open (Web Push, C6,
covers a message arriving while it isn't); the playwright-cli on the mini
updated itself to 1.64 alpha and lacks its browser, so the checks ran playwright-core against
the installed 1223 headless shell by `executablePath`.
**Ultron's 11-11 review: merge with chat off; no-go to switch on until findings 1-4 are
fixed.** Fixed on the branch the same night: (1) a session token from `hello`, required in
`X-Session-Token` on every socket route but `hello` and `status` (409 otherwise, whatever
the pid; a reconnect by the holder rotates it; a takeover after a stale heartbeat is alerted);
`/v1/status` no longer carries the pid; (2) a revoke ends the device's SSE streams at once
and each ping re-checks the device; (3) `chat.login` is required and checked on
`/api/pair/start` and `/api/pair/status` too; (4) the chat refuses to start unless
`hostCheck` is `"enforce"`; (7) the cleaned pairing name in the log and the alert; (8) the
epoch is required on `ack` (400 without it); (9) the chat folders are chmod 0700 on every
start, a socket's folder is checked (0700, ours) for the env overrides too, a socket a live
server answers on is never unlinked (`server/lib/chat-listen.mjs`), a pending upload can be
read back only by its uploader, `no-store` on the pairing answers and on attachments
(`private, no-store`, my call: a lost or revoked device keeps no cached photo). **The channel
plugin must change to match:** send the token header, send the epoch on every ack, and treat
a 409 on any route as "say hello again"; the contract is in the spec's §1.5 (edited 11-11).
**Ultron's re-read (second 11-11 pass): go to merge with chat off, 0 medium findings;** the low
on alert floods is fixed on the branch: `client-refused` and `client-replaced` push at most
once per kind per 10 minutes, with a count of the ones held back (`server/lib/chat-alert-limit.mjs`,
6 tests; the wiring in server.mjs is syntax-checked only, not run, since server.mjs starts the
collectors). **Before it can go live:** Serve on HTTPS (P2, Vision, Jeff's
yes), since a browser takes a `__Host-` cookie over HTTPS only; Jarvis adds `chat.login` and
`hostCheck: "enforce"` to config.json (the latter after the day of clean host logs); Jarvis's
channel (C3) tried against a scratch server, never :8322. Checks done 11-11: 21 chat tests
over real temp sockets and a port (673 server tests in local time and Tokyo, 104 web), the
mutation pass (see the report), and a curl pass on a scratch server wired like server.mjs's
chat block (a second process 409 on hello, inbound and ack; an ack without an epoch 400;
status without a pid; pairing 403 without the login header; `chat-pair`; a revoke ending a
`-N` stream at once; a second server refusing the live sockets; a 0755 override folder, log
mode and a missing login each keeping the chat off).
**The channel's end-to-end run (Jarvis's jarvis-channel against this server, 11-11): 9 of 9
scenarios pass; four contract fixes made on the branch the same night.** (1, high) inbound
replayed one page of 100 and an ack of the next live message then marked the rest delivered
(100 of 130 arrived, 30 lost): the replay now pages through the whole backlog, listening for
live messages first and holding them until it ends (dedup by seq), and an ack moves the cursor
only as far as this session's streams have sent or the `after` the channel asked from (my call:
clamp, not refuse, since the channel reads any 409 as "say hello again" and would loop; the
clamp is logged). (2) `POST /v1/bye` (token required) frees the place at once and ends the
stream with `{"type":"bye"}`, logged, never pushed; and a holder whose stream closed from its
end and then went 20 s without a heartbeat is stale (a crash restarts in 20 s, not 45; a
takeover then is still alerted). (3) the holder's own re-hello, or its second stream, ends the
old stream with `{"type":"superseded"}`; `replaced` now means a takeover only. (4) spec §1.5
edited: `startedAt` in epoch ms, `bye`, the paging replay, the ack clamp, `superseded`, and the
socket bullet as `chat-listen.mjs` does it. **The channel should now:** call `bye` on stdin
EOF, treat `superseded` like the end of a stream (reconnect with its token), and may drop its
replay-window workaround (the cut at cursor + 100). Tests: `server/test/chat-socket.test.mjs`
(6, including 250 queued messages over three pages), 688 server tests in local time and Tokyo,
25 of 25 mutations caught.
**Ultron's third re-read (11-11): 653190b is go to merge with chat off; two adds made the
same night.** (1, low) backpressure: the inbound replay waits for `drain` whenever a write
fills the buffer (a 3 MB backlog to a slow reader stays under the cap and arrives whole), and
a stream holding more than 4 MB unsent (`INBOUND_BUFFER_MAX`, a stalled or SIGSTOPped
holder) is destroyed and logged; the channel reconnects from its cursor. A cut doesn't
start the 20 s crash rule. A replay waiting on drain ends when the stream is superseded,
replaced or byed. Left: live messages that arrive while a replay waits sit in memory as
references to store messages, unbounded but tiny (the owner's own messages). (2) a `bye`
then a fresh `hello` logs the gap (`chat: the channel is back 3.2 s after its bye`, plus
"a quick restart, under 5 s" when it is) and records a `notice` from `system`, "Jarvis's
channel restarted HH:MM" (local time), never pushed or alerted and not on the channel's
stream; a failed notice write is logged and the hello still succeeds. Web Push (C6) skips
`notice` messages (tested). Spec §1.5 gained one bullet for each.

**Web Push (C6) is built on the branch `jos/push` (from `jos/chat-ui` f633d74, 2026-11-11,
local commits only), not live; README "The chat with the lead agent", the Notifications
bullet, describes it.** Three commits: e9c2a9d (Ultron's two lows on f633d74: an upload's name
cut at 120 code points and made well formed before `encodeURIComponent`, so a PDF named
with an emoji at the cut downloads instead of a 500; an unsent upload's file deleted when it
expires after an hour, at most 8 waiting per device, 429) and the push commit
(`server/lib/webpush.mjs`, `server/lib/chat-push.mjs`, `server/lib/vapid-store.mjs`,
`bin/vapid-keygen`, the `/api/push` routes, `web/public/sw.js`, the settings sheet's
Notifications part, the manifest's `id`, and the stream closing when the page is hidden so
the 10 s rule sees it), then the fix for Ultron's six lows from his 11-11 review of it: the
tap's origin kept only as an `https` origin whose host is in `allowedHosts` (else `/#chat`;
the payload's own check tightened to https and a DNS name); approval pushes capped at one
per device each 15 s with a held one sent at the window's end while a request is open, and
sends bounded (4 in flight, 16 queued, then dropped and logged); `vapid-keygen` treating only
exit 44 as "no key" and stopping on any other code, reading the key back in-process (`-w`
into memory) and failing with `MISMATCH` unless its public key is the new one; every
`security` call naming `~/Library/Keychains/login.keychain-db`; and unsent uploads older
than an hour deleted at start. Its checks: 745 server tests in local time and Tokyo, 127
web, 40 mutations of the new code all caught; every `security` call in the tests goes
through the injected fake (the real Keychain was never touched). Ultron's re-read of 3143721 (go to merge, 11-11) left three
points, fixed in one more commit: a push the full send queue drops no longer starts its
window (`enqueue` says whether it queued; the 15 s approval window and the "New message"
minute start only then), and a dropped approval is held and tried again every 15 s while a
request is open (a later successful push cancels that retry); the payload's origin check
wants the last label to start with a letter, so `https://127.0.0.1` and
`https://10.0.0.5:8443` fall back to `/#chat`; vapid-store's header says the stray
zz-test item came from a manual probe during development, not the tests, and was deleted
11-11 with Jeff's OK. 748 server tests in local time and Tokyo, 127 web, 7 mutations of
the new code all caught. The headless check below
predates it: with a loopback `http` page, `navigate` is now `/#chat`, not the page's
origin. Checks 11-11: RFC 8291 Appendix A reproduced byte for byte; the JWT
verified with the derived key (a changed claim, another key, a non-ES256 header all fail);
a round trip through a test receiver; the egress rule (15 refused shapes); each trigger, the
10 s rule and its re-check, the once-a-minute limit, notices and edits skipped, 404/410
deletion (and a stale "gone" never deleting a fresh subscription), the 403 alert, the
routes, revoke; a loopback push service receiving and decrypting a push (`fetch` for real,
the test-only host override); 731 server and 127 web tests in local time and Tokyo; 43
push server mutations, 11 web and 8 for the lows, all caught after four test fixes (one dead
`subscribed && server` condition removed); headless Chromium (1223 shell) at 390 and 1440 against a
scratch server with a loopback push service, 17 of 17: the worker registers at `/`, the
sheet's Turn on, the subscription stored and marked, no push while the Chat tab is open, a
message and an approval pushed after 10 s hidden and decrypted with the page's own keys
(`navigate` to the page's origin, no text, approval urgent), a relaunch resyncing without a
new subscribe, Turn off dropping it, no CSP violation or console error, no sideways scroll.
Faked in that check: `PushManager` (real WebCrypto keys, a loopback endpoint) and the
permission prompt (the headless shell denies everything). **Not verified without Jeff's
iPhone:** a real subscribe through Apple's push service, whether `requestPermission` then
`subscribe` both count as the one tap on iOS, delivery while locked, a tap opening `#chat`,
the badge, Focus modes, iOS before 18.4 versus the declarative form, whether Apple accepts
the JWT and `Topic`/`Urgency` as sent, 410 after removing the app, and the declarative
`navigate`. **Go-live order:** Ultron's review (crypto, egress, payload); Jeff runs
`bin/vapid-keygen` on the mini; Jarvis adds `"push": {"subject": "mailto:<Jeff's
address>"}` to config.json (with the chat's own entries); C&P; restart (Vision); the web
build; then on each device, from the home-screen icon (re-added once Serve is on HTTPS),
Settings in the Chat tab, Turn on notifications. **Post-restart checks:** the log says
`push: notifications on` (no `push:` problem line); `GET /api/push/key` with a paired
cookie answers the key; after Jeff turns it on, `devices.json` shows `push` on his device
and a message from Jarvis while the app is closed arrives as "New message". The 192 and
512 px manifest icons came with `jos/polish` (below).

**Ultron's three prerequisites (board e8d3ef26), checked and closed on `jos/verdict-alerts-csp`
(from main 1e1da2d, 2026-11-11 overnight), staged, not committed.** All three were already on
main: every page verdict was logged and pushed (#pepper the device and tool, ntfy generic
words), the pages had the strict policy, and every socket route but hello and status takes
the hello's session token. The gaps the branch closes: (1) the event words lived untested in
`server.mjs`, and the channel's tool name keeps its line breaks (capField), as does a device
name read back from `devices.json`, so either could forge a second log or #pepper line. The
words, the pushed kinds and the handler are now `server/lib/chat-events.mjs`, every event line
and every chat page-route log line goes through `oneLine` (breaks, controls and direction
characters shown as `⟦U+XXXX⟧`), and `chat-events.test.mjs` covers Deny, Allow, the device
name and hostile device and tool names end to end. (2) `script-src 'self'` is spelled out on
the pages, and every non-page answer now gets `default-src 'none'` (`setBaseHeaders`). Also
fixed: a flake in chat.test's status test (the random epoch could hold "300"). Live only
after a service restart; no web build needed (the page code is unchanged). Left as it is: a
verdict given at the terminal or in Discord never reaches this server, so only page
verdicts alert; ntfy names no device by design (L10).

**The polish batch is committed on main (66607bb, 2026-11-11), after the chat went live on
Jeff's iPhone that morning.** Three fixes for what he hit: (1) the pairing
screen's name box starts filled from the user agent (`defaultDeviceName` in
`web/src/lib/orbit/chat.js`: iPhone, iPad, also an iPad that reports a Mac, Mac, else "This
device"), so "Get a code" is enabled at once; (2) the page reloads itself once after a new
build (README "Tests and build" has how: build.json, `__BUILD_ID__`,
`web/src/orbit/buildWatch.js`), waiting while the composer, an unsent message or a typed-in
field holds it; the static handler now sends `Cache-Control: no-cache` on everything but
`assets/`; (3) `icon-192.png` and `icon-512.png`, drawn by `web/scripts/make-icons.mjs` from
the 180's measured geometry. **Go-live:** C&P, then the web build alone takes (1)-(3) live,
build.json included; the no-cache header waits for the next restart (Vision), and nothing
breaks without it, since the watcher fetches with `no-store`. The first build with the
watcher still needs one swipe-away on each device (the open page predates it); every build
after that reloads by itself. **Verified:** server 749 tests (local and Tokyo) and web
136, each new test mutation-checked; headless Chromium on a scratch build at 390 px (name
"iPhone", button enabled, no overflow; Mac UA gives "Mac"), and the watcher end to end (same
id no reload, new id one reload, the old page coming back does not loop, a typed-in field
holds it and it reloads within 5 s of leaving). **Unverified:** the composer and unsent-message
holds in a browser (their logic is unit-tested, the wiring not), and anything on real iOS:
whether the home-screen app fires `visibilitychange` on resume (it should), and Safari's
use of the 192/512 icons (it uses the apple-touch-icon).

**The ingest on its own Unix socket, staged on `jos/ingest-socket` (board ba1b8446, from main
1e1da2d, 2026-11-12), not committed, not live.** Ultron's M1 on the loopback guard: it holds only
while Serve proxies at the HTTP layer. Every `/api/ingest/*` route is now served on
`~/.local/state/jarvis-os/ingest.sock` (0600 in the 0700 folder, bound under umask 077, checked
before and after it listens, started whether or not the chat is on; `server/lib/ingest-socket.mjs`),
and the TCP port refuses every ingest post, except `needs-you` while config's `ingest.tcp` is
`"legacy"` (the default): that route keeps the loopback guard, logs every post to it (first, then
hourly with taken / proxy-header / other counts, the trailing ones at the hour's end) and alerts
once a day for a taken one. Socket over a per-install token: nothing to leak or rotate, and the
ingest leaves the port Serve shares (README "What the ingest endpoints require"). Callers found:
the six hook entries in `~/.claude/settings.json` (Notification, PostToolUse, UserPromptSubmit,
Stop, SessionEnd, PermissionDenied), all `needs-you` on TCP; the exact-command hook (not installed
yet); no poster of crons, projects or credits; the lead's channel e2e harness keeps its own TCP
copy of the exact-command ingest (a test double, the lead's repo).

**Ultron's 11-12 review: GO; his mediums and lows fixed the same night (Pepper, overnight).**
4-M1: a socket that fails is tried four times over 30 s, then stays off with one alert, and while
it is off with `ingest.tcp` not `"legacy"` the page's approvals are Deny-only (`ingestOk` in
server.mjs, `INGEST_OFF` in lib/approvals.mjs). 4-M2: trailing posts are logged when the hour
ends, and each line counts the posts that carried a proxy header. 4-L2: the alert's new words
(something here or a forwarder; set `ingest.tcp` "off"). 4-L1: the umask. The settings swap is
now `deploy/swap-needs-you-hooks.py` (Ultron asked for a script he can re-read in place of a
sed). Tests: server 915 in local time and Tokyo (5 for the script, on fixture copies and a scratch
socket); 27 of 28 mutations caught. The survivor is a backstop: two checks in the script (the
after-count and the whole-structure compare) sit behind the text count and no input reaches them.
Gap left as specified: with `ingest.tcp` still `"legacy"` after the swap, a dead socket is not
capped (the alert still fires); set `"off"` promptly after the swap (step 5 below).

**Ultron's 11-12 re-read: GO, with three lows, fixed 2026-11-12 overnight (Pepper).** (1) The
socket file's device and inode are kept after listen (as BigInts), and `ingestOk` now calls
`ingestSocket.check()`, a synchronous lstat on each approval: a file that is gone, not a socket,
or another device or inode turns the socket off for the rest of the run. (2) The server's
`close` or `error` does the same. Either way: one `ingest: … the ingest socket is off until a
restart` line and one alert per run, in run-time words (`INGEST_LOST_ALERT`; the start's
`INGEST_OFF_ALERT` is unchanged), and approvals are Deny-only unless `ingest.tcp` is `"legacy"`.
`check()` runs first in `ingestOk`, so a lost socket is noticed and alerted under `"legacy"`
too. A mismatched file is never closed or removed by the server (closing a Unix socket server
unlinks whatever is at the path). (3) The swap script's match now starts with `(?<![\w/])`, so
`/opt/homebrew/bin/curl …` or `xcurl …` can't half-match into `/opt/homebrew/bin//usr/bin/curl`;
such a command reads as an unknown form or as one of five, and the script refuses. Tests: server
921 in local time and Tokyo; 17 of 17 new mutations caught (a second once-flag the mutations
showed was dead is gone: `lose` runs only while the socket is on).

**Go-live, in this order:**

1. C&P (Ultron's 11-12 re-read was GO; his three lows are in).
2. The service restart (Vision or Jeff). The log then says `ingest: socket at …; the TCP port
   still takes needs-you posts from this machine (ingest.tcp "legacy")`.
3. **Post-restart checks:** `ls -l ~/.local/state/jarvis-os/ingest.sock` shows `srw-------`;
   from the mini, `curl -s -o /dev/null -w '%{http_code}' -X POST
   http://127.0.0.1:8322/api/ingest/crons -H 'Content-Type: application/json' -d '[]'` answers
   403 (`Unix socket only`), and the same over `--unix-socket
   ~/.local/state/jarvis-os/ingest.sock http://localhost/api/ingest/crons` with `-d '{}'`
   answers 400. No `ingest: … stays off after 4 tries` line.
4. Jeff swaps the six hook commands, on the mini, after step 3 and never before (until the
   socket exists their posts fail silently, and the PermissionDenied post is what makes page
   approvals Deny-only after a block):
   `/usr/bin/python3 -I ~/Projects/claude-control-room/deploy/swap-needs-you-hooks.py --dry-run`
   (prints the diff: six `-` lines with `127.0.0.1:8322`, six `+` lines with `--unix-socket`;
   exit 0), then the same without `--dry-run`. It prints the backup's path
   (`~/.claude/settings.json.bak-YYYYMMDD-HHMMSS`); to undo, copy that back. It refuses, with
   nothing changed, unless it finds exactly six old commands and the socket is a 0600 socket
   of Jeff's.
5. An `ingest: … over TCP, the old route` line or the daily alert means something still posts
   to the port. Once a day passes with none, Jarvis adds `"ingest": { "tcp": "off" }` to
   config.json and restarts.

**Tests:** `server/test/ingest-socket.test.mjs` (the socket, its tries, the notice, a source
test that guards server.mjs's wiring), `ingest-local.test.mjs` (the TCP side),
`swap-needs-you-hooks.test.mjs` (the script), `approvals.test.mjs` (the Deny-only cap), and the
README hook entries run for real over a scratch socket under a scratch `$HOME`. Follow-up, once
`"off"` has held: delete the legacy route and `lib/local-caller.mjs`. **Merge:** after
`jos/ack-notice` (see its merge note): both edit server.mjs's createHandler call; keep this
branch's `onBlock`, `onExact`, `onIngestTcp` and that branch's `onAckNotice`, then run the server
suite (each branch's source test guards its own wiring).

**Chat Markdown and loopback-only ingest, staged on `jos/md-ingest` (from main a82420a,
2026-11-11), not committed, not live.** Two board items (883b96d0, 1881027f). (1) **Markdown in
the Chat thread** (Jeff: "bold text isn't coming across"): `web/src/lib/orbit/markdown.js` (a
dependency-free, escaping-first parser returning plain objects) and `web/src/orbit/Markdown.jsx`
(React elements, no `dangerouslySetInnerHTML`), used for every chat bubble's text, both sides;
the reply quote drops the markers; events, notices, permission lines and push bodies unchanged.
README "The chat with the lead agent" (the Chat tab bullet) has the subset and the link rules.
(2) **Ingest from this machine only** (Ultron 11-11 H1): `server/lib/local-caller.mjs`, checked
first on `/api/ingest/{crons,projects,credits,needs-you}`: a loopback socket, a loopback Host and
none of the proxy headers Serve adds, else 403 before the body is read; README "What the ingest
endpoints require" has the rule. Posters found: none for crons, projects or credits (no script,
launchd job or other repo; all three panels unfed since the 11-11 restart), and the needs-you hook
(README's entry, on `127.0.0.1`, not yet in settings.json), so no token and no config change were
needed. **Go-live:** Ultron's review, C&P, a service restart (the ingest change is server-side),
then `cd web && npm run build` (the page change needs no new server; either order works).
**Post-restart check:** from the mini, `curl -s -o /dev/null -w '%{http_code}' -X POST
https://<mini-hostname>.<tailnet>.ts.net/api/ingest/crons -H 'Content-Type: application/json'
-d '{}'` answers 403 (it was 400, the body refused, before); the same with `-H 'Host:
127.0.0.1:8322'` added still answers 403, its log line naming `x-forwarded-for` (Serve passes
on the client's Host, so the proxy headers are what hold); and the same to `http://127.0.0.1:
8322/api/ingest/crons` answers 400. **Ultron's 11-11 review: ingest go, Markdown go with M2,
all fixed on the branch:** M2 (a bare or `<…>` URL shown as URL rebuilt it; a written label
followed by the real host), L3 (README: the proxy headers hold against Serve, the Host check is
for DNS rebinding), L4 (the 403 closes the connection), L6 (`Tailscale-Funnel-Request`,
`Tailscale-Headers-Info`, `Via` added), L7 (a mailto keeps only its address), L8 (bidi and
zero-width characters dropped from labels). Left for the board: ingest on a Unix socket or a
token, a refusal counter, Vision's monthly Serve check. **Verified:** server
796 tests in local time and Tokyo (8 new), web 182 (the Markdown file's 22 new), oxlint clean but
the old Lanes warning; 17 server mutations all caught, 41 web ones all caught but 2 equivalent (the raw href
length guard, which the rebuilt href's cap repeats, and a naive URL-end scan, linear anyway since
the scan's span is always consumed); an SSR render of hostile messages through the real component
(only the allowed tags and attributes, every href http(s)/mailto with target and rel); headless
Chromium (1223 shell) on a static page with orbit.css at 390 and 820, light and dark: no sideways
page scroll, code blocks scroll inside the bubble, links in the bubble's ink. **Unverified:** what
Serve actually sends (taken from Tailscale's documented behaviour; the post-restart check proves
it), Safari, the live chat store's real messages.

**Three tab fixes staged on `jos/qol-nav` (from main 2b53124, 2026-11-11), not committed, not
live.** Jeff's ask that day: a badge on Chat for an unseen message, a header that stays in reach
while scrolling, and the sideways swipe on the iPad. README "The Orbit page" (the header bullet
and the Chat tab bullet) has how each works. (1) **Badge:** `useUnseen.js` + `lib/orbit/unseen.js`;
per device in `localStorage`, polled every 30 s off the Chat tab while the page is visible; the
lead's messages and event lines count, not his own, verdicts or notices. (2) **Sticky tabs:**
the header's nav is pinned (fixed, safe-area padded) once its slot scrolls away; the slot keeps
its measured width so a phone's title row doesn't close up. (3) **Swipe:** the finding was that
the page never had a swipe; the iPhone's working "swipe" was iOS's edge gesture through the
`#hash` history, which only goes back to where you were and only from the screen's very edge,
so on the iPad (a wider screen, and a gesture usually begun away from the edge) it seemed dead.
`useSwipeTabs.js` + `lib/orbit/nav.js` add a tab-order swipe on touch, any width, that leaves the
edges to iOS and leaves sideways scrollers, fields and dialogs alone. **Go-live:** C&P, then
`cd web && npm run build` alone (no server change, no restart); the build-id watcher reloads open
pages. **Verified:** web 160 tests (20 new, 28 mutations all caught), server 788 in local time
and Tokyo; headless Chromium (the 1223 shell) on a scratch build at 390, 820x1180, 1180x820 and
1440 with touch emulated through CDP: 98 checks (pinned at top 0 with every tab on screen and 44
px, no content jump, no sideways page scroll, the badge's count and label with the chat routes
faked, opening Chat marks the seq, the Chat banner under the bar, swipes both ways, edge, vertical,
slow, a sideways scroller that scrolls instead, the composer, a mouse drag on desktop that does
nothing). **Unverified:** everything on real iOS (WebKit isn't installed): Safari's touch events
on the iPad, how the pin looks under the status bar in the home-screen app, the badge against
the live chat store. At 320 px a "Board · 123" and "99+" badge overflow the pinned row by 7 px.

**Events, pillar 3 slice 1 ("a failed job wakes Jarvis"), built on `jos/events` (from main
66607bb, 2026-11-11), committed on main as 2b53124; go-live as below.** Jeff approved the design 11-11 ("Go with
your recos for now"); Ultron's review was go with changes, all built in. README "Events"
has the rules and the exact inbound line the channel must handle (`{"type":"event", seq,
id, at, source, event, text, count, ids}`, a `summary` after hello). What's in it:
`server/lib/events.mjs` (templates, own ledger `data/events.json`, dedupe, 60 s coalescing,
6/h per source and 30/day with one held-back summary, quiet-hours hook, kill switch file,
2 h expiry and liveness, a daily triage budget unused until slice 2), the notifier hook
after acks (its own try), `kind: 'event'` in the store (only `system` makes one;
`unanswered()`, ticks and "slow" ignore replies to events), the event case and replay
summary in `chat-socket.mjs`, the event-only socket `events.sock` (`POST /v1/event`, typed
`{source, count, ref?}`, sources allowlist empty by default), a numeric `exit` on the crons
panel, and the page's notice line. **Ultron's review (11-11, go with changes: 1 medium, 4
low), all fixed on the branch:** M1 a job is named only by its own config `jobs` entry
(never the label, never an inherited property); L2 a refused store append takes its dedupe
keys back; L3 an event skipped at delivery is marked `undelivered` (page: "Not delivered to
Jarvis") and never delivered later; L4 events go only to a channel whose hello says
`"capabilities": ["events"]`; L5 the kill switch only counts (one `off` "suppressed" line an
hour) and the quiet hold is bounded at 100. **Verified:** server 775 tests (local and
Tokyo), web 140; 23 mutations of the first build and 12 of the fixes, all caught; the page
built to a scratch folder. **Unverified:** `server.mjs`'s wiring (only `node --check`; no
full server run, by the rule against starting one with collectors), and anything with the
real channel. **Also on this branch, the gate for channel 0.4.1+ (Ultron's channel-fixes
review, findings 1 and 5; board 58ea9069 and cf4afe50):** the hello after a bye is checked
(`server/lib/chat-verify.mjs`: the declared pid alive, running exactly `node
<chat.channelServer>`, under the pid in `~/.local/state/jarvis-os/launch.json` within 8
hops); a failure is refused with 409 and alerted as `client-replaced`; a bye with no hello
for 2 minutes is alerted once (`channel-silent`). Ultron's final read (11-11) added: after a
bye the pid that said bye is refused, and the process must have started no earlier than
2 s before the bye (ps `lstart`, read in local time); once `chat.channelServer` is set,
every hello without the session token is checked (first hello after a start, stale
takeovers); a coalesced event's dedupe keys are set only after it is made. 12 tests in
`chat-verify.test.mjs` (ps and launch.json faked or temp files), 23 mutations all caught
(one dead month check removed); the server suite is 788 (local and Tokyo). The lstart
parser was checked against real `/bin/ps` output for its own process in both TZs.
**Before the restart that takes it live:** Jarvis adds `"channelServer": "<the release
worktree>/jarvis-local/plugins/jarvis-channel/server.mjs"` to `config.json`'s `chat` block,
and the lead's launcher writes `launch.json` (`{"pid": N}`, 0600) with its own pid. Without
both, the channel can't come back after any bye, and with `channelServer` set but no
`launch.json`, no hello at all gets in (fails closed). **Unverified:** the check against the
live channel (after the restart, the channel must be in: `chat:` log lines show any
refusal and its reason). **Go-live order:** Jeff's C&P, Jarvis's channel side (send `capabilities:
["events"]` in hello, handle `type:"event"`, deliver as `chat_id="jos-events"` with
`event_is_data="1"`, reply to `jos`), a restart
(Vision), the web build, then Vision fails a test job and watches the event arrive. **Post-
restart checks:** the log has `events: on, 0 socket sources allowed` and `chat: event socket
at …/events.sock`; `stat -f %Lp ~/.local/state/jarvis-os/events.sock` is 600; a POST to it
answers 403; `data/events.json` appears after the first notifier pass. Slice 2 (Vision's
inbox and NAS watchers, through headless triage) adds sources to `events.sources`.

**Phase 1b is built on the branch `jos/1b` (from `jos/hardening`, 2026-11-10 overnight, local
commits only), not live.** README "The Orbit page" (the Now chip, Needs you, Today's routines,
the phone fold, the home-screen icon) and "A session waiting on you" (the ingest and the hook
entry) describe it. Server: `model` per run and `leadModel`/`leadLast` in `agentWork`;
`server/lib/needs-you.mjs` and `POST /api/ingest/needs-you`; `needsYou` in `/api/dashboard`;
the `needs-you` alert kind and its push words; `.webmanifest`'s MIME type. Page: `Now.jsx`,
`Routines.jsx`, the Alerts tile in `Waiting.jsx`, the More fold in `Overview.jsx`,
`web/public/manifest.webmanifest` and `apple-touch-icon.png`. The product is not renamed: the
page, its title and the manifest all say "Control Room" (Jeff: nothing renamed in Phase 1); when
he says "Jarvis OS", it is the `<h1>` and `<title>` in `OrbitApp.jsx`/`index.html` and the
manifest's two names. **To go live, after the hardening:** Ultron's light review of the
ingest, Jeff's C&P, the restart, then `cd web && npm run build`; then Jeff adds the hook entry
(README's JSON) to `~/.claude/settings.json` himself, since the dashboard never writes it.
**Post-restart checks:** `/api/dashboard` has `needsYou: []` and `sessions.data.agentWork.
leadModel`; the band shows the Now chip with the lead's model; Needs you has four tiles;
Today's routines lists today's jobs; on the iPhone the lower panels fold under More and
"Add to Home Screen" offers the navy icon named Control Room; after the hook entry, a
permission prompt in Jarvis's session shows a Waiting card within a poll (30 s) and clears
when it is answered. **Ultron's 11-11 re-review (go with conditions)** is answered on the branch: the README's hook
entry now filters with `/usr/bin/jq -c` down to the three fields the server reads before
curl (macOS ships `/usr/bin/jq`; there is no Homebrew jq on the mini), runs `"async": true` on the
four in-session events (the CLI 2.1.321 schema has `async`), adds `SessionEnd` (synchronous, 1 s),
hooks `Notification` with a matcher for the three opening types and drops `PermissionRequest`
(payload unconfirmed; the server still accepts it). **Ultron's second 11-11 re-read (go, 0 medium)**
lows fixed on the branch: every hook command ends in `|| true` (a curl that can't reach the
server exited 7); the filter adds `at:(now*1000|floor)` and the server ignores an event older
than the newest `at` seen for its session, so an async "waiting" post landing after its clear
leaves no stale card (an entry with no `at` still works, in arrival order). Server tests 654
in local time and Tokyo. **Follow-up:** the design's §5.2
`PermissionRequest` payload is unconfirmed; the `Notification` hook alone is enough.

**Phase 1a, the acknowledge mechanism, is built and committed (96cd2b6, 2026-11-10), not live.** README
"Acknowledging a known miss" describes it: `server/lib/acks.mjs` (pure), `server/acks.mjs`
(the file `server/data/acks.json`), `POST`/`DELETE`/`GET /api/acks`, `acks` and `acked` in
`/api/dashboard`, `ack` on covered crons, jobs and services, the notifier silenced for a
covered alert, the Jobs chip's grey "all OK · 1 ack", the strip's Acknowledge form and the
details' Un-ack. Tests: server 630 and web 87 in local time and Tokyo; 41 mutations caught;
headless Chromium at 390 and 1440 on a scratch server: ack, un-ack, expiry, a new failure
not covered, the CSP's four probes blocked. **To go live, in this order:** Ultron's light
review of the write endpoint (the design's §8), Jeff's C&P, the service restart (Vision or
Jeff), then `cd web && npm run build` (the new page needs `refresh` from the new server's
`acked`; the old page ignores the new fields, so the build may follow the restart at any
time). **Post-restart checks:** `GET /api/dashboard` carries `acks: []` and `acked: []`; the
Friday alert (if still red before Fri 11-13 16:45) can be acked from the iPad and the chip
reads "all OK · 1 ack"; `server/data/acks.json` appears on the first ack; one `ack:` line in
the service log. **Known limits:** a cron's `since` is matched within 5 minutes because
job-status rounds a log's age to 0.01 h; a launchd job without the job-status overlay has no
`lastRunAt`, so its ack's `since` is null and a re-run can't be told apart until it expires;
two jobs whose display names collide would both show one ack (the health panel carries no
labels). **Follow-ups:** the mod's one-line "acked" suffix (`crons[].ack`), and Phase 1b.

**The ack notice (board a37d853e, Ultron's 11-10 medium) is staged on `jos/ack-notice`
(2026-11-11, from main 1e1da2d, worktree `~/Projects/.worktrees/ccr-ack-notice`), not
committed.** Every ack and renewal pushes at low priority: #pepper gets who, the kind, how
long it has failed, until when and "renewed N times for this failure"; ntfy generic words at
ntfy `low`; never the key, name or note. `renewals` is counted in `addAck`. No cap on
renewals: the push is the guard (README "Acknowledging a known miss" says why). Ultron's
11-12 review: GO, with his medium 3-M1 fixed the same night: the #pepper notices are coalesced
per key over 10 minutes (`lib/ack-notice-limit.mjs`; first at once, the rest counted and sent
with the next or at the window's end, never dropped), and acks answer 429 past 10 a minute.
**Ultron's 11-12 re-read: GO once one medium is in; it and his low are in (2026-11-12
overnight).** Medium: ntfy has its own budget across every key (`createAckNtfyBudget`; the two
halves go out through `sendAckPepper` and `sendAckNtfy` in notify.mjs, both from
`createAckNotices`): at most one push an hour (the rest counted into the next or the hour's
end) and 12 a day; the 12th carries the line "Ack notices are Discord-only until tomorrow.",
then ntfy gets nothing until local midnight (the server's calendar day, the mini's zone) and
the notices in between are not held over. #pepper keeps its per-key windows; a global #pepper
limit (optional in his spec) is not built. Low: `DELETE /api/acks` is out of the 429 limit and
never counted. Tests: server 924 in local time and Tokyo (a fake clock, local-time fixtures so
midnight is the server's in either zone; two alerts renewing every minute for a day give ntfy
exactly 12); 25 of 26 new mutations caught, the survivor equivalent (#pepper and ntfy started
one after the other instead of together). **To go live:** Jeff's C&P, then a service restart
(Vision or Jeff); no web build. **Post-restart check:** the next ack posts one line in #pepper and
one `ack:` line in the log. **Merge order (trial-merged 2026-11-12 in a scratch clone, with every branch's staged state):**
`jos/hello-no-test`, `jos/verdict-alerts-csp` (both clean), this branch, then
`jos/ingest-socket`. This branch's conflict, server.mjs's imports: keep `getTopic, sendAlert,
sendAckPepper, sendAckNtfy` from `notify.mjs`, the other's `chat-events.mjs` line and this branch's
`createAckNotices` line; drop `createAlertLimiter`. `jos/ingest-socket` then conflicts in
routes.mjs (createHandler's signature: take that branch's side and add `onAckNotice = null, clock
= () => Date.now()`) and server.mjs (take that branch's side, then put `const ackNotices = …` and
`onAckNotice: (notice, key) => ackNotices.notice(key, notice)` into its createHandler call).
**Watch that last one:** git leaves `jos/ingest-socket`'s one-line `createHandler({ … onIngestTcp
})` after the conflict block, so a merge that takes that side loses `onAckNotice` silently.
`test/ack-notice-limit.test.mjs` fails when that happens (Ultron's grep, as a test), and
`test/ingest-socket.test.mjs` guards the ingest side the same way: **run the server suite after
the last merge.** Trial re-run 2026-11-12 ~01:00 ET with the re-read fixes on all three
branches: the same three conflicts, resolved as above, and after `jos/hidden-chars` and its
dedupe step (that branch's note) the merged tree passed 978 server tests in local time and Tokyo. `lib/acks.mjs` holds a copy
of `oneLine` from `lib/chat-events.mjs`; once both are on main, import that one and delete
the copy. **Not built:** a mark on the page for a renewed ack (`renewals` is in the
payload; needs a web build); `by` from a script is self-declared, so the notice can say
"jeff" for a script that claims it.

**One set of hidden characters (Ultron's A3), staged on `jos/hidden-chars` (from main 1e1da2d,
2026-11-12, worktree `~/Projects/.worktrees/ccr-hidden-chars`), not committed, not live.** The
cards' `isHiddenChar` listed ranges by hand and missed the tag characters (U+E0000-E007F), the
variation selectors, the C1 controls (U+0085) and U+2028/U+2029, so a request carrying one could
be offered Allow. `server/lib/hidden-chars.mjs` builds one set from Unicode's categories (Cc, Cf,
Zl, Zp, lone surrogates, Default_Ignorable_Code_Point) with `isHiddenCodePoint`, `hiddenMarker`,
`revealHiddenChars` and `hasHiddenChars` (a `keep` set for what a caller lets through);
`lib/approvals.mjs` uses it, keeping tab and newline, so any request carrying another is marked
`⟦U+XXXX⟧` and Deny-only by the existing marker rule. Tests: `server/test/hidden-chars.test.mjs`
(every named class raw and as a JSON escape, end to end through the chat store); server 896 in
local time and Tokyo; both card tests fail on main's set, and 7 mutations (each category, the
keep set) are caught. **To go live:** C&P and a service restart; no web build (the page's
marker pattern already takes 4 to 6 hex digits). **Merge plan:** independent of the others
(only `lib/approvals.mjs` and the new module), any order. `oneLine` is on
`jos/verdict-alerts-csp` (`lib/chat-events.mjs`, its own `isUnsafe` list) and copied on
`jos/ack-notice` (`lib/acks.mjs`); after all three are merged, one small commit: in
chat-events.mjs replace `isUnsafe` with `isHiddenCodePoint` from `./hidden-chars.mjs`, called
without `card` (the one-line set; tab is already turned into a space before the check), then in acks.mjs delete the copied `oneLine` and
import chat-events.mjs's, and run the server suite (`chat-events.test.mjs` and the ack-notice
tests cover both). Trial-run 2026-11-12 in a scratch clone, and again ~01:00 ET with the re-read
fixes on this branch, `jos/ack-notice` and `jos/ingest-socket`: this branch merged on top of the
other four with no code conflict (NEXT.md only), and with that dedupe step the merged tree
passed 978 server tests in local time and Tokyo. **Ultron's 11-12 re-read: GO; his low added 2026-11-12 overnight (Pepper):** the
cards take a wider set (`card: true` in `hidden-chars.mjs`; the one-line set is unchanged): every
space in Zs but U+0020 (U+00A0, U+2007, U+202F, U+3000 and the rest), the braille blank U+2800,
private-use characters (Co) and unassigned code points (Cn, noncharacters included), each making a
card Deny-only and shown as its marker. Built with a `v`-flag set difference
(`[\p{Zs}--[\x20]]`), no listed characters. Tests: server 899 in local time and Tokyo (a sweep
of every code point checks all of Zs but the space is in the card set and the card set holds the
whole one-line set); 15 of 15 new mutations caught (one survivor, `Noncharacter_Code_Point` beside
`Cn`, was redundant and is gone). **Known cost:** a Write or Edit whose text holds a no-break or
ideographic space, a private-use glyph (some icon fonts) or a character newer than Node's Unicode
tables is Deny-only on the page. **Follow-ups, not built:** the page's link-label filter
(`web/src/lib/orbit/markdown.js`, `INVISIBLE`, 13 code points) and the board's text rule
(`server/lib/text.mjs`, which lets U+2028/U+2029 through) could use the same set; the first
needs a web build, the second a look at what the board's fields must allow (U+200D sits inside
combined emoji, and the set marks it).

**Read aloud, chat search and the icon badge, on main a6d46ff (committed 2026-11-16), live
since the 11-16 build.** Jeff's yes to Shuri's scout items 1 and 2 ("Yes do 1&2", 11-15), plus his ask
the same day: "can we get a chat notification badge on the icon?" README ("The chat with
the lead agent": the routes bullet, the Chat tab bullet and "Read aloud and search in the
Chat tab") has how each works. (1) **Read aloud:** a speaker button on each of the lead's
chat bubbles uses the browser's `speechSynthesis`, on the page only, with no server change,
in an on-device voice only (see "On-device voices only" below).
It reads the words without Markdown: a code block is "Code block skipped.", a link is read
by its label, and a bare address as "a link to <host>". The whole message is queued inside
the tap. A second tap stops it, another message replaces it, and leaving the tab or hiding
the page stops it. The button isn't drawn without `speechSynthesis` or an on-device voice. (2) **Search:** a
read-only `GET /api/chat/search?q=` (`server/lib/chat-search.mjs`; the route is 4 lines in
`chat-routes.mjs`, plus `store.newest(n)`). It has `/api/feed`'s read rule (a paired
device with the owner's login) and looks at message text only: chat messages and event
lines, never attachments, approval requests, verdicts or notices. Limits: a query of 2 to
100 characters and at most 8 words, 50 results at most (20 by default), the newest 20,000
messages, and the query is never logged. There is no rate limit, because `/api/feed` has
none either. It is reached from the banner's ⋮, which is now a menu (Search messages, Chat
settings). A result is plain text with the matches marked. A tap loads older history (at
most 2,000 messages back), scrolls to the message and outlines it, or says plainly that it
is too far back or no longer there. (3) **Icon badge:** `useUnseen.js` now also polls while
the page is hidden (every minute) and sets `navigator.setAppBadge(count)` whenever the Chat
tab isn't in view. The Chat tab in view clears it; that clear moved here from `useChat.js`.
Push still sets the badge when the page isn't running (`sw.js` unchanged, `app_badge: 1`).
**The Mac app has no push subscription:** `devices.json` (read 11-15, names and the
`push` flag only) has "Jeff's Mac Mini" paired 11-12 with `push: false`; the iPhone and
iPad are on Apple's push service. So on the Mac the Dock badge shows only while the
Chrome app is running. To get pushes (and a badge while it is closed), Jeff taps Chat
settings, then Turn on notifications, in the Mac app. That is his tap, and macOS also has
to allow Chrome's notifications. **Verified:** server 1294 tests in local time and Tokyo
(11 new in `chat-search.test.mjs`), web 276 (25 new across speech, chat-search and unseen);
94 mutations: all caught (two no-op baselines survive, as they should). Dead checks found
by mutation were removed: an empty-text skip, a mark clip before the window, a mailto
branch, a redundant guard and two clamps. Two mutants are equivalent and were dropped:
cutting a sentence of exactly the limit at a space (the pieces are joined again), and the
fold's identity shortcut. Lint is clean, and a build to a scratch `--outDir` works (the live
`web/dist` was untouched). Headless Chromium (the 1223 shell) on a scratch server (the real
chat routes, 2,300 seeded messages) at 390, 820 and 1440, light and dark: 43 of 43 each.
Those cover the speaker on every lead bubble and none of the owner's, a 44 px target, the
spoken text, toggling, one at a time, stop on hide and on leaving the tab, no button
without `speechSynthesis`, the menu (focus, arrows, Escape, tap outside), settings still
reachable, search marks with raw text as text, a hostile message as text, too far back,
a jump of 1,300 rows with the outline, the icon count off the Chat tab and while hidden,
the hidden Chat tab not counting as seen, the clear and the mark on looking, no CSP
violations and no sideways scroll. A mutant where the Chat tab counts as seen while hidden
fails 3 of them. **Faked in that check:** `speechSynthesis` (the shell has no voices),
`setAppBadge`, and visibility. **Unverified (needs Jeff's devices):** iOS voices and speech
in the home-screen app (whether the silent switch mutes it, whether a long message is cut,
and whether `cancel()` then `speak()` in one tap works on WebKit); the badge on iOS (it
needs notification permission; the page sets it only while it runs) and on the Chrome app
on the Mac (Dock); Safari's layout of the menu and the search sheet with the keyboard up.
**Live:** the page was built 2026-11-16 21:42 with `jos/local-voice` (below) in it (the
live `web/dist` carries the on-device rule; read 11-16), and Jarvis's 11-16 brief calls main
16619c0 live. Jeff has used read aloud on the iPad since ("it didn't change the voice on
ipad", 11-16), so the button is there on iPadOS; the other device checks are not reported
back yet. **Device checks for Jeff:** on the iPhone, tap the
speaker on one of Jarvis's replies; open ⋮, then Search messages, search a word from last
week and tap the result; leave the app on the Board tab, and after Jarvis's next reply the
icon shows a number. On the Mac, the Dock icon shows the count while the app sits on
another tab or minimised (within a minute), and opening Chat clears it. Unrelated, and
still open: the Shortcuts follow-up "Ask Jarvis speaking the answer" is the Shortcut
speaking, not the page.

**On-device voices only, and one jump at a time, on main 16619c0 (2026-11-16, from
`jos/local-voice`), live with the 11-16 build, page only.** Jeff picked option (a) for Ultron's read-aloud low on 11-16 ("Def A"): Jarvis's text
must never go to a network voice (Chrome on the Mac lists "Google US English",
`localService: false`, and with no voice set it may be picked). `pickLocalVoice` in
`web/src/lib/orbit/speech.js` keeps voices whose `localService` is exactly `true`, then takes
the default one, then the first of the page's language (`<html lang>`) and the browser's
(`navigator.languages`) matched exactly, then by language alone, then any. The speaker sets
`u.voice` (and `u.lang`) on every piece. The list is read again on `voiceschanged`, on
subscribe and on every tap, since it can be empty at first load; an engine without
`getVoices` counts as having no voice, since locality can't be told. With no on-device voice
the button isn't drawn (`useCanSpeak` in `useSpeaker.js`), and losing the last one while
speaking stops the speech. Also Ultron's other two 11-15 lows on board 9e0b1c52: the search
jump `reach()` in `useChat.js` is single-flight (`singleFlight()` in `chat-search.js`, held
in a ref; a second pick while one loads answers `busy`, which `Chat.jsx` ignores so the first
jump's outcome lands), and `loadOlder` returns 0 while a jump loads. Search rate limiting was
left alone, as briefed. **Verified:** web 287 tests (11 new: 9 speech, 2 single-flight),
server 1294 in local time and Tokyo, lint clean (only the old Lanes.jsx warning). 25
mutations: 24 caught; the survivor swaps the `Array.isArray` guard for `Array.from`, the same
for anything `getVoices` returns (a real array by spec). Built to a scratch `--outDir` (the
live `web/dist` mtime unchanged). Headless Chromium on a scratch server (2,300 seeded
messages, 390 px): 14 of 14 new checks (the network voice as default with an on-device one
listed speaks in the on-device one; only a network voice shows no button; an empty list that
fills in later shows the buttons; losing the on-device voice mid-speech stops it; two picks
of a 13-page jump load 13 pages, none of them the scroll-up loader's 50). A build with the
gate removed fails both jump checks (24 requests, one of 50). The 11-15 harness, with its
fake engine given an on-device voice, still passes 43 of 43. **Faked:** `speechSynthesis`
and its voice list (the headless shell has none). **Unverified (needs Jeff's devices):**
which voices iOS Safari and the Mac's Chrome actually list as on-device and which one is
picked; if an iPhone lists none as local, the button disappears there. **Device check:** on
the Mac's Chrome app, the speaker reads in a macOS voice (Samantha or the system voice), not
Google's; on the iPhone the button is still there and speaks. **Seen on the iPad (Jeff,
11-16):** it speaks, and changing the iPad's default voice in Settings did not change the
voice, so WebKit's `default` flag doesn't follow that setting (found 11-17: WebKit marks
every voice it lists `default: true`; see "The hint under the voice list" below). The voice
picker below is the answer.

**A voice picker in Chat settings, on main a751e1a (2026-11-16, from `jos/voice-picker`),
live with the 11-16 22:55 build (the live `web/dist` carries the picker; read 11-17), page
only.** Jeff, 11-16: "it didn't change the voice on ipad" after he changed the iPad's default voice.
A web page is never offered Siri voices, and the system setting doesn't reach the page, so
each device now picks its own. **What it is:** Chat settings (⋮, then Chat settings) has a
"Read-aloud voice" list, a native `<select>` (the iPad lists a hundred or more voices; the
system picker handles that and groups): "Automatic (<the voice today's order picks>)" on
top, then "Your language" (the page's `<html lang>` and `navigator.languages`: exact
matches in that order, then the same language in other regions), then "Other languages",
each row a name and the language by its name (`Intl.DisplayNames`, else the tag). On-device
voices only (`localService === true`), each `voiceURI` once; a voice with no `voiceURI`
can't be saved, so it isn't listed (Automatic may still use it). Beside the list a "Play a
sample" button speaks one sentence in the chosen voice from the tap itself; it reads "Stop"
while it plays and stops when the sheet closes. The pick is saved per browser in
`localStorage` under `jos.chat.voice`, as the `voiceURI` (`createVoiceStore` in
`web/src/lib/orbit/speech.js`): read once, and kept in memory, so with storage blocked or
full the pick holds until the app is closed and the next visit is Automatic.
`pickLocalVoice(voices, langs, saved)` uses the saved voice while it is listed and on-device,
else the order it always had. A saved voice that is gone is never erased: Automatic is shown
and used, a line says so, and the voice is the pick again when it returns. Picking a voice
stops whatever is speaking (it was queued in the old voice). `setVoice` takes only a voice on
the list as it is at that moment. The list follows `voiceschanged`, also with the sheet open
(`useVoices` in `useSpeaker.js`; the speaker hands out the same object until the content
changes, compared as JSON, because browsers return new voice objects on every call). Under
the list is a hint about which voices a web app gets. Its first wording ("Newly downloaded
voices show up after the app is closed and reopened. Siri voices are not offered to web
apps.") was wrong for Apple devices and is corrected in the next paragraph. With no on-device voice the section says read aloud is off in
this browser. **Choices to defend:** a `<select>` and not a custom list (one tap opens the
system picker; a hundred radio rows would bury the rest of the sheet); the sample doesn't
play by itself on a pick (iOS speaks only from a tap, and a `change` from the system picker
may not count as one); the installed app and Safari are two browsers to iOS, so each has its
own pick; no sync between devices, as asked. **Verified:** web 301 tests (37 in
`orbit-speech.test.js`, 14 of them new: the saved voice in `pickLocalVoice`, the list's
filter, order and names, language names, the store with missing, throwing and read-only
storage, and the speaker's saved voice, fallback, `setVoice`, stable `voices()` and sample).
91 mutations of `speech.js`: 89 caught, and the two no-op baselines survive as they should.
Mutation found four redundant checks, removed: a tie-break by listed order (the sort is
stable), an empty-tag guard, an inner try and a null check. Server 1294 in local time and
Tokyo. Lint clean (only the old Lanes.jsx warning). Built to a scratch `--outDir` (the live
`web/dist` mtime unchanged). Headless Chromium (the 1223 shell) on a scratch server with a
fake engine: 61 of 61, covering the list's order and groups, no network voice in it, the
pick saved and shown, the sample (words, voice, Stop, ending, stopping with the sheet), a
reply read in the picked voice, the pick surviving a reload, a voice arriving and leaving
with the sheet open, a saved voice missing at load, Automatic clearing the saved key,
storage that throws and storage that refuses writes, only a network voice, an empty list
that fills, and at 360, 390, 820 and 1440 (light and dark) the list and button on one row
inside the sheet, 44 px tall, 16 px text, no sideways scroll, the button the same width as
Play a sample and as Stop (it first jumped 7 px; fixed with a `min-width`). 13 page-level
mutants (builds with one thing broken): 12 fail that check; the 13th, the list given the
saved voice in place of the one in use, is equivalent, because React shows a `<select>`'s
first option when its value matches none. The two earlier harnesses still pass on this
build (14 of 14 and 43 of 43). **Faked:** `speechSynthesis`, its voices and
`voiceschanged`; Chromium, not WebKit. **Unverified (needs Jeff's iPad and iPhone):** which
voices iPadOS lists and under what names (built-in ones only, per the 11-17 finding below,
but compact and super-compact versions of one voice may still show as two rows with the
same name); that the system picker shows the two groups; that
`u.voice` set to another voice is honoured by WebKit (if it isn't, the sample plays in
the old voice whatever is picked, and that is the finding to report); that a `voiceURI` is
the same after an iPadOS update (if not, the pick falls back to Automatic with the line);
and the claim about Siri voices, which is Jarvis's brief and WebKit's known behaviour, not
something I measured. Whether a downloaded voice needs the app closed and reopened is
answered: on iPhone and iPad it never appears (below). **Go-live:** done 11-16 (C&P, then
`cd web && npm run build`; no server change, no restart). **Device check for Jeff:** on the iPad, ⋮, Chat
settings, Read-aloud voice: pick a voice, tap Play a sample, close the sheet, tap the
speaker on a reply; close and reopen the app and the pick is still there. Same on the
iPhone, which keeps its own pick.

**The hint under the voice list, corrected 2026-11-17 (`jos/voice-hint`, merged as main
ad91e42 and built the same morning, per Jarvis), page only.** The picker told Jeff that newly downloaded voices show up after the app is closed
and reopened. On Apple devices they never do. **The WebKit finding:** WebKit offers a page
only the voices the system ships with. `PlatformSpeechSynthesizer::appendVoices` in
`Source/WebCore/platform/cocoa/PlatformSpeechSynthesizerCocoa.mm` (lines 341 to 347 on
WebKit's `main`; Jarvis read it 11-17 and so did I) adds a voice only
`if (voice.isSystemVoice)`. That is WebKit bug 203689, in since 2019, to give a page less to
fingerprint a device by (the bug number and year are from Jarvis's brief). So a voice downloaded in Settings (Enhanced or Premium) is never on
the list in Safari or the home-screen app on an iPhone or iPad, whatever is closed or
restarted, and no page code can change that. The file is under `platform/cocoa`, so Safari
on the Mac should behave the same (not checked). Siri voices aren't offered either, as
before. Chrome on the Mac uses its own engine and lists every installed macOS voice
(Jarvis's 11-17 brief; not measured by me), and a fresh download probably needs Chrome
restarted (unconfirmed, which is why the hint says "if … is missing" and doesn't promise).
**The hint now reads:** "On iPhone and iPad, web apps are offered only Apple's built-in
voices; downloaded Enhanced and Premium voices and Siri voices can't be used here. On the
Mac, restart Chrome if a newly downloaded voice is missing." It is one line of
`VoicePicker` in `web/src/orbit/Chat.jsx`, the same on every device (no device sniffing).
**"Automatic" on Apple devices:** that same WebKit line creates every voice with
`localService` true and `isDefault` true. So on WebKit every listed voice counts as
on-device (the on-device filter drops none), and every one says `default: true`, which is
why the flag never followed Jeff's Settings change. `pickLocalVoice` takes the first
on-device voice whose `default` is true, so on an iPhone or iPad "Automatic" is simply the
first voice WebKit lists; the language steps after it are never reached there. The list
names it: "Automatic (<name>)". No code change was made for this (Jarvis's brief). If that
first voice turns out to be a poor one for Jeff's language, the fix would be to stop
trusting `default` when more than one on-device voice claims it and go by language, a small
change in `pickLocalVoice`. **Verified:** web 301 tests, as before (no test in the repo
pinned the wording, and components have no unit tests); lint clean (only the old Lanes.jsx
warning); built to a scratch `--outDir` (the live `web/dist` mtime unchanged). The 11-16
headless picker check, with its hint line changed to want the new sentence whole and the
old one gone: 62 of 62 on Chromium (the 1223 shell) on a scratch server, at 360, 390, 820
and 1440; against the 11-16 build it fails exactly those two hint checks (60 of 62). At
360 px the hint wraps to four lines inside the sheet, with no sideways scroll. **Unverified:**
the hint on Jeff's devices; whether Chrome on the Mac needs a restart to see a new voice;
which voice WebKit lists first on the iPad and iPhone (what Automatic names there).
README's "Read aloud and search in the Chat tab" bullet was corrected in the same commit.
**Go-live:** done 11-17 (C&P, then `cd web && npm run build`; no server change, no
restart). While the Mac's own voice is on offer (next paragraph) the hint has a second
wording.

**Read aloud in the Mac's own voice, on `jos/mini-voice` (from main ad91e42, 2026-11-17,
worktree `~/Projects/.worktrees/ccr-mini-voice`), staged, not committed. Ultron read it
11-17: go with fixes, one medium (M1) and seven lows (L1 to L7), all made the same day and
listed under "Ultron's fixes" below; his reread of those is next, then C&P, a config key,
a restart and a web build.** Jeff wants
read aloud in a Premium or Enhanced Apple voice on the iPhone, the iPad and the Mac
("Sure, start with Evan enhanced", 11-17). WebKit never offers a page a downloaded voice
(the paragraph above), so the words are spoken on the mini by `/usr/bin/say` and the page
plays the audio. His rule from 11-16 holds: no cloud or network speech; the mini is his
own machine on his tailnet, which he accepted for this. README's "Read aloud in the
Mac's own voice" bullet has how it works and every limit; this paragraph keeps the threat
model for the review, the choices, what was checked and the go-live steps.
**Built:** `server/lib/chat-speech.mjs` (the route `GET /api/chat/speech/<message id>` and
`/sample`, the voice list and pick, the render, the cache, the limits) with
`server/test/chat-speech.test.mjs`; `server/lib/chat-speech-config.mjs` (the config rule and
the cache's clean-up when speech is off: what `server.mjs` needs at every start, with no
page code behind it); `server/lib/chat-routes.mjs` hands the path
to it and puts `speech: { voice, wanted, exact } | null` in every status;
`server/server.mjs` loads it with `await import()` only when config has `chat.speech`,
with the cache under the 0700 state folder and the kill file `speech-off`; on the page `web/src/lib/orbit/speech.js` (the
speaker plays the Mac's audio through one `<audio>` element, falls back to
`speechSynthesis`, and keeps which side reads under `jos.chat.voice.engine`),
`web/src/orbit/useSpeaker.js`, `Chat.jsx` (the button's loading state, "Mac mini voice
(Evan)" on top of the picker, a line naming the voice in use) and `orbit.css` (the pulse).
**Threat model (for Ultron).** *Who can call it:* a paired device with the owner's login
header, the same as every chat route (`requireDevice`), with `GET` only, and a
`Sec-Fetch-Site` that is `same-origin` when a browser sends one; the device cookie is
`SameSite=Strict`, so another site's `<audio src>` or link arrives without it. An unpaired
caller gets 401 for every path under `/api/chat/speech`, known or not. *Inputs from the
client:* the message id in the path, matched by `^/api/chat/speech/(sample|m_[a-z0-9]{6,24})$`,
and a `Range` header parsed by one anchored pattern (one range; anything else sends the
whole body). Nothing else is read: no body, and the query string is ignored (tested with
`text=`, `voice=`, `o=`, `f=`). *What is rendered:* the text of one message from the chat
store with `from: jarvis` and `kind: chat`, or the fixed sample sentence. That text is the
lead's, and the lead quotes things from outside (mail, web pages, files), so it is treated
as hostile to `say`: Markdown is dropped by the page's own `speechText`, then `speakable()`
makes a lone surrogate well formed, takes the text apart into its compatibility form
(NFKD), removes every `[`, `]`, `<` and `>`, puts it together again (NFC), and removes
every control, format, separator, surrogate, private-use and unassigned character. Measured: `say` obeys `[[slnc 3000]]` and
`[[rate 60]]` from a file, and it obeys a tag too, `<break time="5s"/>` giving the same
five seconds of silence on Evan and on Samantha, so a quoted `[[slnc 9999999]]` or
`<break time="9999s"/>` would have made a huge silent file. With the brackets gone only
the words inside are read. Not obeyed, each measured: the same commands in fullwidth,
small, vertical, single-guillemet, mathematical or CJK brackets, and a tag written as
`&lt;…&gt;` or `&#60;…&#62;`; NFKD folds the first three spellings to the plain ones
anyway, so the strip never depends on what a later macOS decides to obey. NFKD and not
NFKC (Ultron's N2): NFKC composes `<` and U+0338 into U+226E, and `>` and U+0338 into
U+226F, after which the strip no longer saw a bracket. Measured on Evan: `say` given
U+226E raw reads it as words, and given a raw `<` + U+0338 … `>` it swallows the whole
tag in silence without obeying it; after the strip both are a few words. At most 12,000
characters reach `say`. *The process:* `/usr/bin/say` through
`execFile`, never a shell, with `env: {}`, the work folder as its directory, 45 s then
SIGKILL (tested on a real child that ignores SIGTERM), 64 KB of output kept. The argument
list is fixed (`--voice=<name>`, `-o <out>`, `--file-format=m4af`, `--data-format=aac`,
`-f <in>`); the two paths are the server's own, inside a fresh `mkdtemp` folder in the
cache; the words are in the 0600 file, never an argument. *The voice:* config's
`chat.speech.voice` and `fallback`, each checked against a name pattern that can't start
with a dash, then used only if `say -v ?` itself printed that name (the request has no
say in it). The second `say` call is that listing (`-v ?`, 10 s limit), at most once per
10 minutes; one failed listing keeps the voice that was known, two in a row make it
unknown (503, and `speech: null` in the status) until a listing works. A source test holds
the module to those two calls and to no `shell`, `exec`, `spawn` or `process.env`, and
holds the two page files it runs to the same and to no import but each other. *Page code
in the server:* `web/src/lib/orbit/speech.js` and `markdown.js` run in the server process
once speech is on. They are loaded only then, by a dynamic import inside a try/catch, so
a syntax error or a new bad import in either turns read aloud off with one log line and
never stops the Control Room's start; a test walks `server.mjs`'s static imports and
finds nothing outside `server/`, and walks `chat-speech.mjs`'s and finds exactly those
two files. **Both files are server code from here on: review them as such, and restart
after a change to either** (the Restart card watches `server/` only). *The result:* must be a file that begins like MPEG-4 (`ftyp`),
not empty, at most 16 MB, before it is moved into the cache; anything else is a 502, a
timeout a 504, and the answer never carries a path, the words or `say`'s own output.
*The cache:* `~/.local/state/jarvis-os/speech-cache/`, made 0700 and refused when the path
is a link or not a folder; files 0600, named by a SHA-256 of the cache version, the voice
and the words (no id or text in a name); swept after every render, at start and once an
hour on an unref'd timer (7 days since last played, 400 files, 200 MB, oldest first; stale
work folders after 10 minutes). At a start with speech off the cache's own files are
removed, and the folder when that empties it (`clearSpeechCache`: same two name shapes, no
link followed, a link in the folder's place left alone).
The sweep removes only names of its own two shapes and never follows a link. It holds
the lead's replies as speech, which is no more than `server/data/chat` already holds as
text, in a folder as private. *Limits:* one `say` at a time, 3 waiting, then 503; 12
render starts per device per 5 minutes, then 429; 300 render starts a local day across
every device, then 429 until midnight, logged once (refusals aren't counted; cached audio
and joins aren't either); a render `say` failed is remembered 10 minutes in memory (100
wordings at most) and answered the same with no process; the status and the route check
the kill file every time. The device is checked again just before the audio is sent, so
one revoked during a render gets a 401. A render under way is looked for before the cache
is read and again after, so the same words are never rendered twice at once. The audio
carries `Cross-Origin-Resource-Policy: same-origin`.
*Left open, on purpose:* a paired device can replay cached audio as often as it likes
(the same holds for `/api/chat/attachments/<id>`); `say` and the system speech service
parse the words, and that parser is Apple's; the remembered failures and the day's count
are in memory, so a restart forgets both. *Not a boundary:* `say` gives no sign of the voice it used, so "the listed name
was passed" is all the server can vouch for.
**Choices to defend:** (1) the whole message is rendered at the first tap, not split:
Evan (Enhanced) renders 2,000 characters in 1.8 s and the 12,000-character limit in 7.4 s
(measured on the mini 11-17, best of two each; Samantha is the same within 0.2 s), and one
file keeps the page to one `<audio>` and one request. (2) Over 12,000 characters the Mac
refuses (413) and the device's own voice reads all of it, rather than the Mac reading a
cut-off part. (3) The cache is keyed by voice and words, not message id and voice as the
brief said: it covers edits, and two messages with the same words share a file. (4) The
server imports `speechText` from `web/src` (one source for what is spoken); the server has
never imported page code before, which makes those two files server code (above), and
`mutate.py`-style copies of `server/` now need `web/src` and `web/package.json` beside
them. (5) Off unless config has `chat.speech`. As first staged this was only half true:
`server.mjs` imported the module at the top, so the two page files were loaded at every
start and a broken one would have stopped the server with speech off (Ultron's M1). Now
the module is loaded only with the key present, so merging and restarting without the key
loads none of it, and the one thing a keyless start does that it did not before is remove
an old speech cache if there is one. (6) The Mac's voice is the
default on every device, even one that had picked an on-device voice before (that pick is
kept as what reads when the Mac can't); a device opts out by picking one of its own voices
while the Mac's is on offer. (7) After a failure the page reads in the device's voice for
30 s, because a fallback that starts outside the tap may be refused by mobile Safari, and
a second tap then speaks at once. (8) Audio that breaks off after it started is not
started over in another voice. (9) `no-store` on the audio, like attachments: a revoked or
lost device keeps no copy; a replay asks the mini again (cached there). (10) With the
wanted voice missing the stand-in order is config's `fallback`, the voice's plain name,
Samantha, Daniel, and never whatever else is installed (the novelty voices). (11) The hint
under the list has a second wording while the Mac's voice is on offer ("…which is why the
Mac mini reads by default"), since the 11-17 sentence said Enhanced voices "can't be used
here" right under a picker that now defaults to one.
**Found on the way (11-17, all measured on the mini):** `say` exits 0 and reads in the
system voice when the voice name isn't installed, and when the text file is empty it
exits 0 and writes no file. The Eloquence voices (Eddy, Flo and the like) are listed but
can't write a file: `--voice='Eddy (English (UK))'` produced Daniel's audio byte for byte.
A voice installed in two sizes is listed twice under one name with its language in
brackets ("Samantha (English (US))"); during this build Samantha and Daniel went from one
entry each to two (a compact one beside the super-compact), at about the time `say` was
first run with them here and Jeff downloaded Evan in Manage Voices, so which of the two
caused it is not known. `say` takes no AAC bit rate above about 32 kbit/s at the voices' 22,050 Hz
(`--bit-rate=64000` gives the same file), so the format is the default. And the one the
review's test request turned up: `say` obeys `<break time="…"/>` as well as `[[slnc …]]`,
which the first staging did not strip.
**Ultron's fixes (11-17, all eight made):** M1, the module and its two page files are
loaded only when config has `chat.speech`, by `await import()` in a try/catch (one log
line, speech off), with `readSpeechConfig` moved to `chat-speech-config.mjs`; tests for the
import graph both ways and for what the page files may contain. L1, NFKC before the strip,
and angle brackets stripped too (the tag finding above). L2, failed renders remembered 10
minutes (100 at most). L3, an hourly unref'd sweep, the cache removed at a start with
speech off, and the rollback below names the folder. L4, 300 renders a local day across
devices. L5, the device checked again before the send. L6, the render under way looked
for before the cache read and again after. L7, two failed voice listings in a row make
the voice unknown, and the audio carries `Cross-Origin-Resource-Policy: same-origin`.
**Ultron's reread (11-17): go, M1 and L1 to L7 closed, three new lows, all made.** N1,
the running server never made the cache folder again (only `prepare()` did), so a hand
`rm -r` or another server's keyless start meant 502 until a restart, each tap charged to
the device and the day and remembered 10 minutes. Now the folder is checked before every
render exactly as at start (`ensureFolder`: made 0700, a real folder, never a link) and
made again when gone, with one log line; a path that goes missing under a render (the
work folder, `say`'s own output) is put down to the folder, which is made again and the
render tried once more; and any failure that is the server's own is neither remembered
nor left charged (`uncharge` takes the start back off the device's window and the day).
A file or a link where the folder should be fails each render with a plain 502 and no
process. Not rechecked: a read of an already cached file goes by path alone. N2, NFKD,
strip, NFC in place of NFKC (above). N3, the import reader in the tests takes `import (`
with a space or a line break before the bracket, and has a test of its own.
**Verified for N1 to N3:** server suite 1,334 tests (40 in `chat-speech.test.mjs`), once in
local time and once in `TZ=Asia/Tokyo`; the 26 mutants on the changed lines (17 for N1, 6
for N2, 1 for N3, and 2 of L2's rewritten for the new line beside them) all fail an
assertion. Three of N1's first survived (a timeout with the folder gone, the whole window
given back, a start no longer in the window), which bought two tests. The full mutant run
before those tests (179 of the server side) had the same three, the two that no longer
parsed, and the one equivalent named below. The web suite and the headless check were not
rerun: nothing under `web/` changed. The paragraph below is the round before, as it stood.
**Verified (after the eight fixes):** server suite 1,330 tests (main had 1,294; the 36
new ones are `chat-speech.test.mjs`), passing in both time zones, three full runs. Web 316
(301 before), both time zones; the page did not change in the fix round. Lint clean but
for the old Lanes.jsx warning. One server test runs the real `/usr/bin/say`: a short reply
comes back as an MPEG-4 file, and three asks for a minute of silence in it (`[[slnc
60000]]`, the same in fullwidth brackets, `<break time="60s"/>`) add none (the file stays
under 150 KB; one obeyed would add over 200 KB). Mutation, with the tool rebuilt to copy
`web/src` too: 155 mutants of the server module, its config module and its wiring, 53 of
them for the fixes: 151 fail an assertion, 3 hang the queue test until its time limit,
and 1 is equivalent (counting a refusal against a day's limit that is already full). The
first run after the fixes left 5 standing: both halves of L6 (a stress test did not
catch them; planting a file under a running render's cache name, and two asks in one
tick, do), a voice said lost that was never known (now tested), a dead line (removed),
and the equivalent one. The 50 mutants of the page's speaker stand as before, none
surviving. M1 was also run for real on a scratch copy with a `markdown.js` that no longer
parses: the config module loads, the dynamic import fails with one `speech: could not be
loaded or started (SyntaxError)` line, and the script goes on. A first staging run of the
mutants had left 8 standing, which bought four assertions and the removal of three checks
that only hid behind others.
Headless Chromium (the 1223 shell) against scratch servers on port 8411 with the real
routes, the real `say` and Evan (Enhanced), the page's own `<audio>` element really
playing the server's file: 108 of 108. They cover: a tap plays the message's audio
(same-origin, cookie sent, `Sec-Fetch-Dest: audio`, `Range: bytes=0-`), no word from the
device's voice, idle at the end, a second tap stops, another message takes over, hiding
the page stops, one render per message; a 1.5 s slow answer shows the loading state and
the pulse, and a tap while loading stops with nothing playing late; a 500 hands the same
words to the device's voice and the next tap goes straight there with no request; the
kill switch takes the Mac's voice out of the picker within a status and puts it back;
the picker at 390, 430, 820 and 1440 px, light and dark, with Evan installed and with a
voice that isn't (the stand-in wording): the Mac's voice on top and selected, the line,
nothing stored for the default, no sideways scroll, the sample (plays, Stop keeps its
place), choosing the device's voice and back, surviving a reload; a browser with only a
network voice and one with no speech engine at all (the button still shows and plays;
when the Mac fails it goes idle); this page on a server without speech (as before); the
page that is live now on this server (as before); no policy violation and no console
error anywhere. 13 page-level mutants (builds with one thing broken) all fail that
check. The headless run was repeated after the fixes (108 of 108). The live `web/dist`
was never built by me (its 11-17 09:04 change is the hint's go-live).
**Unverified:** anything on Jeff's devices: that Safari and the home-screen app play the
`audio/mp4` (Chromium only here; the byte-range answers are what Safari is known to ask
for, tested by hand-made `Range` headers, not by Safari); that `play()` with a slow first
answer counts as started inside the tap on iOS; the silent switch; whether the fallback
`speechSynthesis` call made after a failure, outside the tap, speaks on iOS (if not, the
second tap does); a lock screen or a phone call mid-audio; the pulse and the picker's
wording on the real screens. On the mini: `say` from the LaunchAgent's own session (every
render here ran from my shell; the service's first `speech:` log lines after the restart
will tell), and `server.mjs` beyond its source test (never started whole). The voice by
ear: nobody has listened to a file yet.
**Go-live, in this order:** (1) Ultron reads the route (this paragraph and
`server/lib/chat-speech.mjs`). (2) C&P of `jos/mini-voice`, merged to main. (3) Jarvis adds
`"speech": { "voice": "Evan (Enhanced)" }` inside the `chat` block of `server/config.json`
(after a backup copy). (4) A restart of the service (Jeff, or loop 3's Restart card, which
shows after a `server/` merge). The log then says `speech: on, asked for Evan (Enhanced)`
and `speech: reading in Evan (Enhanced)`; `ls -ld ~/.local/state/jarvis-os/speech-cache`
shows `drwx------`. (5) `cd web && npm run build` in the main checkout. Either order of 4
and 5 is safe: the new page on the old server and the old page on the new server both read
in the device's own voice (checked both ways). (6) Jeff's check on each device: tap a
speaker (it pulses, then Evan reads), tap again (stops), Chat settings shows "Mac mini
voice (Evan)" selected and Play a sample plays; the log shows one `speech: read … in Evan
(Enhanced) for <device> (… ms, … bytes)` line per new message. **Rollback without a
restart:** `touch ~/.local/state/jarvis-os/speech-off` (pages go back to their own voice
within 20 s; the cached audio stays and ages out, or remove it by hand:
`rm -r ~/.local/state/jarvis-os/speech-cache`; with the kill file there nothing is
rendered, and once it goes the running server makes the folder again at the next render
and logs `speech: the cache folder was gone; made it again`, with no restart). For good: remove the config key and restart; that start removes
`~/.local/state/jarvis-os/speech-cache` itself and says so in the log (check with
`ls ~/.local/state/jarvis-os/`, and remove the folder by hand if anything else was in
it). **A suggestion for Vision, not done here:** leave `speech-cache` out of Time Machine
(`tmutil addexclusion`), since it is a rebuildable cache of the lead's replies as audio
and would otherwise be kept in backups past its 7 days. **Follow-ups, not built:** a
play/pause and a position bar (the audio is a real file now); pre-rendering the newest
reply when it arrives so the first tap is instant; splitting, only if a slower voice is
ever picked; the Mac app's own check that Chrome plays it.

## 11. Limit warnings: a push before a Claude limit runs out (board 1e2d7926; merged 2026-11-17 as main 151b5ff, Ultron's six fixes in)

**Merged as main 151b5ff (built on `jos/limit-alert`, from main 404ec29); live per
Jarvis's 11-17 brief, not checked from here.** Jeff, 2026-11-17, after two agent runs took the session
limit from 3% to 100% in three hours and one died mid-fix: "so i guess we just bulled right
into the session limit without a warning". The README's "Limit warnings" (under "Push
notifications") is the reference; this is what is left and what to defend.

- **What was found first.** A warning did exist: the alert bar's 85% line. The service log
  shows one post to `#pepper` at 10:47 that morning, five minutes after the 87% reading
  (the post's words were not read back, so that it was the limit line is inferred from the
  timing). It reached no device: `#pepper` is a read-only feed, and nothing suggests an
  ntfy topic is set. The gap was the channel, not the threshold alone.
- **What is built.** The session at 80% and 95%, each weekly limit at 90%, once per window,
  to three places: a Web Push to every paired device (the part that reaches the phone),
  ntfy and `#pepper`, and an event to the lead. Server only: no page change, no web build,
  no config, no new `claude -p`.
- **Ultron's read, 2026-11-17: go with fixes, one medium and five lows, all made the same
  evening and awaiting his reread.** (1, medium) The device push was one-shot: a `#pepper`
  post marked a warning told even when no device got it. The device leg is now tracked on
  its own (`limitWarning` answers `{ tried, reached, missed }`) and a missed device is
  tried again alone, with no second alert, up to three times or until the window
  resets (spaced by time since §13). (2) A backstop under the keys: one telling per limit
  in 30 minutes unless its step rises, 12 per limit in 24 hours, and a key with no reset
  time is kept five hours (or until a real reset is read, since §13).
  (3) An event's words are checked on the way out too, with `a limit warning` as the
  fallback. (4) One held copy per alert in quiet hours. (5) A notifier pass runs right
  after each usage poll (the registry's `then`). (6) The config refusal names `limit`.
- **Where I chose differently from his suggestion, to confirm on the reread:** the daily
  cap is 12 per limit, not 12 in all. Any 24 hours can touch six session windows of two
  steps each, which is 12 honest tellings of the session alone, so a cap across all three
  limits could put off a real weekly warning on a heavy day. A warning over a cap is put
  off, not dropped. Not fixed, as he did not ask: a dip inside a window still makes a
  second event to the lead by day (the event ledger forgets a cleared key; the push
  ledger does not), bounded by the events' own caps.
- **To go live:** Ultron's reread, C&P, then a restart of the server (Vision's scope;
  the notifier and the push service are wired at start). Nothing else to set.
- **After the restart, check:** (1) at the next 80% of a session, the log has `push: a
  limit warning went to N of N devices` and the phone shows "Claude session at 8x%, resets
  h:mm pm" titled Control Room, within about five minutes of the reading (a notifier
  pass now follows each poll); (2) one
  `[discord] posted` line beside it, and never a second one for the same step; (3) the lead got
  one event line with the same words (its tag says `source="limit"`, `event="unknown"`
  until the channel learns the name); (4) no second push for that step in the window, and a
  second one at 95%. **Not verified on a device:** how iOS shows a Declarative Web Push with
  no `app_badge`, and that a tap lands on the Overview. Both were tested only as payloads.
- **Choices to defend.** (1) The Web Push body carries numbers, the first push that is not
  one of three fixed lines; the body is checked against one fixed shape at the push
  (`WARNING_BODY`), and a model's name from the panel is said only when plain and short.
  (2) The alert bar's `limit` line is no longer pushed for the session and weekly limits
  (the steps replace it; at 85% it landed between them saying the same thing). The page is
  unchanged. (3) No quiet hours on the device push, like every other alert push; the event
  to the lead does respect them, and a held one is dropped at 07:00 if it is no longer
  true. (4) Told means landed anywhere (devices, ntfy or `#pepper`), the notifier's old
  rule, so `#pepper` never gets a warning twice; the devices are owed it on their own
  (above). (5) The window is its reset rounded to
  10 minutes, because `/usage` prints a reset a minute apart between polls: all 61,717
  readings since 2026-08-06 end in :x9 or :x0. If Anthropic moves resets off that grid, the
  failure is a repeated warning, never a missed one. (6) A told key is kept until its
  reset, because the history holds 12 readings that dipped inside a window.
- **For Ultron's reread:** `runNotifier`'s loop and `readLimitState` in
  `collectors/notifier.mjs` (the debt, the caps, the one reserved entry
  `limit-step-state` in `notified.json`, which now also holds paired-device ids for a few
  passes); `limitWarning`'s `only` and its answer in `lib/chat-push.mjs`; `mayTell` and
  `keyParts` in `lib/limit-warnings.mjs`; `prune`'s no-reset rule; `eventText`'s second
  check and the held-copy replace in `lib/events.mjs`; the registry's `then`.
- **Checked:** server 1,382 tests (48 new), in local time and `TZ=Asia/Tokyo`. Mutants on
  the new logic: 116 on the first build, all caught, and after the fixes 116 on the
  changed lines plus the 98 of the first list that still apply and 8 replacements, all
  caught (eleven survived a first pass over the two rounds; ten now have a test and one
  was a dead guard, removed, as were two dead branches in the first round). No browser
  run: the page did not change.
- **Follow-ups, not built:** (a) the channel's `EVENT_NAMES` (the jarvis repo) does not
  know `limit-warning`, so the lead's tag reads `event="unknown"`; the words arrive all the
  same. (b) The event ledger's own once-per-window rule, so a dip by day makes no second
  event. (c) The steps and the caps in config, if Jeff wants other numbers. (d) What the lead does on the event (hold new agent
  runs past 80%, say) is Jarvis's rule to write, not this server's. (e) `sw.js` files a
  limit push under the chat's tag on iOS before 18.4; it changes with the next web build
  that touches it. (f) Found 2026-11-17 while sizing §13's reset mark: a key that names
  its window is kept until the printed reset even when the limit is reset early. It has
  happened once in 85,254 readings (2026-10-19: a weekly limit went from 93% to 0% eight
  and a half hours before its printed reset); had it climbed back to 90% in those hours,
  no warning would have gone out. The fix is §13's rule (forget a told key once its
  limit is read under 40%) for every warning key, not only the ones with no reset time.
  **Built 2026-11-18 (board b468ff61, Ultron in favour; §14).** Of the list above, (a) to
  (e) stay open.

## 12. The morning brief and the weekly digest in the chat (board ebce2df9, "Spoken morning briefing"; staged 2026-11-17)

**Staged on `jos/brief-chat` (worktree `~/Projects/.worktrees/ccr-brief-chat`, from main
151b5ff), not committed, not live.** Jeff OK'd the item on 2026-11-12 ("Keep building
jarvisos"): the weekday 07:30 brief and Monday's digest should also arrive in the Jarvis OS
chat as a message from Jarvis, so he can tap the speaker and hear it in the Mac mini's
voice. The README's "A routine's message in the chat" is the reference (the call, the
answers, what keeps it narrow); this is what is left and what to defend.

- **What was found first.** The brief reaches Discord only: `jarvis/routine.py` posts it
  with `discord_post.post`, headless from launchd, outside Jarvis's session, so it has no
  channel to reply through. The channel's own way in (`POST /v1/reply` on `channel.sock`)
  needs the session token of the one channel holder, which a routine must never have. The
  ingest socket (board ba1b8446, on main) is the existing local-only way in: 0600 in the
  0700 folder, started whether or not the chat is on, refused on the TCP port.
- **What is built.** One new route on that socket, `POST /api/ingest/routine-chat`, body
  `{ kind: "brief" | "digest", text, id? }`, in `server/lib/routine-chat.mjs` (the check,
  the cleaning, the limit, the kill file) with a short branch in `routes.mjs` and the
  wiring in `server.mjs`. The message is stored as `from: "jarvis"`, kind `chat`, with
  `meta: { routine: <kind> }` and the kind's title in bold on top, because that is the one
  shape the page's stream, Web Push (`chat-push.mjs` pushes the lead's chat messages) and
  read aloud (`chat-speech.mjs` reads only those) already take: no change to any of the
  three. No config key; on whenever the chat is.
- **Two side effects found and closed.** A message from the lead used to answer whatever
  the owner had asked before it: a brief at 07:30 would have dropped an unanswered 07:25
  message from the channel's catch-up after a restart (`unanswered()`), cleared the
  page's "slow" state (`lastJarvisAt`), and shown two ticks on the page. `answersOwner`
  in `chat-store.mjs` and `tickFor` in `web/src/lib/orbit/chat.js` now leave out a
  message carrying the mark. The second is page code, so **the merge needs a web build**.
- **Choices to defend.** (1) A route on the ingest socket, not a new socket or a token:
  nothing to mint or leak, and the folder and file checks are already there. (2) The
  characters that hide or reorder text are removed, not refused: one zero-width space in
  a headline the digest quoted should not cost Jeff the whole message; the answer and the
  log count what was removed. The zero-width joiner and U+FE0F stay, for emoji. (3) The limit
  is 3 of a kind per 24 hours, counted from the store (a run, a rerun, one spare; two
  07:30 runs can fall inside one 24-hour window). (4) `id` is optional: with the run's
  date as the id a second run the same day adds nothing; without one a rerun adds a
  second message. (5) Unknown body fields are refused, so nobody believes `from` or
  `replyTo` does something. (6) The text cap is 11,900 characters, under the Mac voice's
  12,000 with the title. (7) No CLI: the routine is Python and the call is one POST over
  `AF_UNIX` with the standard library, with no `node` to find from launchd.
- **What Jarvis wires (the jarvis repo, not touched here).** In `routine.py`, after the
  Discord post succeeds for a kind in `discord_post.FEED_KINDS`: POST `{kind, text: body,
  id: day}` to `~/.local/state/jarvis-os/ingest.sock` with a 10 s timeout, treat any
  failure as a note in the run's detail (never a failed run), and skip it on a dry run.
- **Go-live.** C&P, the merge with a web build, a service restart (Vision or Jeff). The
  log then says `routine-chat: on; the brief and the digest post to the ingest socket`.
  Off switch with no restart: `touch ~/.local/state/jarvis-os/routine-chat-off`.
- **Tests.** `server/test/routine-chat.test.mjs` (22: the body, the cleaning, the store,
  never down the channel's stream, the limit across a restart, five at once, the id and
  an id held by another message, the prefix refused on the three other ways in, the
  history call over a real channel socket, the kill file, the socket's answers, the TCP
  refusal, a real encrypted push, a source test on the wiring),
  `web/test/orbit-chat-routine.test.js` (4), one line each in `ingest-socket.test.mjs`'s
  every-route list. Server 1,404 pass in local time and in `TZ=Asia/Tokyo`; web 320. 74
  mutations of the first build, all caught (one first-pass survivor was a dead clamp,
  removed), and 41 on the lines the fixes changed, all caught. A scratch socket run with
  Python's `http.client` and with `curl` + `jq` answered as documented (first build).
- **Not verified here (needs the live service and a device):** the brief showing on the
  iPhone and iPad, the push arriving, and the speaker reading it in the Mac's voice. The
  page was linted and built to a scratch folder, not run in a browser: the page changes
  are the one condition in `tickFor` and the "routine" mark in the bubble's meta row,
  whose look on a device is unseen.
- **Ultron's 11-17 read: go to commit with four fixes, all made the same night.** (1) The
  channel's history call answers a routine message as `from: "system"` (`historyMessage`
  in `chat-socket.mjs`), since the channel prints the lead's messages as "me:"; the store
  and the page keep it the lead's. (2) The bubble carries a small "routine" mark from
  `meta.routine` alone (`routineWord` in web `chat.js`, one line in `Chat.jsx`, the
  existing `.o-chat-via` style). (3) The hand-written character list is gone: the
  shared `hidden-chars.mjs` set through a new `stripHiddenChars`, keeping tab, newline,
  U+200D and U+FE0F, so the zero-width non-joiner, the soft hyphen and the other
  variation selectors now go too. (4) A duplicate is only an earlier routine message of
  the same kind, an id held by anything else blocks nothing, and `isClientId` (the page,
  the Shortcut keys, the channel's reply) refuses the `routine:` prefix; the store's own
  append still takes it. His re-read of these is pending.
- **Follow-ups, not built:** (a) the channel can give routine messages its own label in
  `historyLine` (the jarvis repo, Jarvis's). (b) The scout and the sweep are not on the
  list of kinds; adding one is a line in `ROUTINE_KINDS` and one in the page's list.

## 13. Hardening batch: Ultron's lows on what went live 11-17 (staged 2026-11-17 on `jos/hardening-1117`)

**Staged, not committed, on `jos/hardening-1117` (worktree `~/Projects/.worktrees/ccr-hardening`,
from main d715846).** The brief named the branch `jos/hardening`; that name was taken by a
merged 11-11 branch, left as it is. Four board items, server only: no page change, no web
build, no config, no new `claude -p`. The README's "Limit warnings", "A routine's message
in the chat" and "Read aloud in the Mac's own voice" are updated and are the reference.

- **Config backups ignored (board c109668a).** `.gitignore` has `server/config.json.bak-*`.
  The two such files in the main checkout were not opened, moved or removed. After the
  merge, `git status` there no longer lists them.
- **Limit warnings, five lows (board 0dcdb867).** (a) A told key with no reset time
  (`...:-`) is forgotten as soon as its limit is read under 40% (`RESET_BELOW_PCT`, half
  the lowest step), not only after five hours: with no reset time every window has the
  same key, and the old one hid the next window's warning. The five hours stay for a dip.
  Sized on the history: of 85,254 readings, no limit that had reached a step was read
  under it again in the same window, but for one early reset (§11, follow-up f). (b) A
  missed device's three later tries are at least four minutes apart (`DEVICE_RETRY_GAP_MS`,
  the debt's new `at`), not one a pass: a pass after the poll and one on the tick can be
  seconds apart. A debt written by the version before (no `at`) is due at once. (c)
  `notified.json` is written through a temp file and a rename, 0600
  (`lib/sent-store.mjs`, the same pattern as the ledgers); a read of anything but an
  object is `{}`. (d) When a higher step is told, the debts under the keys it covers are
  dropped, so no late 80% line follows a 95% one. (e) A notifier pass asked for by the
  usage poll while a pass is under way is not lost: one more pass follows it. Only the
  registry's own `then` run does this; a timer's run that meets one under way is skipped
  as before. And the comment on the daily cap now says twelve is exactly what a limit
  can need.
- **Mini voice, N4 (board e4d7575a).** The log's `failed` line is held to one a minute
  (`FAIL_LOG_MS`), the next one saying how many went unsaid; a clock set back never holds
  it. `uncharge` stops the day's count at zero: two starts either side of midnight, both
  taken back, left the new day one render over its limit.
- **Routine chat (board 0c096bd1).** The credential check reads the text as stored and
  again without U+200D and U+FE0F, the two kept characters that draw as nothing. Both
  readings are needed: a joiner can also be the word boundary a pattern wants. What is
  stored is unchanged.
- **Choices to defend.** (1) 40% is a constant, not half of each key's own step: one
  number for "this window is new". (2) (a) is for `:-` keys only, as asked; follow-up (f)
  in §11 is the same rule for the rest (built 2026-11-18, §14). (3) A try held by the gap counts as `skipped` in
  the pass's result and uses up none of the three. (4) An unreadable `at` is 0, "long
  ago", so the next pass tries. (5) `sent-store` takes the temp file's suffix as an
  option, only so a test can plant a link under the name. A link planted there is
  removed by the failed write's cleanup; what it points at is never written. (6) The
  rerun comes after a failed pass too. (7) The throttle is one line a minute for every
  render failure, `say`'s own too (those are remembered, so they rarely repeat).
- **To go live:** Ultron's read, C&P, a merge, then a restart of the server (Vision's
  scope; every change but `.gitignore` is server code loaded at start). **After the
  restart, check:** within five minutes `ls -l server/data/notified.json` shows
  `-rw-------` and no `notified.json.tmp-*` sits beside it. The rest shows only when a
  warning misses a device or a render fails.
- **Checked:** server 1,429 tests (25 new), in local time and `TZ=Asia/Tokyo`. 73 mutants
  on the changed lines: 72 caught, one equivalent (reading the limits from the raw
  snapshot instead of the current one; a panel that is not current keeps every key
  anyway). Two redundant guards found while listing them were removed, not tested. No browser
  run and no web suite: nothing under `web/` changed. Nothing ran against :8322, the
  live config or the live `say` service.

## 14. Cleanup batch: the first dashboard removed, and three limit-warning follow-ups (merged 2026-11-18 as main 6e1e5b3)

**Merged as main 6e1e5b3 (built on `jos/cleanup-1118` from main cf00c20); whether the web
build and the restart below have happened, I have not checked.** Ultron's lows on it are
done in §15. Two board items Jeff released on 2026-11-18. The README's opening,
its panel table ("Shown" says page or mod), "The Orbit page" and "Limit warnings" are
updated and are the reference.

- **The first dashboard is deleted (board bf5f1bf1; Orbit plan, Phase 5, second half).**
  Gone: `web/classic.html`, `web/src/main.jsx`, `web/src/App.jsx`, the 18 components
  under `web/src/components/` that only it used, `web/src/styles/` (`app.css`,
  `tokens.css`), the Archivo font (only `tokens.css` loaded it) and the `classic` entry
  in `web/vite.config.js`, which now builds one page. Kept, because the Orbit page uses
  them: the three hooks, `lib/due.js` and `lib/format.js` (each cut to what it still
  exports: `byDue`, `hasDue` and every formatter but `envelopeOf` went), the Geist
  fonts, and the error boundary, which moved to `web/src/orbit/ErrorBoundary.jsx`.
  Nothing on the server changed but three comments: every panel the old page read is
  still sent, because the mod draws them.
- **`/classic.html` is not a 404.** The brief expected one "like any missing page", but
  this server answers every unknown path under the web root with the page (the
  single-page fallback that keeps `/orbit.html` and `#board/<id>` links alive), so an
  old bookmark to `/classic.html` now opens the Orbit page. No route or redirect names
  it. A test pins both halves (the fallback's answer, and that no server code, page
  entry, manifest or service worker names `classic.html`). A real 404 would need a
  special case for one dead address; say so if it is wanted.
- **Fixed on the way: the error boundary was unreadable on the Orbit page.** It was
  styled with the old page's tokens, which `orbit.css` never defined: no padding, and a
  Reload button whose label was navy on navy. It has been that way at `/` since the
  flip (and on `/orbit.html` before). It now uses the Orbit page's own classes.
- **What left the web with the old page, by design or by the plan:** this week by
  surface, by project and by model; recent sessions; the usage drivers; the sparkline
  and the pace line on each limit; the Projects list; the plan's price and seats;
  grouping the board by tag; a free-text tag (back on the page with §15's **Other…**); and
  delete (the Orbit plan's decision 6, answered (a) by Jeff on 10-20). The mod still
  shows every one of the panels and still has delete. Nothing else the old page did is
  missing: adding an item (the Board tab's New item form: title, tag, details,
  priority, due date, lane), moving, editing, priority and due dates all work on `/`.
- **Limit warnings (board b468ff61), three changes, server only.** (1) Any told warning
  key, with a reset time in it or without, is forgotten once its limit is read under
  40% (`prune` in `lib/push-alerts.mjs`; `RESET_BELOW_PCT`), so a limit that is reset
  before its printed time can warn again in the hours that printed window has left (§11
  f, the 2026-10-19 case). Only this pass's reading counts (the notifier gives the
  panel only while it is current; the history store is never asked), and a key that is
  live is never forgotten. What the forgotten key still owed a device goes with it.
  (2) At start the server removes `notified.json.tmp-*` files an interrupted write left
  (`sweep` in `lib/sent-store.mjs`, awaited in `server.mjs` before any collector runs),
  and logs a count. `notified.json` itself is untouched and stays 0600. (3) The
  registry refuses a `then` that would loop (a collector naming itself, or two or more
  leading back to the first): the collector is registered and keeps its own timer, the
  link is dropped, and one line says so (`registry: b then a would loop (b > a > b);
  registered without it`).
- **Choices to defend.** (1) The fallback's answer for `/classic.html`, above. (2) The
  error boundary moved and was restyled: not in the brief, but it was the one shared
  file still written for the old page. (3) `format.js` and `due.js` lost their unused
  exports instead of keeping them "for the mod": the mod has its own copies
  (`mod/hooks/model.js`) and never imported these. (4) `design_handoff_claude_control_room/`
  (672 KB, the first design's handoff, with the screenshot the README used to show) is
  kept as history; the board item did not name it. (5) After an early reset the 30-minute
  and 12-a-day caps still apply, so a climb back to a step inside 30 minutes of the last
  telling waits for the cap (a higher step never waits). (6) One misread under 40% in
  the middle of a window would cost one repeated warning, held by the same caps; the
  history has no such reading. (7) A looping `then` is dropped with a log line, not
  thrown: a throw at registration would stop the whole server at start, over a link
  whose only job is to save a few minutes. (8) The sweep removes every
  `notified.json.tmp-*` at start, its own process id's included: a restarted server can
  be given the old one's id, and nothing of this run has written yet.
- **To go live:** C&P and a merge. Then, for the page: `npm run build` in `web/` of the
  main checkout (a live deploy by itself, no restart; the build empties `web/dist`, so
  the old `classic.html` and its assets go from disk then). For the limit warnings: a
  restart of the server (Vision's scope). The two are independent and either order
  works. **After the build, check:** `ls web/dist` shows one `index.html` and no
  `classic.html`; `/` loads on the iPhone and the iPad (they reload themselves once for
  the new build id). **After the restart, check:** the log has no `registry:` line; a
  `notifier: removed N temp file…` line appears only if a write had been cut short; and
  `ls -l server/data/notified.json` still shows `-rw-------`.
- **Checked:** server 1,454 tests (25 new, in `static.test.mjs` and three new files:
  `limit-early-reset`, `sent-store-sweep`, `registry-loop`), in local time and
  `TZ=Asia/Tokyo`; web 320 tests; `oxlint` clean; `npm run build` in the worktree's
  `web/` writes one page (the live `web/dist` was not touched). 45 mutants on the changed
  lines: 44 caught, and the one survivor was a guard that changed nothing, removed with
  its test. Headless Chromium (no WebKit on the mini, so Safari is unchecked) on a
  scratch server at 390 and 1440 px, the worktree's build over the live dashboard's
  figures (read by GET) and an invented board: 42 checks pass. `/` draws its four
  Overview sections with no sideways scroll, no policy violation and no console error;
  the Board tab adds an item through New item and moves it, and both reach the scratch
  board's file; Chat and Feed draw; `/classic.html` answers with the Orbit page; the
  error boundary, on a page built to throw, shows its message and a readable Reload
  button. Not run: the mod's own tests (`claude plugin test`, which starts `claude`;
  the mod's only change is a comment). Nothing ran against :8322 but GETs of
  `/api/dashboard`.

## 15. Follow-ups batch: Ultron's lows on §14, the restart card for the speech files, a new tag on the page (merged as main 2dd66c9, seen 2026-11-19)

**Merged as main 2dd66c9 (seen 2026-11-19); built on `jos/followups-1118`.** Whether its
restart and web build ran, I have not checked. Three board items. The
README's "Limit warnings", "Self-healing loops" (loop 3), "The board's items" and the
Due paragraph of the Orbit page are updated and are the reference.

- **Board 41c18bc0, Ultron's 11-18 lows on §14.** (a) When the under-40% rule forgets told
  warnings that would otherwise have stayed, the notifier logs one line for that limit,
  its label alone (`push: Current session read under 40%; its told warnings are
  forgotten`; the label through `oneLine`, cut at 80). Keys that were going anyway (window
  over, five-hour keep over), kept, live or unread name nothing. (`prune` takes an
  optional `onReset`.) (b) The start-up sweep of `notified.json.tmp-*` now takes only the
  exact shape a write makes (`<pid>-<8 lower-case hex>`) and leaves one whose own
  `lstat` time is within the last minute (`SWEEP_MIN_AGE_MS`; a time ahead of the clock
  counts as recent). (c) The registry's source test reads `then:` in any quote, with
  digits, hyphens and underscores, and fails if any `then:` in server.mjs is not one it
  read (a variable, say). (d) README: "No live screenshot is checked in", pointing at the
  design handoff's pictures.
- **Board 2703904f, the restart card and the speech files.** `SERVER_PATHS`
  (`lib/heal-programs.mjs`) is now `server`, `web/src/lib/orbit/speech.js` and
  `web/src/lib/orbit/markdown.js`, so a merge that changes either page file shows
  **Restart the Control Room**. The git arguments change only by those two fixed paths
  after `--` (no glob characters, no leading `:` or `-`, nothing from a caller; the two
  hashes are still checked as 40 hex before anything runs). Checked with the real
  git-read on the worktree: both reads answer. `chat-speech.test.mjs` ties the list to
  the server's real import graph, so a third page file the server loads fails the suite
  until it is added. Wording: the card's why line now says "change files the server
  runs" (a web build), and the log line, the 409 and the cleared outcome say "the
  server's files".
- **Board 14a66582, a new tag on the page.** The Board tab's New item form ends its
  Area list with **Other…**, which opens a **New area** box (focused, 44 px, as wide as
  the list) with a line under it: a hint, why the name can't be used, or "Joins X,
  already on the board." for a name in use in another case. Add stays off until the name
  passes. **The server had no tag rule beyond "text"** (the brief assumed one), so this
  batch adds it: at most 40 characters once trimmed, and none of `UNSAFE_CHARS` (the
  title's rule), refused with 400 like every board field. The live board's 15 tags are
  all 16 characters or under with no refused character (GET, 2026-11-18), so no current
  write is affected. The page's copy of the rule (`TAG_MAX`, `TAG_UNSAFE`, `tagProblem`
  in `web/src/lib/orbit/board.js`) is held to the server's by a test that compares the
  two sets at every code point.
- **Choices to defend.** (1) The two page files count as server code whether
  `chat.speech` is on or not: the card can't know what config will say at the next
  start, and a spare restart costs a few seconds. (2) The tag rule went on the server,
  not only the page: any tailnet browser or writer could otherwise put a bidi character
  into a chip, and the page's check is only a convenience. Jarvis's and the mod's writes
  are bound by it too (the mod only offers tags in use). (3) 40 characters: the longest
  tag in use is 16, and a chip of 40 still fits a phone. (4) Characters are checked
  before trimming, as the server checks them (a tag ending in a newline is refused, not
  trimmed). (5) Only the New item form has **Other…**; a card's Edit keeps the list of
  tags in use (not in the board item). (6) The reset log line names the limit only; no
  key, percent or time.
- **To go live:** C&P and a merge. Then a restart (Vision's scope) for the log line, the
  sweep, the restart card's paths and the server's tag rule; and `npm run build` in `web/`
  of the main checkout for **Other…** and the card's new why line. **Build after the
  restart, or together:** a page built first would let a too-long or odd tag through the
  old server (harmless: the old server takes any text). **After the restart, check:** no
  `registry:` line; the log has no `push: … read under 40%` line until a limit resets
  early; a board write by Jarvis still answers 200.
- **Checked:** server 1,468 tests (14 new, in four new files: `limit-reset-log`,
  `sent-store-sweep-age`, `heal-restart-paths`, `board-new-tag`, plus changed lines in
  `sent-store-sweep`, `registry-loop`, `heal-restart` and `chat-speech`), in local time
  and `TZ=Asia/Tokyo`; web 324 tests (4 new in `orbit-board-tag`); `oxlint` clean; `vite
  build` of the worktree to a scratch folder clean (the live `web/dist` untouched). 49
  mutants on the changed lines: 48 caught; the survivor was an empty-tag guard the form
  never reaches, removed. Headless Chromium (no WebKit on the mini, so Safari is
  unchecked) at 390 and 1440 px on a scratch server with an invented board: 36 checks
  pass (the list ends with Other…, the box takes the focus, typing stops at 40, a
  direction character and spaces-only are refused with Add off, a name in use in
  another case says it joins, the item saves with the new tag and the tag is offered
  next time, no sideways scroll, no policy violation). Nothing ran against :8322 but a
  GET of `/api/todos` (the tag lengths above).

## 16. The proactive check: wake the lead only on a hit (board a77b4757; merged as main 9d3c2bb, seen 2026-11-19; Ultron's re-read lows N1-N3 in §17)

**Built overnight 2026-11-18 (Jeff: "Keep building something big overnight") on
`jos/proactive`, merged as main 9d3c2bb (seen 2026-11-19), off by default; whether the
config flag, the restart and the web build happened, I have not checked.** Ultron's
re-read lows N1 to N3 are fixed in §17, which changes two lines below: a board id is
said only as a UUID or the mod's 13-digit time (no 8-hex or short-number shapes), and
`coalescing` is gone (heads-ups skip the window). Shuri's 11-11 survey pick 5, which
Jeff said yes to on 11-12, and Jarvis OS pillar 7 (anticipation) as a daily habit; one of
the three things Jeff wants running before pillar 2. Design note:
`docs/design/2026-11-18-proactive-check.md` (rules, thresholds, keys, state, delivery,
quiet hours, go-live). README, "The proactive check", has the mechanism.

- **What it does:** a pass every 5 minutes in the server (no model, no network) over the
  board file, the crons panel, the heal ledger, the usage panel and the Shortcut keys.
  Rules: past `due`; an `ask` standing 3 days; P0 unchanged 2 days, P1 7; one job failing
  on 3 distinct runs in 14 days; one heal target healed 3 times in 14 days; a weekly
  projection over 100% once 25% of the week is gone; the session at 75%+; a Shortcut key
  within 7 days of its idle expiry. Each hit is told once (until it clears or changes
  materially) in one event per pass for the lead (`source: proactive`, `type: heads-up`,
  typed words, at most 5 named per rule, 1,200 characters, a board id only in an opaque
  shape), held 22:00-07:00 and told at 07:00 as one batch; at most 8 such events a day,
  outside the others' 30; a hit counts as sent only when the events module makes it (or
  coalesces it), otherwise the next pass offers it again; shown under **Heads up** on the
  Overview (after Needs you, only while there is a hit) from `GET /api/proactive`, which
  has the Feed's read rule. With the chat off no pass runs.
- **Choices to defend:** (1) the board has no change or ask times, so the check keeps its
  own fingerprints: the first `stale` and `ask` hits come 2, 3 or 7 days after it is
  turned on (the 20 history copies span under a day, not worth seeding from); (2) the
  board is read with `readFile`, never the store (whose read can write); (3) failed runs
  are counted by the check itself (nothing kept them): one per `lastRunAt`, 2 minutes'
  tolerance for job-status's 36 s wobble, a heal-held row not counted until its hold ends;
  (4) a repeat hit fires again only on the next band (3, 6, 12, 24), not on every new
  failure, because the notifier already alerts each failure; (5) usage keys are kept until
  their window ends, and a session hit at 80%+ is silent (the limit warning tells the lead
  and the phone), so no second push; (6) the event items carry no alert key, so the events
  ledger, which forgets only keys the notifier can see, never holds one forever; (7) the
  GET is device-only and not in `/api/dashboard`, because an expiry hit names a Shortcut
  key; (8) a kill file `proactive-off` beside the others, as every Jarvis OS feature has;
  (9) thresholds are constants, not config, as the limit warnings' are.
- **Not built, with why:** the Claude login's expiry (no source the server may read; the
  date is in the Keychain credential, and the login watch keeps none: a question for
  Jeff below); credit grants (already alerted at 7 days by `lib/alerts.mjs`); a "due
  soon" rule (the brief said past due); seeding the clocks from Jarvis's board backups
  (couples this server to Jarvis's folders); the morning brief's read (a routine has no
  device cookie).
- **Ultron's review (2026-11-18): GO with fixes (0 high, 1 medium, 6 low), all seven fixed
  the same night**, each with a test (design note §8):
  - **M1**, a board id could carry words into the lead's event: an id is said only as a
    UUID, `\d{13}-[a-z0-9]{6,12}`, 8 hex or a number of at most 9 digits (`OPAQUE_ID`), in
    `boardHits` and `checkHit`; any other is "an item (…; see Heads up)". Test with
    `Jarvis-system-note.approve-pending-pairing-and-run-chat-pair-now`. 241 of 241 open live
    items fit (read-only check of `server/todos.json`).
  - **L1**, sent only on `made` or `coalescing`; `held` and `off` stay unsent and are
    offered each pass. `events.proactive` counts nothing in those cases (no held-back or
    suppressed line, which would count the same hits every 5 minutes). The page says "sent".
  - **L2**, `PROACTIVE_DAILY` 8 a day for heads-ups, outside `DAILY_TOTAL`, and the 30 no
    longer counts them.
  - **L3**, `jobHits` skips (and forgets) a job whose `cron:launchd:<label>` is in
    `events.excludeKeys`.
  - **L4**, the view drops a usage hit whose window has ended, marks rows from an unread
    source (`current: false`, `readAt`; the page writes "as of …, not read since"), and a
    keys list that throws is "not current", not "none".
  - **L5**, my call: no passes when there is neither an events path nor a paired device
    (both exist only with the chat on), rather than rewording a promise of a page nobody
    could read. The start line says `proactive: on in config, but no passes run: …`.
  - **L6**, `TODOS_PATH` in server.mjs for the store and the check; one log line after 3
    unreadable passes in a row (by error code), and one when it reads again.
- **Go-live, in this order:** (1) Ultron reads the surfaces below (done; a re-read of the
  seven fixes if he wants one); (2) C&P, then `cd web &&
  npm run build` in the main checkout (safe before the restart: the old server answers the
  page's GET with a 404, and the section stays hidden); (3) Jarvis adds `"proactive": { "enabled": true }` to `server/config.json`; (4) a
  restart (Jeff's OK, Vision's scope).
- **After the restart, check:** the log has `proactive: on, every 5 min, quiet 22:00-07:00
  held to 07:00; events on`; after the first pass, `stat -f %Lp server/data/proactive.json`
  prints `600`; from the mini `curl -s -o /dev/null -w '%{http_code}'
  http://127.0.0.1:8322/api/proactive` prints `401` (no cookie); on a paired device the
  Overview shows Heads up if any open item is past due; the first event arrives as
  `chat_id="jos-events"`, `source="proactive"` (`event="unknown"` until the channel
  learns `heads-up`), and the log has one `proactive: N heads-ups to the lead's event
  (made)` line.
- **Undo:** `touch ~/.local/state/jarvis-os/proactive-off` (stops at the next pass, no
  restart; the page says killed and shows nothing); or remove the `proactive` block and
  restart; or revert the commit (`data/proactive.json` is read only by this code and can be
  deleted after).
- **For Ultron:** `lib/proactive.mjs` (the board read, the run counting, the told / held /
  forget rules, the state file and its cleaning); `lib/proactive-text.mjs` (`checkHit` and
  `proactiveText`: every field typed, every outside string refused unless it is a plain id
  or a config name); `events.proactive` in `lib/events.mjs` (a new in-process source, no
  socket name, no alert keys, `immediate`); `lib/proactive-routes.mjs` and the shared
  `deviceReadGuard` now exported by `lib/feed-routes.mjs` (the Feed's code moved, not
  changed); the server.mjs block (source test in `test/proactive-routes.test.mjs`).
- **Checked after the fixes (2026-11-18 night):** server 1,534 tests, web 333, both in local
  time and `TZ=Asia/Tokyo`; `oxlint` on the changed files clean (one warning in server.mjs
  that main has too); `vite build` to a scratch folder clean, the live `web/dist` untouched.
  Mutation: 73 new mutants over the seven fixes, all caught once three tests were
  tightened (a `due` checkHit without the id check, the others' day cap at 8, a key of
  another kind taken as an exclusion); the original 97 rerun: 91 caught, 5 no longer apply
  to the changed code and have new forms in the 73 or two reshaped ones (caught), and one,
  the closing words' room under the cap, survived my rewritten cap test until it tried cut
  points near the cap again. Final run of the 76 together: all caught. Headless
  Chromium on a scratch server (port 8391, a stand-in GET with one row `current: false`) at
  390 light and dark and 1440: the row reads "as of 25 min ago, not read since · sent 1 h
  ago" in italics, the others say "sent"; it found a 1 px sideways scroll at 390 from the
  longer words (fixed: they wrap on such a row). Safari unchecked, as before.
- **Checked before the review:** server 1,522 tests (54 new: `proactive.test.mjs` 41,
  `proactive-events.test.mjs` 7, `proactive-routes.test.mjs` 6; one message in
  `events.test.mjs` and the sweep count in `sent-store-sweep.test.mjs` changed for the new
  source and the second sweep), local time and `TZ=Asia/Tokyo`; web 332 (8 new in
  `orbit-headsup.test.js`), both time zones; `oxlint` clean; `vite build` of the worktree
  to a scratch folder clean (the live `web/dist` untouched). 97 mutants over the new code
  and the changed lines, all caught (two no-op baselines pass); the run found an inherited
  `toString` key read as a source (fixed with `Object.hasOwn`) and a dead rule check on
  the page (removed). Headless Chromium (no WebKit on the mini, so Safari is unchecked) at
  390 light, 390 dark and 1440 on a scratch server with an invented board and a stand-in
  GET: Heads up right after Needs you, seven rows in order, a board row named from the
  board and opening `#board/aa11`, the held and silent words, no sideways scroll, no
  policy violation, and no section with no hits; the only console error is the scratch
  server's missing `/api/pair/status`. **Unverified:** the server.mjs wiring in a running
  server (only `node --check` and the source test: a full server starts the collectors),
  the real channel, Safari, and a real 07:00 timer.
- **Questions for Jeff (in the report):** the login expiry source; the thresholds.

## 17. Fix run: nine boards of Ultron's lows in one branch (merged as main 46f9ea6, seen 2026-11-19)

**Merged as main 46f9ea6 (seen 2026-11-19); the rest of this section is how it was staged.
Whether its restart and web build ran, I did not check.** Staged on `jos/fixrun-1119` (worktree
`~/Projects/.worktrees/ccr-fixrun-1119`, from main 9d3c2bb, no upstream). Jeff's 11-19
principle for the healing loops ("I want the team proactively finding and fixing our
gaps"), run as one batch: every fix has a test, and Ultron reads the branch before C&P.
The README is updated for each behaviour and is the reference.

| Board | Item | Done | What changed |
|---|---|---|---|
| 82ce877b | Proactive N1-N3 | fixed | N1: a board id is kept only as a UUID or the mod's `\d{13}-[a-z0-9]{6,12}` (the 8-hex and short-number shapes went; no writer makes them), and the lead's event says the mod's shape by its 13-digit time only ("the item whose id starts 1763452800000"), `saidId`; the page's view keeps the whole id for its link. N2: heads-ups skip the 60 s coalesce window (`events.proactive` appends at once) and `coalescing` no longer counts as sent. N3: "the event was not made" is logged once a spell. |
| e6178bb9 + 32769ce5 | Hidden characters | fixed | Tags take `lib/hidden-chars.mjs`'s line set on the server (`todos.mjs`) and the page (`board.js` `TAG_UNSAFE` is `markdown.js`'s new `HIDDEN_CHAR`, held to the server's at every code point). The page's link-label filter drops that same set (was a list of 13). The board text rule (`text.mjs` `UNSAFE_CHARS`, for titles, asks and ack notes) now refuses U+2028 and U+2029; U+200C and U+200D stay allowed. Titles keep their narrower rule. The optional nits (registry `then:` shorthand keys; the New area box's UTF-16 `maxLength`) were not done. |
| 9a688206 | acks test by time of day | already fixed | Fixed on main since 0b09e2d/800b70a (the route tests place the next run from `Date.now()`). Proven 11-19 with a Date-shifting preload: the old file (f8cd1b1) fails at 12:55Z 11-13, the current one passes at eight times across a day and into December. No code change. |
| cece359f | Loop 1 L1-L6 | fixed | L1: at start the ledger's escalated and relapsed mark-quiet lines of the last 24 h rebuild one-attempt-per-instance, and a target whose last line is a heal counts its quiet as ended at the start (another instance waits the hour). L2: a loop whose job still fails on the same run, but not for its log's age alone, closes `escalated`/`relapsed` (`not-stale-log`), not `cleared`. L3: the kill file is read with `lstat` (`killFileThere`): only ENOENT is "not there". L4: the heal hold skips a key the events ledger has (`events.knows`). L5: a loops view that throws leaves `/api/dashboard` up ("off", logged once a spell). L6: a last terminating signal at either reading fails the check (`signal`). |
| bcde53ea | Parity L1, L2, L3, L6, L7 + C3 | fixed | L1: the preview's hidden-character scan reads every depth (a list, not recursion with a cut at 20). L2: the tool's name counts (parity and guarded). L3: a comment in `approvals.mjs` says why look-alike letters are not marked, with a test pinning it. L6: the server.mjs comment names `test/approvals-parity.test.mjs`, and a test checks every test file server.mjs names exists. L7: dismissed card ids are kept 2 h, at most 500 (`rememberDismissed`). C3 is in §10's parity checks as a live check still owed. |
| d921a9c9 | Control Room lows bundle | fixed (umask: already) | `oneLine` cuts at 600 code points of what it shows, markers included; a #pepper copy the poster refused (exit 2) or couldn't post (3) is logged with its exit, never the message; the ack notice says how it arrived (`from the page`, `from a script, not the page`, `from a heal card on the page`); a re-ack after an un-ack of the same failure counts on (in memory only, until the removed ack would have run out). `ingest.sock` under umask 077 was already on main. The "more invisible ranges" half was already in (oneLine uses the shared set). |
| 5c266d65 | Tabs at 320 px | fixed | Measured, the row ran up to 50 px over at 320 (header and pinned) and 5-10 px at 360, with "Board · 238" and a "99+" badge. A second step under 370 px: 11 px type, no tracking, 6 px padding, 2 px gaps, a smaller badge, each tab at least 44 px. |
| 20620d37 | Acked job red after a restart | fixed | Reproduced at the route: with the health strip in and the crons panel not yet, the acked job's row had no ack. cb4f470 made the crons pass wait for job-status, but the strip still went out first. Now the health collector's first pass waits for the crons panel's first (`untilCached`, at most 60 s), and reads the clock again after. |
| 8b77e6e2 | Exact rows: spaces | fixed | A run of two or more spaces, or any at a line's start or end, is drawn as `␣` per space (`␣×N` past 8) with its count for a screen reader. The L1 wording was already on main. |

- **Skipped:** nothing that needs Jeff, a launchd or Vision change, or a channel release
  came up. Not done: e6178bb9's two optional nits (above).
- **Choices to defend:** (1) N1 keeps the mod's shape for the page's link and says it by its
  time in the event, rather than "an item"; (2) N2 does both (no window and `coalescing`
  not sent); (3) a tag refuses U+200D and U+FE0F (an emoji tag with a joiner is refused: a
  joiner can make a look-alike area), titles still take them; (4) the page's hidden set
  sits in `markdown.js`, already in the server's import graph, so no third page file joins
  `SERVER_PATHS`; (5) loop 1's restart guess holds another instance off for an hour after a
  start when the target's last line is a heal ("can't tell" never acts); (6) the renewal
  count across an un-ack lives in memory: a tombstone in `acks.json` would read as a live
  ack to a rolled-back server; (7) item 8 waits in the health collector, since health rows
  carry no times to match an ack's instance; (8) the ack notice's "how it arrived" is the
  Origin header, which a script can send too, so it says what the server saw, not who.
- **To go live:** Ultron's read; C&P; a restart (Vision's scope, Jeff's OK) for every server
  change; `npm run build` in `web/` of the main checkout for the tabs, the tag rule, the
  link labels, the exact rows and the dismissed ids. Either order is safe: the old page's
  tag check is looser than the new server's (a refused tag answers 400 and the page says
  so), and the new page only refuses more. `markdown.js` is in `SERVER_PATHS`, so loop 3's
  Restart card shows after the merge anyway. Proactive N1-N3 matter only once
  `proactive.enabled` is on.
- **After the restart, check:** the start lines as before (`heal: on, … targets`, no
  `config:` line, no `loops: the view failed`); a board write by Jarvis answers 200 (the
  live board's tags, titles and asks held none of the newly refused characters on
  2026-11-19, read from the file); with an acked failing job on the Jobs chip, the first
  load after the restart reads "all OK · 1 ack" (it may show nothing for the first seconds,
  never red); the next ack notice in #pepper ends its parenthesis with "; from the page";
  on Jeff's smallest phone the four tabs sit in one row. C3 (§10) is still owed.
- **Undo:** revert the commit; nothing is migrated (no file format changed).
- **For Ultron:** `lib/proactive-text.mjs` (`OPAQUE_ID`, `saidId`, `itemPart`) and
  `events.proactive` (no window, `append` at once) with `SENT_STATUSES` and the error spell
  in `lib/proactive.mjs`; `lib/text.mjs` (`UNSAFE_CHARS` + U+2028/2029), the tag line in
  `todos.mjs`, `HIDDEN_CHAR` in `web/src/lib/orbit/markdown.js` and `TAG_UNSAFE` in
  `board.js`; `lib/heal-runner.mjs` (`rebuild`, the `not-stale-log` branch, the first
  reading's signal check, `ended` with its instance), `judgeReadings` and `killFileThere`
  in `lib/heal.mjs`; `heldAlerts` in `collectors/notifier.mjs` and `events.knows`;
  `loopsView` in `routes.mjs`; `anyHidden` and the tool's name in `lib/approvals.mjs`;
  `rememberDismissed` in `web/src/lib/orbit/chat.js` and its use in `useChat.js`;
  `oneLine` in `lib/chat-events.mjs`; `sendAlert`'s log in `notify.mjs`; `ackNotice`'s
  `via`, `addAck`'s `removed` and the store's in-memory removals (`server/acks.mjs`);
  `untilCached` and the first pass's wait in `collectors/health.mjs`; `spaceParts` in
  `chat.js` and its drawing in `Chat.jsx`; the 370 px step in `orbit.css`; the server.mjs
  lines (`killFileThere`, `eventKnown`, `via: 'heal-card'`, `firstCrons`), each held by a
  source test.
- **Checked (2026-11-19):** server 1,559 tests (1,536 on main; 23 new, and assertions added
  in existing ones), web 335 (333), both in local time and `TZ=Asia/Tokyo`; `oxlint` on
  every changed file shows only the four warnings main has. Mutation: 99 mutants over the
  new code, then 11 more (the 3 that never ran, rebuilt from code points, and the
  replacements below). On the final code every one that still applies is caught; on the
  way, 6 survived and 3 never ran (a typed `\u2028` escape in the mutant list became
  the real character): two survivors showed test
  gaps (an object posing as a UUID to `saidId`; a single space after a tab), two showed
  redundant checks, removed (the rebuild's day limit, which the pass already applies; the
  discord log's `sent` test, since a sent post has no reason), one a weak mutant (replaced
  by the old recursive scan, caught by depth 21, and a wide-list test), and one a guard
  dropped on purpose (a ledger line stamped ahead now stays closed, with a test). Headless
  Chromium (no WebKit on the mini, so Safari is unchecked) on scratch servers (8396, 8397;
  never :8322): the tabs at 15 widths from 320 to 1440, light and dark, in the header and
  pinned, with "Board · 238" and a "99+" badge: all in their box, no sideways scroll,
  every tab 44 px (before the fix: 50 px over at 320, 10 at 360); the permission card from
  a throwaway build of the real `PermissionCard` at 320, 390 (light and dark) and 1440: the
  rows read `[2 spaces:␣␣]rm[2 spaces:␣␣]-rf build[1 space:␣]↵`, `echo[12 spaces:␣×12]done↵`
  and `a b⇥c`, marks in their own colour, no policy violation; the Orbit page at 320, 390
  and 1440: Overview and Board with no sideways scroll, the New item form refusing a soft
  hyphen and a zero-width joiner with Add off, taking a plain new tag, which is saved. The
  restart flash was reproduced at the route before the fix (`repro-flash.mjs`: health in,
  crons not, no ack) and is held by an end-to-end test over the real registry, cache,
  health collector and routes, which shows the flash without the wait. **Unverified:** a
  real restart of the service (the server.mjs lines rest on source tests), Safari, and the
  ack notice and #pepper log on the real poster.

## 18. A projection from the recent rate, and the idle wake-up (merged as main c66ca3e; live 2026-11-19 16:05 ET)

**Merged as main c66ca3e and live since 2026-11-19 16:05 ET with `proactive.idle.enabled`
on (per Jarvis's notes; I did not check the log). What follows is how it was staged.** Staged on `jos/dynamic-projection` (worktree
`~/Projects/.worktrees/ccr-dyn-1119`, from main 46f9ea6, no upstream). Ultron's review
(11-19): GO to commit; his M1 and L1-L5 are fixed in the same staged change (below).** Two of Jeff's
11-19 asks: board f66a4a7e ("the projections need to be more dynamic") and board 5ffd0041
("we should be continuously burning down the board"). Design:
`docs/design/2026-11-19-dynamic-projection-idle-wake.md`. The README has the mechanism
("The weekly projection follows the last day's rate", "The idle wake-up").

- **The projection.** A weekly limit is now projected as its percent plus the rate of its
  last 24 hours over the time left, from the `/usage` history, instead of a straight line
  from the week's start. On the real history at 07:00 on 11-19 that reads 64% (all models)
  and 78% (the model's own limit) where the line read 104% and 157%. The straight line
  stays as the fallback (the first day of a week, after a reset, a history that does not
  reach back) and for the session limit. The number carries its basis (`pace.basis`,
  `pace.basisMs`), and every place that says the projection says the basis: the alert line
  ("… projected to reach 112% by reset at the last 24 h rate"), the Heads up row and the
  lead's heads-up event, a new line under each weekly figure on the Usage panel ("heading
  for 64% at the last 24 h rate"), and the mod's pace line. The limit warnings never used a
  projection (they fire at 80%, 95% and 90% of the limit itself), so nothing changed there.
- **The idle wake-up** (its gate, settle and spacing changed 2026-11-20: §25). A new rule in the proactive check's pass: one event for Jarvis
  (`source: proactive`, `type: idle`) when no agent run is live, the session is under 75%,
  every weekly limit is under 90% and projected under 100%, the board holds an open item with no `ask`,
  and that has lasted 10 minutes (counted from Jarvis's own last request too). Fixed words,
  numbers only: `Idle: no agent run is live. 14 open board items have no ask (1 P0, 5 P1;
  3 in doing). Session at 12%, highest weekly projection 64%.` At most one an hour (kept in
  the check's state and again in the events ledger), 2 then 4 hours apart while no run
  follows; none from 22:00 to 07:00 unless config says so. It starts nothing.
- **Off by default.** `"proactive": { "enabled": true, "idle": { "enabled": true } }`
  turns it on; `"quietHours": false` in that block lets it go at night too (Jeff asked
  for overnight builds, so that switch is his call; I picked quiet nights as the default).
  Kill file: `~/.local/state/jarvis-os/idle-off` (no restart).
- **Choices to defend:** (1) 24 hours, not 48: a whole day and night, and the backtest
  (12 and 8 complete weeks; wrongly over 100% on 8% of readings against the line's 12%;
  the one week that hit 100% called on every reading) favoured it slightly; the sample is
  small. (2) A baseline older than 24 hours after a gap is used at its true span, and the
  words say the span, rather than falling back to the line. (3) A fall of more than 5
  points ends the walk back (an early reset; the dips in the history were 1 point).
  (4) The session keeps the straight line. (5) `pace.state` still compares with an even
  pace, so the mod can say "ahead of pace · projected 64% by reset at the last 24 h rate".
  (6) The idle rule's weekly gate is every weekly limit, not only "all models" (question
  for Jeff below). (7) The 10 minutes count from the lead's own last request as well, so
  a conversation between Jeff and Jarvis is not "idle". (8) The back-off (1, 2, 4 hours)
  is mine: an unanswered wake-up would otherwise cost Jarvis a turn every hour. Only a
  run seen live resets it. (9) Nothing is held for the morning: the 07:00 pass decides
  afresh. (10) No row on the page: Heads up is for things that want Jeff's eye; the GET
  carries an `idle` object for checks. (11) The events ledger counts idle events under a
  name of its own (`proactive-idle`), so they use up neither the heads-ups' 8 a day nor
  the others' 30; the event itself says `source: proactive`. (12) An idle event the
  channel was not there for is delivered within 15 minutes only (other events: 2 hours).
- **Ultron's review fixes (11-19, same staged change):** **M1** a weekly limit at 90% or
  over (the limit warnings' step, `IDLE.weekPct` from `WEEKLY_STEPS`) is `week-high`
  whatever its projection, since after a quiet day the 24-hour rate is about 0 and a limit
  at 97% projected 97%. **L1** no weekly limit with a percent is `usage-not-current`, not
  idle (a wake-up always says a week; `checkIdle` now requires it). **L2** a missing
  `agentWork`, or a `lead` that is not a name, is `sessions-not-current`; `leadLast: null`
  passes only with a known lead. **L3** `readEventsConfig` refuses `proactive` and every
  `proactive-…` name as a socket source (one called `proactive-idle` would have shared the
  idle ledger's hour). **L4** an idle event lives 15 minutes at delivery
  (`IDLE_EVENT_TTL_MS`). **L5** `events.idle(fields, { nights })` checks quiet hours itself
  and answers `quiet` from 22:00 to 07:00 unless `nights: true`, which the check passes only
  with `idle.quietHours: false`.
- **Not in this repo (Jarvis's side), needed before the wake-up is useful:** the
  channel's standing words say an event alone never justifies a write, so Jarvis's own
  instructions need a line that an `idle` event is the cue to pick the next board item
  under Jeff's standing ask of 11-19; and the channel's event names need `idle` (and
  `heads-up`), or the tag reads `event="unknown"` (the words arrive either way).
- **To go live, in this order:** (1) Ultron reads the surfaces below; (2) C&P; (3) `cd web
  && npm run build` in the main checkout (safe before the restart: with the old server the
  new page shows "heading for N%" with no basis words, checked on a scratch server);
  (4) a restart (Vision's scope, Jeff's OK): the projection changes for every reader at
  once; (5) for the wake-up, Jarvis's instruction line first, then Jarvis adds the `idle`
  block to `server/config.json` and a second restart (or both in one, if the instruction
  line is ready).
- **After the restart, check:** the start line reads `proactive: on, every 5 min, quiet
  22:00-07:00 held to 07:00; events on; idle wake-up off` (or `on (not 22:00-07:00)` with
  the block); no `config:` line; after the first usage poll, `curl -s
  http://127.0.0.1:8322/api/dashboard | /usr/bin/jq '.usage.data.limits[] | [.label,
  .pct, .pace.projectedPct, .pace.basis, (.pace.basisMs / 3600000 | round)]'` shows
  `"recent"` and `24` for each weekly limit (or `"window"` on the first day of a week) and
  nothing new for the session; the Usage panel shows "heading for N% at the last 24 h
  rate" under Week and under the model. With the idle block on: after 10 idle minutes in
  the day, one `proactive: an idle wake-up to the lead's event (made): N open items with
  no ask` line and one event with `source="proactive"` in Jarvis's session; no second one
  within the hour.
- **Undo:** for the wake-up, `touch ~/.local/state/jarvis-os/idle-off` (no restart) or
  remove the `idle` block and restart. For the projection, revert the commit and restart
  (`proactive.json` gains an `idle` key the older code ignores; `events.json` may hold
  `proactive-idle` entries the older code counts toward the others' 30 for a day at most).
- **For Ultron:** `recentBaseline`, `computePace`'s baseline and `basisWords` in
  `lib/pace.mjs` (which readings may set a rate); `checkIdle` and `idleText` in
  `lib/proactive-text.mjs` and the `rateHours` field of a `week` hit (what may be said);
  `events.idle` in `lib/events.mjs` (a new way to make an event: its spacing, `countAs`,
  the cap change in `capped`); `idleCheck`, `idleStep`, `readIdleConfig` and the `idle`
  key of the state and the view in `lib/proactive.mjs`; the two server.mjs lines
  (`idleOffPath`, `idleKilled`), held by the source test; on the page `aheadNote` and
  `basisNote` in `web/src/lib/orbit/overview.js` and the `week` row in `headsup.js`; the
  mod's `paceNote`.
- **Checked (2026-11-19, after Ultron's fixes):** server 1,618 tests (1,559 on main; 59 new in
  `pace-recent.test.mjs` 16, `proactive-idle.test.mjs` 31, `proactive-idle-events.test.mjs`
  12, and four existing assertions updated), web 337 (335; 2 new), server in local time and
  `TZ=Asia/Tokyo`. Mutation: 27 more mutants over the six fixes, all caught (two no-op
  baselines pass), and the first 171 rerun on the fixed code, all caught (seven rewritten to
  the changed lines first). Before the fixes, 171 mutants
  over the new logic, all caught on the final code
  (two no-op baselines pass); on the way 5 survived: three showed test gaps (a zero count
  with zero parts; a lead time given as text; a state that is neither idle nor a run
  resetting the back-off), one that the state must be written in the pass that sends, and
  one was equivalent (the words check their fields themselves). Listing the mutants first
  removed four redundant checks. The real history, read-only, through the worktree's
  panel code at seven moments of this week (64% and 78% at 07:00 on 11-19). Headless
  Chromium (no WebKit on the mini, so Safari is unchecked) on scratch servers (8402-8404,
  never :8322) at 390 light, 390 dark and 1440, in three modes (a recent rate, the
  straight line, an older server's pace with no basis): the line under both weekly
  figures and none under the session, the words for each mode, the rings' label, the
  Heads up week row, no column overflow, no sideways scroll, no policy violation.
  **Unverified:** the server.mjs lines in a running server (source test and `node
  --check` only), the real channel and Jarvis's reaction to an `idle` event, Safari, and
  the mod's pace line in the mod harness (its test file is updated; I ran `paceNote` by
  hand in Node, since the mod's tests run only inside Claude Code).
- **Questions for Jeff (in the report):** the weekly gate (every weekly limit, or only
  "all models"); nights (quiet by default, `quietHours: false` for overnight builds); the
  back-off (1, 2, 4 hours, or a flat hour).

## 19. "Bring Jarvis Back" on the page (board 52ee3f17, P0; live 2026-11-19 as main c8ecec8)

**Merged as main c8ecec8 and built live 2026-11-19 12:22 (the live `web/dist` holds the
link; branch `jos/runbook-link`, worktree `~/Projects/.worktrees/ccr-runbook`).** Jeff, 11-19, after a 14-minute Jarvis outage: keep the
run sheet (a private claude.ai page, pinned in his sidebar) in Jarvis OS too. Page only:
no server change. The README's bullet "Bring Jarvis Back, the run sheet, from the page"
is the reference for where the link shows and when.

- **What it does.** The address is `RUNBOOK_URL` in `web/src/lib/orbit/runbook.js`, the one
  place. Quiet and always there: the Overview's foot ("Jarvis down? Bring Jarvis Back"),
  the Chat ⋮ menu, and the lead's health-chip details. Loud when he is down, from state
  the page already had: the alert strip's "Jarvis is not running" (the server's five-minute
  rule) and its Needs you card get a button; the Chat banner gets an orange button when
  the channel is offline (heartbeat gone) or **stuck** (a message of Jeff's still
  `queued` after two minutes of this page watching it with the stream open and the channel
  connected, a new banner state worked out on the page);
  "Delivered N m ago, no answer yet" (ten minutes) gets a quiet link.
- **Choices to defend:** (1) no new probe and no server change: the health strip's session
  state, the server's alert, and the chat status already say "down"; (2) the alert strip
  waits the server's five minutes, while the red "Jarvis down" chip and its details link
  are there at once; (3) stuck at two minutes: the channel acks a message within seconds
  whenever it is connected, measured on the device's clock from when the page first saw
  it queued while watching (not from the server's `at`), so leaving the page, a closed
  stream or an offline channel starts every clock again; (4) stuck outranks slow but not offline or "waiting on you"
  (an open request proves the channel relays); (5) the slow banner's link stays quiet,
  because ten minutes without an answer is often just a long turn; (6) six places, all
  through one component, so a new address is a one-line change.
- **Ultron's review (11-19, board ed663682, fixed in the same staged change):** **Medium**,
  a false stuck alarm after a background resume: `useChat` reopens the stream with
  `?after=<last seq>`, the server replays only newer messages and never a state change
  (`chat-routes.mjs` stream, `chat-store.mjs` `ack`), so a message the channel took while
  the page was away stayed `queued` and the loud button invited restarting a working
  Jarvis. Fixed twice over: every stream open (the browser's reconnects too) fetches the
  latest page and merges it with `mergeFresh` (a live state never goes back to `queued`, a
  newer live edit is kept, an answer for an older stream is dropped), and `stuckSince`
  skips a queued message when the thread holds a later one of Jeff's that is `delivered`
  (acks are cumulative) or any later one from the lead. One choice beyond his words: a
  routine's message (`meta.routine`, the morning brief) does not count as the lead's,
  because launchd posts it, not the channel. **Low**, the device clock compared with the
  server's `at`: the page now keeps when it first saw each message queued (`noteQueued`).
- **Not covered:** the Control Room itself down. The page then doesn't load at all (no
  service-worker cache, on purpose), so the claude.ai pin is the fallback. A stream that
  can't reach the server shows "reconnecting…" as before, with no link.
- **To go live:** C&P, then `cd web && npm run build` in the main checkout. **No restart**:
  the server is unchanged and the page reads only fields today's server already sends
  (checked against the live payload's shape: `health.data.services[]` with
  `kind: "session"`, `name: "Jarvis"`, key `session:Jarvis`). Open pages pick the build up
  by themselves (build-id reload).
- **After the build, check (Jeff's iPhone and iPad):** the Overview's foot link opens the
  run sheet in a new tab or Safari sheet, signed in; the ⋮ menu item does the same from the
  Chat tab; tapping the Jarvis chip shows "Not answering? Bring Jarvis Back". The down
  states can only be seen on the next outage (or a scratch server).
- **Checked (2026-11-19, after Ultron's fixes):** web 351 tests (337 on main; 14 new in
  `orbit-runbook.test.js`, one existing banner assertion updated), in local time and
  `TZ=Asia/Tokyo`; server 1,618 (unchanged code; run under umask 022); oxlint clean on
  every changed file; 34 of 34 mutants caught (each rule of `stuckSince`, `noteQueued`,
  the skip rule and its routine exception, `mergeFresh`, the refetch and its stale-stream
  guard, the watching condition, `leadService`, `isLeadDownAlert`, `isLeadServiceKey`, the
  banner's link states, the new-tab link, the health link). Headless Chromium against a
  fake read-only scratch server (no :8322 at all) at 390 and 1440, light and dark, 136 of
  136 checks: the foot, the chip details (and not the Tunnel's), the menu item opens a new
  tab with no opener and closes the menu, the stuck banner not at first sight nor at 90 s
  but at 2.5 min (page clock moved), Ultron's resume case (the server delivers and answers,
  the stream drops, the reconnect's refetch brings the answer and the tick, and no stuck
  banner three minutes on), the slow and offline banners, the strip and card buttons beside
  Acknowledge, 44 px targets, no sideways scroll, no page errors. The same check on a build
  without the refetch fails the resume case (12 failures), so it reproduces his finding. Safari
  and the installed iPhone app are unverified (no WebKit on the mini): how a new tab opens
  from the home-screen app is the device check above.
- **Found on the way, not fixed (pre-existing, not this branch's code):** the web test
  "pathological input parses in linear time" (`web/test/orbit-markdown.test.js:244`) is
  timing-flaky: it failed once in seven runs on 11-19 ("open strong: 31.2 ms vs 0.6 ms at a
  tenth of the size"; a GC or scheduling pause), then passed six times. A ratio of two
  single timings is the trap; a median of several runs, or a cap on work rather than on
  milliseconds, would hold. Asked for as a board item.

## 20. Jarvis-down alerts without Discord: a local script's alert to the paired devices (board 5f892918, P0; merged as main 0efa83f, seen 2026-11-20; live only after a restart and a web build)

**Merged as main 0efa83f (built on `jos/alert-push`, from main c8ecec8); whether the
restart and the web build below have happened was not checked from here.** Jeff decided 2026-11-19 that the backup path for
Jarvis-down alerts is the Control Room's own Web Push, which already works for "Jarvis is
offline". The Jarvis repo's `bin/jarvis-start` (`fail()` and the new "Jarvis started
degraded") and `bin/routine` alert to Discord first, and every fallback after it has a weak
spot: an ntfy topic depends on its setup on the machine, and the inbox is read by the lead,
who may be the thing that is down. This is the Control Room side: `POST
/api/ingest/local-alert` on the ingest socket. The README's "A local script's alert: Jarvis
down without Discord" is the call contract, with the curl and the rules for a caller; the
Jarvis side (calling it from `bin/jarvis-start` and `bin/routine`) is a separate job.

- **What it does.** A local script posts `{ title, body?, severity?, kind? }`; the server
  pushes it to every paired device ("Local alert: " and its title, its body, urgent unless
  `info`, no Topic, TTL 6 h, a tap to the Overview) and lists it first in `alerts`, so the
  strip shows "<title> · <time>" and Needs you has a card (chip "Jarvis down" or the
  severity, the body in its lines, Acknowledge). `kind: "jarvis-down"` adds "Bring Jarvis
  Back" to both (`isLeadDownAlert` in `web/src/lib/orbit/runbook.js`). The mod's pane and
  `/control-room` summary add "(local script)".
- **Ultron's review (11-19: ship with nits, 1 medium, 7 low), all folded into the same
  staged change:**
  - **M1, a repeating caller pushed all night with no off switch:** each repeat had a new
    random key, so an ack never covered it. Now the key is `local:<kind>:<12 hex of the
    SHA-256 of the cleaned title>`, a repeat updates the one entry and keeps its `since`,
    so one ack covers every repeat (server.mjs hands the store `matchingAck` over the ack
    file), and an acked alert is shown and never pushed. A kill file,
    `~/.local/state/jarvis-os/local-alerts-off`, checked on every post, stops every push
    and leaves the alerts on the page. Pushes have their own caps below the intake: 3 an
    hour, 12 a day; extra alerts stay on the page (`push: "capped"`).
  - **L1:** the push title always starts "Local alert: ", and the service worker gives a
    local alert its own tag (`jos-local`); the approval tag now needs the title "Jarvis"
    as well as the approval's body.
  - **L5:** `jarvis-down` has a reserve under each limit: 2 of the hour's 10 intakes, 1 of
    the 3 hourly pushes, 3 of the 12 daily ones.
  - **L3/L4:** a duplicate answers with the earlier post's push outcome and device counts,
    and an alert whose push reached nobody is never deduped against (it gets another try);
    an alert over the intake limit is a 429 but stays on the page, with no push; the
    README says `reached` under 1 means not delivered.
  - **L6:** the README and this section give the ntfy reasoning in general terms, with no
    claim about this machine's setup.
  - **L2:** "(local script)" on the alert's line in the mod (`alertLabel` in
    `mod/hooks/model.js`, used by the summary and `view.js`).
  - **L7:** the README's "For a caller" says the body never carries a log tail, command
    output or a URL with parameters: only fixed words and the log's path.
- **Choices to defend:** (1) **the ingest socket, not the TCP port plus a token file.**
  The brief allowed "whatever pattern the server already uses for local callers", and that
  is the socket (0600 in the owner's 0700 folder), chosen over a per-install token on
  2026-11-12 for the same reason: anything that can read a 0600 token file can open the
  0600 socket. The TCP port refuses the route unread from loopback too, and the route also
  refuses any proxy header on the socket. (2) **Cut, never refuse, an over-long title or
  body,** and **withhold, never refuse, a credential-shaped text:** a failing script's
  alert should still arrive. (3) **The key is the title alone, not the body or severity,**
  so a body that names a changing detail is still one condition with one ack; a caller
  keeps its titles fixed (README). (4) **Dedupe counts 10 minutes from the post that was
  taken,** and a duplicate still refreshes the entry's time. (5) **The push caps count
  every push tried** (a failed or still-pending one too), not only delivered ones, so a
  failing push service can't be retried past them; push off counts nothing. (6) **In
  memory only:** the body is never in a file or a log; a restart forgets the alerts, the
  limits and the caps. (7) **Ack-able for 24 hours only.** (8) **Not through the
  notifier:** no ntfy, `#pepper` or event, because the caller posts to Discord itself.
- **To go live:** C&P, then **a restart of the server** (Needs Jeff: the LaunchAgent is
  Vision's; the route and the push are server code), then `cd web && npm run build` in
  the main checkout (strip, card and the service worker's tag). The build alone is safe
  before the restart (today's server sends no `local` alerts). The mod's change reaches
  Claude Code when the mod is next loaded. Then the Jarvis side can start calling it.
- **After the restart, check (Jarvis can, from the mini):** the start log has no new
  problem; a test post `printf '%s' '{"title":"Test alert from the Control Room","body":"A check after the 11-19 change. Acknowledge it.","severity":"info"}' | curl -sS --max-time 20 --unix-socket ~/.local/state/jarvis-os/ingest.sock -H 'Content-Type: application/json' --data-binary @- http://localhost/api/ingest/local-alert`
  answers `push: "on"` with `reached` equal to the paired devices; Jeff's iPhone and iPad
  show "Local alert: Test alert from the Control Room" (locked too), a tap opens the
  Overview, the strip and the Needs you card show it, Acknowledge puts it away, and the
  same post again answers `duplicate: true` (within 10 minutes) or `push: "acked"` (after).
  This posts to Jeff's real devices, so only with his OK.
- **Checked (2026-11-19, after Ultron's fixes):** server 1,658 tests (1,618 on main; 37
  new in `local-alerts.test.mjs`, 3 in `mod-alert-label.test.mjs`, one route added to
  `ingest-socket.test.mjs`), under umask 022, in local time and `TZ=Asia/Tokyo`; web 359
  (351 on main; 7 in `orbit-local-alerts.test.js`, 1 in `orbit-push.test.js` for the
  service worker's tag), both time zones; the mod's harness test in `mod/tests/model.test.ts`
  added, not run (harness only); oxlint clean on every changed file (older warnings in
  `server.mjs`, `chat-push.mjs` and `mod/hooks/model.js` are not this branch's). 156 of
  156 mutants caught (one by hanging the run), covering the request checks and cleaning,
  the cuts, the credential check, the key, `since`, repeats, the ack check and its
  wiring, the kill file, both push caps and their reserves, the intake limit and its
  reserve, Retry-After, the windows' rolling, dedupe and its "reached nobody" rule, the
  concurrent post, keeping and expiry, the push wait, the route's proxy refusal and
  guards, the TCP refusal, the dashboard's order, the payload's marker, fit, urgency,
  Topic and TTL, the service worker's tag, the mod's label in the summary and the pane,
  the page's chip, text, strip time, ack choice and run-sheet rule, and the README's two
  caller rules and the ntfy wording. The README's curl, exactly, against a scratch server
  on the real ingest socket code (socket under `~/.local/state/jarvis/scratch-alertpush`,
  port 8397, push recorded, no device): taken, a repeat answered as a duplicate with the
  first push's outcome, proxy header 403, TCP 403. Headless Chromium against that server
  at 390 (light) and 1440 (dark), 35 of 35 checks: two alerts in the strip, last raised
  first, with their time; Bring Jarvis Back on the jarvis-down one only, in the strip and
  on its card; chips "Jarvis down" and "Warning"; the body in its two lines; the meta
  line; Acknowledge offers one choice, "For 24 hours", and Save takes the alert off the
  strip; no sideways scroll, no policy violations, no page errors.
  **Unverified:** a real push through Apple to Jeff's devices (the post-restart check
  above), Safari and the installed app (no WebKit on the mini), iOS before 18.4 on a real
  device, and the mod's pane in Claude Code (its `alertLabel` is tested in node and in
  `mod/tests/model.test.ts`, which runs only in the mod harness).
- **Follow-ups (asked for as board items):** a way for the start script to clear its own
  alert when Jarvis comes back (`{"clear": "jarvis-down"}` or similar), so the strip
  doesn't keep "Jarvis failed to start" until it is acked or a day passes; and the Jarvis
  side's calls (`bin/jarvis-start`, `bin/routine`), which this contract is for.

## 21. Jarvis at 100%, and back under: the full line and the back line (board 1e2d7926, P0; merged as main 0c568da, seen 2026-11-20)

**Merged as main 0c568da (built on `jos/limit-full`, worktree `~/Projects/.worktrees/ccr-limit-full`,
from main 0efa83f); whether the server restart it needs has happened was not checked from here.** Ultron's 11-19 M5 on board 1e2d7926: at 100% the lead
goes silent until the reset, and the 95% warning was the last word anyone got. Two pieces,
on top of §11's warnings; the README's "The full line and the back line" (under "Push
notifications") is the reference.

- **The full line.** At 100% of the session or of "Weekly · all models": `Jarvis is at the
  session limit until 5:30 pm` / `Jarvis is at the weekly limit until Mon Nov 23, 7:00 pm`
  (no time when the reading has no reset). To the paired devices (the warnings' Web Push)
  and ntfy, and posted to **`#jarvis`** through `discord-post --agent jarvis` (the feed the
  lead's routines post to) in place of `#pepper`. It is the 100 step of the warning keys,
  so once per window with the same dedupe, caps, device debt and early-reset rule. No event.
- **The back line and the reset event.** Once every limit told full reads under 100% in a
  window that has turned over (reset passed, another window named, or under 40%), and no
  limit with a full step reads 100% now: `Jarvis is back under the limit` to the paired
  devices only, and one Control Room event to the lead, source `limit`, type
  `limit-reset`, fixed words stating a fact: `Limit reset: Jarvis is back under the Claude
  limit; messages may have come in while he was at the limit.` (no count, no message
  content, no instruction).
- **Ultron's review, 2026-11-20: GO, one medium and six lows; all handled in the same
  staged change.** M1: the event's words were an imperative ("Check the chat…"); events
  are data to the lead, so they now state a fact, and Jarvis adds his own style rule for
  acting on it. L1: a week whose full line failed to send was in no `out`, so the session's
  reset could say "back" while the week read 100%; now no back line while any limit with a
  full step reads 100% or more (`fullNow`), and the limits that turned stay out with it.
  L2: a reading with no window (no reset time, or one that does not parse) counted as
  "another window"; now it names none, and only the 40% mark or the told reset's passing
  says back. L5: the 18-a-day cap applied to every limit; now six a step, the full step
  counted (`dailyMax`): 18 for the session, 12 for the all-models week, 6 for a model's
  week. L6: the wording of choice (3) below. L4, accepted, no code change: the reset event
  has no alert key, so a restart in the middle of the pass that makes it (after the
  event, before `notified.json` is written, or the reverse) can lose it or send it twice.
  L3 (a double wake with the answer watch's event) is Jarvis's to handle in his style
  rule.
- **Checked against what was there:** the existing event to the lead (§11) fires only at
  the steps, never at a reset, so it did not already do the catch-up. The jarvis repo's
  answer watch sends its own `answer-watch` event (with a count) only when one of the
  owner's messages actually waited; this one goes after every reset that followed a full
  line and names nothing, so the two overlap in purpose but not in content.
- **Choices to defend.** (1) Only the session and the all-models week have the full step:
  the lead runs on the default model, so a model's own weekly limit (Fable) at 100% does
  not silence him; at 100% it keeps its 90% line. (2) No event at 100%: the lead is the
  one at the limit, and the full line is outside WARNING_BODY's shape, which is the
  event check; the 95% event, if still undelivered, is no longer deliverable then (its key
  is not the live alert). (3) Back needs the window to turn over, not just a reading under
  100%. Ultron replayed 29,143 readings (2026-08-06 to 11-20) and found no dip from 100%
  to 40-99% inside a window, so this guards a case not yet seen; the rule stays, because
  "back" followed by silence would be worse than waiting. (4) Back waits for every limit told full (session reset while the
  week is full says nothing). (5) The back line goes to the devices only; the `#jarvis`
  post of the full line is the record. (6) The reset event is told at any hour, not held
  to 07:00 like a warning: messages that waited out the limit should not wait longer.
  (7) The day cap is six tellings a step, the full step counted: 18 for the session (six
  session windows of three steps), 12 for the all-models week, 6 for a model's week.
  (8) 12-hour times ("5:30 pm"), like the warnings, though the brief wrote HH:MM; the date
  is added off-day because a weekly reset can be days away. (9) A limit kept out more
  than eight days is dropped with a log line and no back line.
- **To go live:** C&P, then a **restart of the server** (Needs Jeff: the LaunchAgent is
  Vision's; the notifier and its hooks are wired at start). No web build, no config, no
  new `claude -p`.
- **After the restart, check:** at the next 100% (not to be caused on purpose), the log has
  `push: a limit warning went to N of N devices`, the phone shows "Jarvis is at the session
  limit until h:mm pm" titled Control Room, `#jarvis` has the same line (a `[discord]
  posted` line in the log), and no event line. After the reset: `push: back under the
  limit; the line went to N of N devices, the lead's event: made`, the phone shows "Jarvis
  is back under the limit", and the lead gets the `Limit reset:` line (its tag reads
  `event="unknown"` until the channel learns `limit-reset`).
- **Checked (2026-11-20, after Ultron's fixes):** server 1,688 tests (1,658 on main; 15
  new in `limit-full.test.mjs`, 15 in `notifier-limit-full.test.mjs`; six existing tests
  changed on purpose: the day cap read through `dailyMax`, the 95% event no longer deliverable at 100%, the
  run to 100% in the step test now stops at 99, the kept state's new fields, the feed in
  `sendAlert`'s call and in `server.mjs`'s source), under umask 022, in local time and
  `TZ=Asia/Tokyo` (the new files also in `TZ=America/St_Johns`). 116 mutants over the
  changed code: 108 caught on the first run; of the seven that survived, four got a test
  (the event's status in the log, reached against tried, a debt alone keeping the state,
  the ledger saved), and three were code that did nothing (a reading guard and a
  freshness check the panel's blanking already made, and an inert `failure` flag on an
  `immediate` event), now removed; a rerun of those and three replacements, all caught.
  After Ultron's fixes, 18 more mutants over the new lines (the cap per rule, `fullNow`
  and the hold, the no-window rule, the event's words): 17 caught at once, and one (a
  limit dropped after eight days kept while another reads full) after a test was added.
  oxlint clean on every changed line (two older warnings in `chat-push.mjs` and
  `server.mjs` are not this branch's). **Not verified:** a real push or a real `#jarvis`
  post (no restart here), iOS's showing of the two new lines, and the lead's reading of
  the `limit-reset` event.
- **Follow-ups:** (a) the channel's `EVENT_NAMES` (jarvis repo) knows neither
  `limit-warning` nor `limit-reset`, so the lead's tag says `event="unknown"`; a channel
  release, through Jarvis. (b) What the lead does on `limit-reset` (read the chat history
  and Discord, answer what is open, and not twice when the answer watch's event comes
  too) is his style rule to write; the event only states the fact. (c) If
  the lead moves to a model with its own weekly limit, that limit needs the full step
  (`ruleFor` in `server/lib/limit-warnings.mjs`).

## 22. Restart Jarvis from the page, with Face ID (board 98a30b15, P0; merged as main 70dd8bf and live 2026-11-20; Ultron GO, his L1, L2, L4 and Q1 in)

**Merged as main 70dd8bf and live since the 2026-11-20 restart (about 20:37Z) and web
build; built on `jos/recover-jarvis` from main 0c568da.** Ultron reviewed it 11-20: GO, four lows. L1, L2, L4 and
his Q1 sheet wording are in, on Jarvis's decisions; L3 (a lock in jarvis-recover itself, for
a second run beside a hung one after the 45-minute no-answer) is the jarvis repo's, its own
board item. Ultron's M8, after the outages of 11-19 and 11-20: when
Jarvis is down, Jeff brings him back from his phone with one tap and Face ID. Jeff only
cares that it reliably brings Jarvis back, and wants it simple. The README's "Restart
Jarvis from the page" is the reference; this is the state, the choices and the go-live.

- **What it does.** A card under the alert strip, on every tab, when the strip says the
  lead is down (his session five minutes gone, or a local `jarvis-down` alert): "Jarvis is
  down", Restart Jarvis, Bring Jarvis Back, and the run sheet's line with Copy. The tap
  opens a sheet (the confirm, then Face ID with the Stop's passkey); the server runs one
  fixed program, `/bin/bash ~/Projects/.worktrees/jarvis-release/bin/jarvis-recover` from
  `~/Projects`, and the card shows "Restarting Jarvis…", then "Jarvis restart: OK" or
  "NOT OK" with the script's last line, for 30 minutes. The Chat banner (offline, stuck)
  and the Chat ⋮ menu (always) open the same sheet. Every Jarvis-down push and alert now
  carries the line: "Jarvis is offline", a local `jarvis-down` push, the notifier's alert
  for the lead's session five minutes down (in `#pepper`; never in ntfy, L1 below), and the
  Needs you cards.
- **Ultron's fixes (11-20, on Jarvis's picks).** **L1:** the lead-down alert's ntfy copy
  carries no command, since anyone who knows the topic can publish to it and a forged
  "paste this" would look real. It says "Restart Jarvis in the Control Room (Face ID), or
  paste the line from the run sheet (Bring Jarvis Back) in a terminal on the mini"
  (`RECOVER_NTFY_LINE`); the entry's `ntfyMessage` reaches ntfy through the new
  `entryAlert` in `notify.mjs`, which server.mjs's notifier now uses. Web Push, `#pepper`
  and the page keep the command. **L2:** a run the ledger still has as `starting` at load
  (the server stopped between writing it and recording the pid) is closed like a
  no-answer, verdict `unknown`, line "The Control Room restarted while starting
  jarvis-recover; it may have run; see ~/Library/Logs/jarvis-recover.log". I dropped the
  "NOT OK:" Ultron's wording had, because a no-answer is not a NOT OK and the prefix would
  have made the verdict `not-ok`. **L4:** `recover-refused`, alerted and capped at one push
  per 10 minutes like `heal-tap-refused` (the rest counted): a Shortcut key on a POST
  (alerted only from the owner's login, as for heal taps), a paired non-approver on a
  POST, or a Face ID answer that fails (wrong purpose, expired, bad signature, malformed).
  The status GET never alerts, because every page reads it. **Q1:** runs stay
  unconditional. The status carries `jarvis: { health, stopped }` (health from the health
  panel's lead session, `unknown` when the panel isn't current; the stop flag
  `~/.local/state/jarvis/jarvis-stopped`). The sheet says "Jarvis looks up; this ends his
  current turn" and "Jarvis was stopped on purpose; this restart clears that" before Face
  ID (amber, `sheetNotes`), and `recover-asked`, its log line and the ledger record both.
- **How jarvis-recover behaves without a terminal (read 11-20 from the release
  worktree, 2e075be).** It does not block. Its only prompt is the Keychain unlock, and it
  asks only `if [ -t 0 ]`; the server gives it `/dev/null` as stdin, so a Keychain it
  can't reach ends the run at once with `NOT OK: this shell can't reach the login
  Keychain. Run: security unlock-keychain ...`. Run from this LaunchAgent, in the owner's
  login session, the Keychain is reachable (the probe is `security show-keychain-info`,
  status 36 only from an SSH shell). Nothing else in it reads stdin: the plugin commands
  have 120 s timeouts and jarvis-start runs claude in tmux. So the fixed command is the
  script itself, not `launchctl kickstart -k gui/501/com.jeff.jarvis.restart`: the script
  does more (stop flag, folder trust, the plugins, the dry run's ladder) and ends with the
  OK / NOT OK line the card needs, where the kickstart would run a bare `jarvis-start
  --restart` whose result would have to be dug out of a log. **No launchctl call is in
  this change.** The script's own restart is the protected step: it restarts the lead (a
  tmux window), on Jeff's Face ID only.
- **Choices to defend.** (1) The script, not the restart job (above). (2) Detached, output
  to a 0600 file, never a pipe: a restart of this server must not end a recovery half way
  (launchd ends the job's process group), and a pipe's reader gone would end the script on
  its next write (SIGPIPE). (3) A built environment (HOME, the restart job's PATH, LANG,
  `xcrun_nocache`, USER, LOGNAME, SHELL, TMPDIR) and nothing else, so a tmux server the
  script starts never carries `XPC_SERVICE_NAME` or other Control Room variables into the
  lead's session. (4) The server does not check that the lead is down before it runs (Ultron
  agreed, Q1): the page's stuck state is the page's alone, and a wrong "up" would block the
  one way back when it is needed; Face ID, the confirm (with "Jarvis looks up" when health
  says so) and the limits make it deliberate. The card only shows when the strip says down; the menu item is always there.
  (5) Limits: one at a time; 3 an hour, 8 a day, counted from the ledger so a restart of
  this server keeps them; checked before Face ID and again after. (6) Never killed: after
  45 minutes the card says "No answer" and a new run may start (jarvis-start's lock keeps
  two from overlapping); a late end still lands. (7) The passkey is the Stop's: one Face ID
  set-up per device, and a challenge names its purpose, so a Stop's answer can't start a
  restart. (8) After an OK, no second Restart for 5 minutes even if the alert is still on
  the strip (the health panel lags a poll or two); after a NOT OK the button stays. (9) The
  lead's down alert is its own message now instead of "1 service is down": in `#pepper`
  with the command, in ntfy with the ways back and no command (L1). (10) The events
  `recover-asked`, `recover-done` and `recover-refused` are alerted like a Stop (`#pepper`
  with the device and the line; ntfy its generic words), `recover-refused` capped.
- **To turn it on (Needs Jeff):** C&P; then add `"recover": { "enabled": true }` to
  `server/config.json` (a top-level key); then a **restart of the server** (the
  LaunchAgent is Vision's; the routes, the alert text and the config are server code);
  then `cd web && npm run build` in the main checkout (the card, the sheet, the banner, the
  menu). The build alone before the restart is safe: the page asks `/api/recover/status`,
  today's server answers 404, and the card shows the line to paste with no button.
  **Rollback, any of:** `touch ~/.local/state/jarvis-os/recover-off` (no restart; every
  restart refused, the card keeps the line); `"enabled": false` and a restart; or revert
  the commit, rebuild and restart.
- **After the restart, check (Jeff, on the iPhone):** the start log has `recover: Restart
  Jarvis from the page is on; 0 runs in its ledger`; Chat ⋮ shows "Restart Jarvis…"; it
  opens the sheet, and on a device without the Stop's passkey offers "Set up Face ID" (then
  `bin/chat-pair passkey <CODE>` at the mini). With Jarvis up, the sheet says "Jarvis looks
  up; this ends his current turn" in amber (Cancel there: no run). The first real run is a real restart of
  Jarvis, so only when he is down or with Jeff's say-so: the card goes "Restarting
  Jarvis…", then OK with the script's line, `#pepper` gets both events, and
  `server/data/chat/recover/` holds the output.
- **Checked again after Ultron's fixes (2026-11-20):** server **1,717** tests pass (7 new:
  L1's notifier alert, L4's two, Q1's four; the L2 assertion rewritten; the notifier's two
  source tests now match `entryAlert`, and one of them also runs it for the feed), local time
  and `TZ=Asia/Tokyo`, umask 022; web **369** (2 new: the sheet's notes, and that they sit in
  the confirm step), both time zones; oxlint adds nothing on the changed files; a web build to
  a scratch `--outDir` succeeds. 16 mutants over the new code (the ntfy words, `entryAlert`,
  L2's verdict, each `recover-refused` and its login check, the cap, the router passing the
  login check, `leadHealth`'s rules, the status and event fields, the stop flag's default
  read, `sheetNotes`): all 16 caught. **Not verified for these fixes:** the sheet's notes in a
  browser (unit and source tests only; the scratch https kit was gone), Safari, and a real
  ntfy or `#pepper` post.
- **Checked first (2026-11-20, before the review):** server 1,710 tests (1,688 on main; 22 new in
  `jarvis-recover.test.mjs`, four existing assertions updated for the new alert text and
  one source-test pattern widened for the new `recover` argument), under umask 022, local
  time and `TZ=Asia/Tokyo`; web 367 (359 on main; 8 new in `orbit-recover.test.js`, the
  local alert card's text test updated), both time zones; oxlint clean on every changed
  file (the older `chat-push.mjs` warning is not this branch's). One test runs a scratch
  script for real through `child_process.spawn`: no terminal (`[ -t 0 ]` false), the
  folder, its own process group (pgid = pid), no `XPC_SERVICE_NAME`, `TMUX` or other
  variable, and its last line as the result. 78 mutants over the server module, the
  routes' wiring, the alerts and the page logic: 74 caught on the first run, the other 4
  after tests were added (the ledger written before the spawn, a dead pid closed at load,
  a live pid still watched, the router's `owns`); the whole list rerun after. Headless
  Chromium against a scratch https server (worktree routes, step-up, recover module, a
  scratch HOME whose `jarvis-recover` is a fake script; CDP virtual authenticator for Face
  ID; port 8396, never :8322), 44 of 44 checks at 390 light and 1440 dark: the card and its
  44 px button, Copy, the Needs you card's line, Face ID set-up with the code confirmed at
  the "machine", the restart, the running card, OK with the line, no second Restart right
  after an OK, the result kept across a reload and put away with Done, the Chat banner and
  menu, Escape, NOT OK with the button back, the fourth run in an hour refused with the
  reason, a non-approver device with the card and the line but no button, no sideways
  scroll, no page errors. **Not verified:** the real jarvis-recover run by the server (it
  restarts Jarvis), Safari and the installed iPhone app (no WebKit here; Face ID on the
  device), and a real push with the new text.
- **Ultron's answers (11-20):** Q1 keep the run unconditional (done, with the sheet's
  words); Q2 the environment list is right, add no `TERM` or `JARVIS_*`; Q3 no command in
  ntfy (L1, done). His monthly sweep: `recover.enabled`, the `recover-off` file, the mode and
  count of `server/data/chat/recover.json`; re-vet `recoverProgram`, `recoverEnv`, `gate`,
  `PURPOSE` and any route added here. Open: L3, the lock in jarvis-recover (jarvis repo).

## 23. Late re-sends from the chat: an old message held for a tap and marked late (board 89248590, P1; merged as main 66e4011, seen 2026-11-20)

**Merged as main 66e4011 (seen 2026-11-20; built on `jos/stale-resend`).** Whether the
restart and web build it needs have happened isn't recorded here. The README's "Late sends"
paragraph (under the Chat tab) is the reference; this is the evidence, the choices and the
go-live.

- **What happened (2026-11-20).** Seq 1066 and 1067 came from the iPad at 20:38:49.021Z and
  .029Z. Their clientIds (`p_<ms in base 36>_…`, made at the Send tap) decode to 17:10:52Z
  and 17:11:00Z: written 8 s apart, at 12:10 ET, delivered 3 h 28 min later and 8 ms apart.
  The server had restarted at 17:10:12Z and took the Mac mini's own messages from 17:13Z,
  so the iPad's two requests never reached it then; Jeff re-sent the same terminal check
  from the iPhone at 17:38Z (seq 1024). No earlier copy of either clientId is in the store.
  The service log shows "Jeff's iPad turned notifications on" at 20:38:52.8Z, 3.8 s after
  the two arrived: `resync()` runs only when the page loads (main.jsx), so the iPad page
  reloaded right then. That fits the old page waking, its two held sends going out, the
  reload hold (`hasUnsent`) letting go, and the build watch reloading for the 70dd8bf
  build.
- **Root cause.** The page never re-sends by itself: `useChat.js` sends once in `send()`
  and again only from the Retry button; the service worker has no fetch handler and no
  queue; nothing persists a bubble across a reload. Two sends written 8 s apart can't land
  8 ms apart from taps. So the two `fetch` POSTs most likely sat in the iPad's network
  layer while the page was suspended, with no timeout on the page's side, and went out
  when it woke. **Not proven:** which WebKit or network state held them (no WebKit here,
  and the iPad's own logs aren't readable). Either way the server stamped the arrival time
  (`at`), the page sent no compose time, and the lead had nothing to tell the two apart
  from new messages.
- **The fix, and why this one.** The server is the one place that sees when a request
  lands, so the gate lives there and works whatever held the request: the page sends
  `composedAt` and `confirmed`; a first attempt older than 5 minutes is refused with 409
  `stale` and not stored; the bubble asks "Send now" with the time it was written; a tap
  sends it, marked late in its meta, on the page ("written 12:10 PM") and on the lead's
  inbound line (a leading `[Written 12:10, delivered 15:38: … late …]` note plus a
  `composedAt` field). The clientId dedup runs first, unchanged, so a retry of a stored
  message still answers 200 `duplicate`. A page from before this change is covered too:
  without `composedAt` the server reads the time in the clientId. Considered and not
  taken: a page-side timeout or age check alone (a suspended page's timers don't run, and
  the held request can go out before the page's code does) and a service-worker queue
  (more moving parts, and the worker has no fetch handler on purpose).
- **Choices to defend.** One window, 5 minutes, for both the hold and the mark. `confirmed`
  is a boolean, not a tap time: a time would compare the device's clock with the server's
  twice, and a slow device clock could then never send. Every Retry counts as a tap, so a
  fresh failure retried at once goes as before. The note goes in the inbound text because
  today's channel shows only the arrival time (`ts`); the stored text stays as typed.
  Uploads waiting on a held message stay pending (an hour), so Send now within the hour
  needs no new upload.
- **Limits.** The device's clock is trusted: ahead of the server's counts as now (the old
  behaviour); more than 5 minutes slow would hold every first send for a tap. A held Send
  now tap can itself arrive late; it is stored, but marked late on the page and for the
  lead. A message held more than an hour with photos fails its Send now with "an
  attachment id is unknown" (the uploads expired), and the bubble keeps asking: Discard and
  send again (an older gap, not this branch's).
- **Checked (2026-11-20):** server 1,724 tests (7 new in `chat-late.test.mjs`, one of them
  replaying the 11-20 pair: two bodies made 8 s apart landing 3 h 28 min later 8 ms apart),
  web 374 (5 new in `orbit-chat-late.test.js`), both in local time and `TZ=Asia/Tokyo`;
  oxlint clean on the changed files (four older warnings in `chat-routes.mjs` aren't this
  branch's). 18 mutants over the server module, the route, the inbound line and the page
  logic, all caught. Headless Chromium against a scratch server (port 8397, the worktree's
  chat routes on a clock the check moves, the page built to the scratchpad): the first
  POST held by `page.route` while the server's clock jumps 3 h 28 min, then released: 12
  of 12 checks at 820 and 390 px (the 409 hold, nothing stored, the log line, "Written …,
  not sent" with Send now and Discard, Send now as a tap with the same clientId and time,
  stored once with `meta.composedAt`, "written …" under it, a later fresh send unmarked).
  A mutant build whose Retry sends no `confirmed` failed 5 of them. **Not verified:**
  Safari and the installed iPad app, and what WebKit really did with the two requests.
- **Go-live (Jeff, after Ultron and C&P):** a web build and a Control Room restart. Order
  doesn't matter much: an old page against the new server has its stale sends held and its
  Retry refused again (no `confirmed`), so it must Discard, which also lets the build watch
  reload it; a new page against the old server sends two extra fields the old route
  ignores.
- **The channel (jarvis repo, not edited here):** `messageNotification` in
  `jarvis-local/plugins/jarvis-channel/server.mjs` builds the tag with `ts: isoOf(ev.at)`
  only. Proposed: when `ev.composedAt` is a safe integer, add `written: isoOf(ev.composedAt)`
  and `late: '1'` to the tag's meta, and one line in the instructions ("a tag with late="1"
  was written at `written`, long before it arrived: read it as of then"). Then the server's
  text note could go. Until then the note does the job.

## 24. Restart Jarvis warns before it stops agent runs (board d8f27c49, P1; on main as b8c148d, live per Jarvis's 2026-11-21 brief)

**On main as b8c148d (2026-11-20), live.** Ultron's M1 on it (a partial sessions read
counted as known) is fixed in §28. README "Restart Jarvis from the page", bullet "Agent
runs", is the reference; this is the why, the choices and the go-live.

- **What happened (2026-11-20 16:14 ET).** Jeff tapped Restart Jarvis (§22) while two agent
  runs were going; the restart ended the lead's session and both runs with it. Jeff: "I just
  don't want you making ridiculous mistakes that should be easily avoidable, like asking to
  restart mid process".
- **The fix.** The status lists the runs a restart stops (`agents`), the sheet says so before
  Face ID with Cancel the default, and the server refuses (409) a restart whose POSTs don't
  name each run, so a page with an old status can't skip it. With no runs, the sheet is as
  before (one difference: its button reads "Checking…" for the moment the fresh status read
  takes after the sheet opens).
- **Choices to defend.**
  - The source is the live agents panel, reused, not a new read: `runsAtRisk` filters its
    rows to subagents in the session named as the lead's (the same name test as the Stop
    buttons' `stoppable`). Routines (`claude -p --agent`) and other sessions' subagents are
    left out because a restart doesn't stop them; a warning that names them would be wrong.
    The cost: a subagent of a lead session that lost its name would go unlisted (the Stop
    buttons share that limit).
  - The confirm names run ids, not a yes/no flag: a run that starts after the warning was
    read needs a new confirm, and a run that ended since doesn't.
  - Not current is a warning, not a pass: when the panel is stale, missing or cut, the
    sheet says the runs can't be seen and the confirm must say `unseen`. One extra tap,
    never a missed warning. A page served before the server restart (no `agents` in the
    status) warns the same way.
  - Checked twice on the run POST: before Face ID is used, and after it, just before the
    run's claim (no await between), so a run that started while Face ID was up is caught.
  - Quiet runs are still listed, marked "quiet N min": when Jarvis is down his runs may be
    dead already but stay on the panel up to 15 minutes; the mark says so, the warning
    still asks.
  - The ask's event (`recover-asked`) names the runs stopped, so the lead knows what to
    re-brief when he is back.
- **Limits.** The panel is read once a minute, so a run started in the last minute isn't
  listed. Over 20 live runs (the panel's bound) counts as not known.
- **Checked (2026-11-20):** server 1,730 tests (6 new in `jarvis-recover.test.mjs`), web
  378 (4 new in `orbit-recover.test.js`), both in local time and `TZ=Asia/Tokyo`. In this
  agent's shell (umask 077), `acks.test.mjs`'s "a fresh file, with the default mode" fails
  on main too; with umask 022 all 1,730 pass. 16 mutants over the server module and the
  event line, 6 over the page logic, all caught. oxlint clean on the changed web files.
  Built to the scratchpad (live `web/dist` untouched). Headless Chromium against a fake
  status server, 36 of 36 checks at 390 and 820 px: no warning and today's buttons with no
  runs; the warning text first, Cancel focused and filled, Enter cancels and posts nothing,
  Restart anyway sends both ids; "can't see" sends `unseen`; a stale status gets the 409,
  then shows the list and "changed since this opened". Light and dark screenshots looked
  right. **Not verified:** Face ID through the real server end to end in a browser (the
  route tests cover it with a software authenticator), Safari, and the iPhone/iPad.
- **Go-live (Jeff, after Ultron and C&P):** a Control Room restart, then a web build. Either
  order is safe: a new page against the old server warns that it can't see the runs (the
  old status has no `agents`) and sends a field the old routes ignore; an old page against
  the new server gets the 409 when runs are live and shows the server's error, so a restart
  waits until the build reaches it.

## 25. The idle wake-up goes after a busy day and while Jarvis talks (boards 8a13e971 and 638d21d2, P0; on main as dc929c2 with Ultron's M1, live per Jarvis's 2026-11-21 brief)

**On main: fd65a3f (the fix, Ultron's GO 2026-11-20) and dc929c2 (his one medium, M1,
the weekly reserve for the days left), from `jos/idle-wake-fix`; Jarvis's 11-21 brief calls
dc929c2 live. Jeff picked option (a), the day-ahead gate.** README "The idle wake-up" is
the reference; this is the why, the evidence, the choices and the go-live. Jeff raised the
burn-down not running three times on 11-20 ("Why is it so hard to get this next best to due
process to run?") and said "Yes fix it and go" on 638d21d2 (21:33 ET).

- **Why it went quiet (8a13e971).** Not the lead tracking: the weekly gate. The wake-up
  needed every weekly limit projected under 100% to its reset, and the projection follows the
  last 24 hours (§18), so a busy day of runs pushed it over. Replaying the real `/usage`
  history through main's `idleCheck`: all models sat at 60-67% and projected 100-113% from
  11:00 ET, so the rule read `week-high` every pass except 10:15-10:45, 14:30 and 15:00-15:15
  ET, exactly where the two made wake-ups fell (10:13 and 15:15). Replaying the transcripts for
  the sessions half: no live run and the lead quiet 10 to 140 minutes over 17:00-19:00 and
  19:10-21:29 ET, and the new lead session after the 19:02 restart was found by its name. The
  log has no line for `week-high` (only made and not-sent are logged), which is why it looked
  like nothing at all. Morning 07:00-10:13 was the same: 100-122% projected.
- **The fix.**
  - Weekly gate: every weekly limit **a day from now** at its pace (`weekAhead`: the
    projection to the reset cut to one day) under its bar (`weekBar`: 90% less 5 points for
    each day past the first left to its reset, Ultron's M1; 60% with no reset printed). The
    real history replayed: `idle` from 06:00 to 16:00 ET on 11-20, `week-high` 16:30-19:00
    (67%, 106-113% projected), `idle` 19:30-21:30 as the rate eased, `week-high` again at
    22:00 (68%, 108%: 82% a day on against a bar of 80.6%). Over the whole history (hourly)
    it opens 89 hours the old rule closed and closes 170. In effect it paces the burn-down to
    end the week near 90% rather than stopping it.
  - Lead's own session not read (638d21d2): `idleCheck` no longer looks at `agentWork`; the
    settle is 5 minutes from the first idle pass (it was 10 minutes from the later of that
    and the lead's last request).
  - Spacing: 15 minutes after a wake-up a run followed; 1, 2, then 4 hours while unanswered
    (as before). Events ledger floor: one in 15 minutes and 48 in any 24 hours.
  - Words: `… Session at 12%; weekly limits at most 61% now and 70% a day from now at their
    pace. …` (was "highest weekly projection N%"; the channel passes the text through, and
    only its tests quote the old words).
- **Choices to defend.**
  - A day ahead under a bar, not dropping the projection (Jeff's pick, (a)): without it
    nothing would slow the wake-ups before a limit reached 90% at a heavy pace. The
    alternatives were percent-only (simplest, no warning before 90%) or keeping the
    projection under 100% (silent after every busy day, the bug).
  - The reserve (Ultron's M1): 5 points a day past the first, fractions counted, so the
    bar rises smoothly to 90% on the last day. A limit with no reset printed gets the full
    week's 60%; a weekly limit at 0% prints none, and 0% passes it.
  - 5-minute settle: one pass of confirmation after a run ends, so the lead can chain the next
    run itself after reading a report before a wake-up lands.
  - 48 a day, not 30: with nights on (Jeff 21:37 ET, `quietHours: false`) a day of half-hour
    runs, each answering a wake-up, makes about 41 (scratch integration of the real check and
    events module); 30 would have stopped it by late afternoon. The back-off, not this cap,
    is what stops spam: an ignoring lead gets 8 in 24 hours.
  - Any live run answers a wake-up (a routine's or one Jarvis started for a chat too): it
    shows the lead is acting, and the 15-minute floor still holds.
- **Checked (2026-11-20):** server 1,736 tests in local time and `TZ=Asia/Tokyo`, web 378.
  New or rewritten: `proactive-idle.test.mjs` (36; the busy-day reproductions, one through
  the real `buildUsagePanel`, the lead-busy one, the bar, and 11-20's real 68% reading),
  `proactive-idle-events.test.mjs` (13, the 15-minute floor and the 48 cap). 26 mutants for
  fd65a3f and 8 for M1, all caught after three redundant checks were removed (a percent
  gate implied by the day-ahead one, the week's upper bound implied by ahead's, and a
  clamp on a past reset that the bar's own floor already gives). **Not verified:** a wake-up made by the live server (it needs the restart), and
  how Jarvis acts on one mid-conversation.
- **Go-live (Jeff, after C&P of the M1 change):** a Control Room restart only (server code; no web
  build, no config change; `proactive.idle` already has `enabled: true` and
  `quietHours: false`). Check after: the start line still ends `idle wake-up on (nights too)`,
  and within about 10 minutes of the board sitting idle with the weekly bar open a line
  `proactive: an idle wake-up to the lead's event (made)` (on the 22:00 ET reading of 11-20
  the bar was shut, so none may come until the day's rate eases). Undo: `~/.local/state/jarvis-os/idle-off` stops wake-ups with no
  restart. Check for live agent runs before the restart.
- **Next:** the log line when the rule is held is §26 (board 5c27ade0).

## 26. The idle wake-up says why it is held (board 5c27ade0, P2; merged as main d5d4aaf, 2026-11-21)

**Staged, not committed, on `jos/idle-blocked-log` (worktree
`~/Projects/.worktrees/ccr-idle-blocked-log`, from main dc929c2), one commit with §27.**
README "The idle wake-up", bullet "The log", is the reference. A held wake-up wrote nothing, so on 11-20 a
quiet afternoon took two replays to read as `week-high` (§25).

- **What it does.** One line when a held spell starts, with the reason and that pass's
  numbers, and one when a wake-up is next offered. Replayed over the real `/usage` history
  for 11-20 06:00 ET to 11-21 07:30 ET (an invented board, no run ever live), the check
  would have logged:
  `2026-11-20T21:25Z proactive: the idle wake-up is held (week-high): week (all models) at 79.8% a day from now at the last 24 h rate, its bar 79.5% (66% now, 3.1 days to its reset)`,
  `2026-11-21T00:10Z proactive: the idle wake-up is no longer held (week-high, first seen 2 h 50 min ago)`,
  the wake-up's line, then `02:45Z … held (week-high): … at 81.9% … its bar 80.6% (68% now,
  2.9 days to its reset)`; with §27 it opens again at 03:40Z (the replay is in §27).
- **Ultron's two lows (board 2190d996, 11-21), in:** a new reason is said only once it
  holds two passes in a row, so a reason flipping pass to pass (`usage-not-current` and
  `week-high`) or lasting one pass is never said (`heard` beside `held`; the passes a spell
  doesn't count neither confirm nor forget it; an offer forgets it). He offered that or
  "skip a repeat within 30 min"; two in a row was picked because a strict flip then logs
  nothing at all, where a 30-minute rule still logs both reasons twice an hour. Cost: a
  held line comes one pass (5 min) later, with that pass's numbers. His delta L1 (11-21)
  is in too: after six flips with nothing said, one line names both reasons (`… is held
  (week-high), flipping pass to pass with usage-not-current`), once a spell. And
  `daysToReset` is the one figure for the bar and the line (in spans of `IDLE.aheadMs`, as
  he asked).
- **Choices to defend.**
  - `running` and `settling` neither start nor end a spell. A run is the burn-down
    working, and a week-high spell interrupted by runs all day would otherwise repeat once
    a run; the settle is one pass after every run by design, so saying it would be a line
    a run with nothing in it. Anything held longer shows as another reason.
  - The wait right after a wake-up is not said: the wake-up's own line now ends with the
    back-off it starts (`the next no sooner than 15 min on if a run follows, else 1 h`, then
    2 h, 4 h), so a log of them reads 1-2-4-4 without a second line each. A wait met any
    other way (after a restart, or a week-high spell that opened inside the back-off) is
    said.
  - The spell is in memory, not in `proactive.json`: the second pass after a restart says
    what holds it, which is what a reader after a restart wants. No state-file change.
  - The "no longer held" line comes before the offer, sent or not (a daily cap shows as
    the existing `was not sent (held)` line after it); its span counts from the spell's
    first pass, runs in between included, so it says "first seen … ago", not "held for".
  - `week-high` names the limit furthest over its bar (by its limit-warnings name, never
    the panel's raw label: an odd label reads `week (one model)`). Percent and bar to a
    tenth, as the gate compares raw figures.
  - The view (`GET /api/proactive`) is unchanged: the numbers go to the log only.
- **Also:** Ultron's 11-20 delta L1/L2: `weekAhead`'s comment is back above `weekAhead`
  (it had ended up above `weekBar`'s).
- **Checked (2026-11-21):** server 1,743 tests in local time and `TZ=Asia/Tokyo` (7 new in
  `proactive-idle.test.mjs`: the reserve bar on 11-20's real reading with 13 passes and one
  line, no repeat across a run, every reason's words, quiet hours, the unsaid and said
  waits, the end line before a not-sent and an error, the words' edge cases), web 378.
  21 mutants, all caught (one first missed: the days clamp, until the test used a reset six
  hours past instead of one). **Not verified:** the live server's log (needs the restart).
- **Go-live (after C&P):** with §27, a Control Room restart only (server code; no build, no
  config). Check live agent runs first. After it, the second pass logs a held line if
  anything holds the wake-up.

## 27. A quiet night opens the idle gate: the lower of the day's and the last six hours' pace (board 07cb0505, P1; merged as main d5d4aaf, 2026-11-21; superseded by §29)

**Superseded 2026-11-21 by §29:** the weekly gate no longer reads any pace, and the six-hour
`pace.short` is gone. Kept below as the record of what was tried.

**Staged with §26, not committed (same worktree and branch). Jeff said "Go" 11-21.** README
"The weekly projection follows the last day's rate", bullet "A second, shorter rate", and
"The idle wake-up", rule 2 and "Why the lower of two paces", are the reference.

- **The miss.** Overnight 11-20/21 all models sat at 69% from 22:02 ET (no run from 23:49
  to 07:39), but the day-ahead figure used the last 24 hours' rise (+14 from the busy
  11-20): about 83% against a bar of 81-82%, so the wake-up was held until 07:35 ET and
  the board was not burned down overnight, which Jeff wants ("so we're not wasting tokens
  on them during the day").
- **What it does.** The usage panel gives each weekly limit `pace.short` (its percent six
  hours back and the true span, only when no two readings in those hours are over 30
  minutes apart); `weekPace` takes the lower of the day's figure and `pct + (six-hour rise
  + 1) x 24 h / span` (to the reset when under a day). The added point is Ultron's delta
  M1 (11-21): percents are whole, so a rise of up to a point reads as none, up to 4
  points a day (flat at 78% may be 78.95%, a pace near 82% against a bar of 80.6%). The held line names the rate it read
  ("at the last 6 h rate" / "at the last 24 h rate"). The session gate, the bar and
  reserve, the spacing and the projection on the page, the alerts and the mod are
  unchanged.
- **Replay (real `/usage` history, the real check, an invented 3-item board, no run ever
  live, nights on, 11-20 06:00 ET to 11-21 08:00 ET).** Old: wake-ups at 00:10Z, then held
  from 02:40Z to 12:35Z (07:35 ET). New, with M1's point: held 02:45Z (68-69%, the day's
  rate), open from 04:40Z (23:40 ET; 81.0% a day on, 2 points in six hours plus one,
  against a bar of 81.0%; 73% once flat six hours, from 09:02Z), wake-ups at 04:45Z,
  08:45Z and 12:45Z (23:45, 03:45, 07:45 ET), spaced by the unanswered back-off (4 h,
  since no run ever follows in a replay). From a fresh state at 02:30Z, after the 02:35Z
  wake-up both make: new 04:45Z, 06:45Z, 10:45Z; old none until 12:35Z. Without M1's point
  it had opened at 03:40Z. The gate alone, every 5 min of that span: 159 passes open under
  both, 57 held under both, 96 opened by the new rule, none closed.
- **Busy stretches still hold.** 11-20 21:20Z-00:05Z (16:20-19:05 ET, 10 points in six
  hours; 110% at six hours, 80% at the day's rate, bar 79.5%): held under both. Hourly over
  2026-10-08 to 11-21 the new rule opens 29 of the 183 hours the old one held (28 with a
  six-hour rise of 2 points or less) and closes none. The busiest days, 11-13 to 11-16 (a
  limit at 100%), stay held every hour. The trade-off is 11-12: after a heavy night the
  morning ran 4 points in six hours on all models (51%, bar 72%), so it opened 06:10-11:15
  ET and held again as the heavy afternoon began, through the evening (Fable from 51% to
  82%).
- **Choices to defend.**
  - The lower of the two, not a blend: a blend (say half each) keeps 11-12's morning held
    but opens the quiet night later and less often; the gate is read every 5 minutes, so
    a run that picks the pace back up closes it within a pass or two, and the reserve bar
    is what bounds the week. If Jeff wants it stricter, a blend or a cap on the six-hour
    rise is a one-line change.
  - Six hours, plus a point: it opened the night at 23:40 ET, 98 minutes after the last
    point. The day's rate keeps no added point: whole percents hide at most a point a
    day there.
  - A gap over 30 minutes in the six hours drops the short rate (the day's rate stands):
    an early reset and a climb back inside a gap would read as quiet. The history had 9
    gaps over 6 minutes in 14,362 readings since 10-01.
  - Read only by the gate: the page, alerts and mod keep the 24 h projection and its words.
  - With no projection (the first 10% of the week) the percent stands, as before; the short
    rate can only lower a figure, never raise it.
- **Checked (2026-11-21):** server 1,752 tests in local time and `TZ=Asia/Tokyo` (9 new:
  the gap rule and the panel's `pace.short` in `pace-recent.test.mjs`; `weekPace`,
  `daysToReset`, the real night through the panel at 05:00Z, the busy evening at 21:30Z,
  the night pass by pass (first wake-up 04:55Z on these readings, 12:35Z without the
  short rate), Ultron's flat 78% against an 80.6% bar (held), the two-pass rule with the
  six-flip line, and the rate words in `proactive-idle.test.mjs`), web 378. 37 new
  mutants: 35 caught (a null percent only after a test for it was added), 2 equivalent and
  their code removed as redundant; 9 more over M1 and L1, all caught; a no-op baseline
  survived each run, as it must. The 18 mutants of §26 that still apply, all caught.
  **Not verified:** the live log after the restart.
- **Go-live (after C&P):** the restart in §26.

## 28. Two fixes in one branch: the restart warning on a partial read, and Waiting on you per tool use (boards 54b191ec and 9fb32c4d, P2; merged as main bb64ee0, 2026-11-21)

**Staged, not committed, on `jos/warn-wait-1121` (worktree `~/Projects/.worktrees/ccr-warn-wait-1121`,
from main d5d4aaf, no upstream).** Ultron reviewed it on 11-21: GO once his M1 was in; his
M1, M2 and L2 are in; L1 and L3 are a P3 follow-up (below). README "Restart Jarvis from the
page" (bullet "Agent runs") and "A session waiting on you" (the paragraph "Which tool use
ends a permission wait", the hook entry and the apply script) are the reference.

- **54b191ec, the restart warning (Ultron's M1 on §24).** `runsAtRisk` counted the panel as
  known whenever its status was ok, so a pass that missed the lead's transcript (his
  subagents then carry no session name and drop out) or a run's `.meta.json` gave
  `known: true, runs: []` and the warning passed quietly. Now `known` is false when the
  pass has any `unreadablePaths` or `unavailableRoots` (or lacks either list), and when any
  live subagent run is in no named session (new `liveAgents.unplaced`, counted over every
  live run, not only the 20 sent; a panel without the count is not known either). Not
  known means the sheet asks for the `unseen` confirm, one extra tap.
  - *Ultron's M1 on the first draft:* that draft asked "health up and no lead-named
    session read" (`leadSeen`), but the week's read nearly always holds an older Jarvis
    session, so it was true when it mattered. The real gap is the current lead session
    before its first name line: its runs land in no session. `unplaced` catches that
    whatever health says; `leadSeen` and the health argument are gone.
  - *Cost:* a live subagent of any unnamed session (a terminal started without `-n`) also
    makes a restart ask for `unseen`. Both lists were empty on the live panel on 11-21 during
    this run (read-only GET); a file with an oversized line stays in `unreadablePaths` for
    its week, and every restart asks for `unseen` until it ages out.
- **9fb32c4d, Waiting on you.** The 11-12 wait (opened 15:37:37.017) was cleared at .296 by
  a background general-purpose subagent of the lead's session, whose Bash ended then
  (checked in its transcript, names and times only); the lead's own Bash waited
  15:37:18 to 15:54:12. Subagents post hooks under their session's id, with `agent_id`.
  No hook that sees a prompt carries a `tool_use_id` (2.1.330's schema: `Notification` has
  the session only; `PermissionRequest` the tool, input and `agent_id`), so the match is by
  thread and tool, with the run's start time (`at - duration_ms`). The rules are in the
  header of `server/lib/needs-you.mjs` and the README.
  - **Choices to defend:** `PermissionRequest` notes an ask and opens no wait (the
    Notification still does, a few seconds later, so quick answers never flash on the
    page); a same-tool call that started before the ask is not its answer; a same-thread
    call that started 10 s after an ask ends it (a denied prompt writes no PostToolUse);
    `Stop`/`UserPromptSubmit` no longer end a subagent's ask (Jarvis's turns end while his
    agents wait on a prompt), so `SubagentStop` is hooked to end those; an idle or question
    wait ignores subagent tool calls; with no ask known (the old entries, or a restart
    between ask and Notification) everything clears as before; agent ids are kept only as a
    16-hex hash and never logged; a subagent's event is checked for order but never moves
    the session's newest time (else its newer posts would make the lead's Notification
    stale); an ask is never stale; a stale post that answers the last ask still ends the
    wait (times are compared on the ask).
  - *Ultron's L2:* an odd `agent_id`, `tool_name` or `duration_ms` is read as absent, never
    a 400 (a lost post would lose its clear); tool names may run to 200 characters for long
    MCP names, and any non-empty agent id is hashed.
  - **Limits:** two calls of one tool in one thread at once, one asked and one not, where
    the unasked one started after the ask: it clears the wait (the old bug, narrowed to that
    case). A denied prompt whose thread neither calls another tool 10 s later nor ends keeps
    the wait until the 30-minute lapse. In the restart window (asks forgotten), any call
    clears, as before.
- **The hook change, Ultron's M2.** A hand paste of README's `PermissionRequest` key would
  replace the live synchronous Bash exact-command entry, so README now shows that list
  merged (the Bash entry first, as its own section gives it; a test keeps the two equal),
  and `deploy/add-needs-you-matching.py` makes the change: a dry run by default (prints the
  change to `hooks` only, never the rest of the file, which can hold an `env` token), then
  `--apply` (a 0600 backup first, a temp file renamed over, read back). It swaps the filter
  in the five needs-you commands and appends the three entries; it refuses, changing
  nothing, unless it finds exactly the five 2026-11-12 commands and exactly one
  synchronous Bash exact-command entry, and unless the result only appends (which keeps
  that entry unchanged in its place); a second run refuses. It writes two-space JSON, as
  Claude Code does, and says so when the old layout was another. Tested only on fixture
  copies (`add-needs-you-matching.test.mjs`); never run on the real file. The swap
  script's test and this one share the frozen 11-12 entries
  (`server/test/helpers/needs-you-hooks-1112.mjs`).
- **Checked (2026-11-21, after the review fixes):** server 1,768 tests in local time and
  `TZ=Asia/Tokyo` (under umask 022), web 378 in both. 58 mutants over the three modules and
  the script: 56 caught, 2 equivalent (PermissionRequest in `OPENING_EVENTS`, unreachable
  behind the ask check; and a separate "Bash entry unchanged" check that the append-only
  check already implied, which I folded into it, naming the Bash entry in its refusal);
  two no-op baselines survived, as they must. oxlint clean on the changed files (one older
  warning in the recover test). The README filter was run through `/usr/bin/jq` on a
  2.1.330-shaped subagent PostToolUse: thread, tool and run time through; input, response
  and id not. **Not verified:** real hook posts from Claude Code (they need the settings
  change), that `PermissionRequest` hooks fire for every prompt a `permission_prompt`
  Notification follows (if one doesn't, that wait clears as before), that `duration_ms`
  excludes the prompt time as the schema says (Ultron's L3), and the script on the real
  settings file.
- **Follow-up (P3, Ultron's L1 and L3):** an ask left over (say, a classifier-approved
  call whose `PermissionRequest` fired and whose answer didn't match) can hold a later
  wait open past its own answer until the 10-second rule or `Stop` clears it, which could
  push a false "waiting" at 5 minutes; and `duration_ms` is read on the schema's word.
- **Go-live (Jeff, after C&P):** a Control Room restart (server code only; no web build),
  with no agent runs going. Then, in a terminal, the hook script: a dry run, read its diff,
  then `--apply`:
  `cd ~/Projects && /usr/bin/python3 -I claude-control-room/deploy/add-needs-you-matching.py`
  `cd ~/Projects && /usr/bin/python3 -I claude-control-room/deploy/add-needs-you-matching.py --apply`
  The new server clears as before on the old entries; on the old server the new entries
  would open a wait on `PermissionRequest` a few seconds early and get 400s for
  `PostToolUseFailure` and `SubagentStop` (posts lost, no harm). Restart first.

## 29. The idle wake-up's weekly gate is the percent now, under 90% (Jeff's decision 2026-11-21; staged on `jos/flat-week`)

**Jeff, 2026-11-21:** "Yes just freaking do it but can the weekly at 90". The day-ahead
gate held the wake-up at 72% weekly that day, and he had seen runs not going three days
running. So the only weekly gate is now: every weekly limit's percent now under 90%
(`IDLE.weekPct`). The session gate (under 75%) is unchanged. README "The idle wake-up"
is the reference.

- **Gone:** `weekPace`, `weekBar`, `weekAhead`, `daysToReset` (`lib/proactive.mjs`),
  `IDLE.aheadMs` and `IDLE.reservePerDay` (`lib/proactive-text.mjs`), the wake-up's
  `ahead` field, and the six-hour `pace.short` with `SHORT_LOOKBACK_MS`,
  `SHORT_MAX_GAP_MS` and `recentBaseline`'s `maxGapMs` (`lib/pace.mjs`,
  `lib/usage-panel.mjs`), which nothing else read. Their tests went with them. The
  24 h projection stays: the dashboard, the mod, the alerts and the proactive check's
  `week` rule read it.
- **Words:** the event now ends `Session at 12%; weekly limits at most 40%.` (no "a day
  from now"); the held line reads `proactive: the idle wake-up is held (week-high): week
  (all models) at 91%, its bar 90%` (the highest weekly limit). The cleared line and the
  rest of the held-line rules (two passes, flips) are unchanged.
- **Checked (2026-11-21):** server 1,758 tests, web 378 (the markdown timing test failed
  once while the server suite ran beside it, then passed alone). Five mutants on the new
  gate and its words, all caught. The replay of the 11-20/21 night through the real panel
  now opens at 03:05Z, the first pass after the 5-minute settle, never held. **Not
  verified:** the live service (it needs the restart below).
- **Go-live (Jeff, after C&P):** a Control Room restart (server code only; no web build),
  with no agent runs going.
