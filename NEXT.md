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
  `claude agents --json` poll is gone (the classic page's and the mod's Projects list
  projects with no running state, and say "N total"), and `claude auth status` runs
  daily. `/usage` stays every 5 minutes: an hourly schedule was built and Jeff rejected
  it the same day ("the usage bars can't be updating that infrequently with a 5 hr
  window"); its code is not in the change. README, "How often the server starts
  `claude`". This closes the P3 "agents poll reads the Keychain every 30 s" (found
  2026-10-21 by sampling the live service's children starting `security`). Checks after
  the restart: `/api/dashboard` has no `agents` key; `usage`, `plan` and
  `accountCredits` read ok; ten minutes of sampling the service's children shows two
  `claude -p /usage` and no `claude agents`. Needs `npm run build` in `web/` for the
  classic page (a live deploy, so after the C&P).

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
- Phase 5: the flip (live 2026-11-10, below).
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
  look. **Next, a week after it goes live:** delete `classic.html`, its components and
  CSS (and the `classic` Vite entry), and rewrite README and this file for the new page.

## 10. The Jarvis OS home screen (designed 2026-11-10; Phase 1a built, staged; Phase 2 Feed staged 11-11)

Jeff's pick of 2026-11-10: the Control Room becomes the one home screen (what's running,
what's waiting on you, today's routines, usage, approvals), built on the Orbit page. The
design is `docs/design/2026-11-10-jarvis-os-home.md`; Jeff answered its decisions on 11-10
(the doc's §9: all yes, approvals "both" buttons and Discord DMs, the product's name "Jarvis
OS" if it comes off, and a new Phase 2 direction: messaging with Jarvis inside Jarvis OS,
replacing Discord, pending Shuri's research). Step 0 was the Phase 5 flip (§9); its second
half (the classic page's deletion, about 11-17) is still open.

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
  needs-you wait for a permission prompt is cleared by any `PostToolUse` from the same
  session, a helper's included (11-12: opened 15:37:37.017, cleared 15:37:37.296), so
  "Waiting on you" and its 5-minute alert never showed the 17-minute wait.
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

10. The scratch test, design §9.2 A1-H with A1-F in the same sitting (Jeff, or Jarvis's
    hands at a terminal; never Jarvis's session): it must show the hook's report landing
    before the relayed request, in an auto-mode fallback prompt too, and the two folds
    agreeing. Record the CLI version and each result here. A fail leaves Bash Deny-only
    and goes back to Pepper.
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
