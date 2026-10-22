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

- **P3, found 2026-10-21: the `claude agents --json` poll reads the Keychain every 30 s.**
  Sampling the process table while the live service ran it caught its runs starting
  `security` (the Keychain tool), which fits the CLI loading its sign-in on every run.
  Whether a run also makes a network call couldn't be shown either way: each one lasts
  about 0.1 s. The poll feeds only the classic page's Projects column, so it can go with
  the classic page after Phase 5, or be replaced by `ps` sooner. The health strip doesn't
  use it (§9).

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
- **Plan tier** comes from `claude auth status --json`'s `subscriptionType`, on an
  hourly timer. It's real but coarse, and has been observed to lag an actual plan
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
2. `claude agents --json` output shape
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
`/usage` text, `claude agents --json`, `claude auth status --json`, the
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
- Phase 5: the flip.
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
- **The hardening before Phase 5 is built and staged (2026-10-21), and Ultron's vet is in:
  OK to commit and restart, with no critical, high or medium finding; his three lows
  are folded into the same staged change. It waits on Jeff's C&P.** Ultron's leftovers
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
