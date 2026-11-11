# The Jarvis OS home screen

A design, not a build. Written 2026-11-10 by Pepper for Jarvis and Jeff, from Jeff's words
that day: "I would like to def put fable on the Jarvis os. Let's get started on the control
panel", and his pick of Jarvis's pitch: **one home screen**. The Control Room becomes the
shell: what's running now, what's waiting on you, today's routines, usage, and approvals as
buttons. One place to look, instead of Discord plus the board plus DMs.

Everything here builds on the Orbit page (Phases 0 to 4 live since 2026-10-21, hardened in
`bbd31de`, and at `/` since the 11-10 flip), never on the classic page. Phone first: Jeff reads from
an iPad and an iPhone.

## 1. In five lines

1. **Step 0, the flip (Orbit Phase 5), is done.** Jeff noticed on 11-10 that the root URL
   still served the classic page and said "Flip now"; it went live that evening
   (`f030839`, by web build). Everything below assumes the home screen lives at `/`, and
   now it does. Left: Jeff's Safari look, and the classic page's deletion about 11-17.
2. **Phase 1, the home screen, in days, not weeks.** Almost every number it shows is already
   in `/api/dashboard`. The work is one new strip ("Now"), one widened panel ("Needs you":
   board asks, repos to push, and alerts you can acknowledge), one new list ("Today's
   routines"), a home-screen icon, and the phone layout. One new write: acknowledgements.
3. **The acknowledge mechanism** is the one small server change Phase 1 needs, and it fixes
   today's bug (a known missed Friday run stays red for six days). It can ship ahead as its
   own commit. Section 6 is the full design; section 6.6 says whether to rush it (no).
4. **Approvals as buttons are Phase 3, after Ultron,** and only if Jeff wants them on the
   page at all. Phase 1 shows that Jarvis is waiting on a permission answer; it does not
   answer for him. Discord DM approvals keep working at every phase.
5. **Nothing new faces the internet.** The server keeps binding `127.0.0.1`; the tailnet
   reaches it through Tailscale Serve; the board stays Jarvis-only; the server starts no
   new `claude` processes.

## 2. What exists today (reuse before building)

What `/api/dashboard` carried on 2026-11-10 (one read-only GET), and what the Orbit page
already does with it:

| Already there | Where it comes from | Shown today as |
|---|---|---|
| Board asks, due dates, owners | `GET /api/todos` (`ask`, `due`, `owner`) | Waiting on you: Due soon, Decide or do |
| Repos with something to push | `toPush` (git-read every 5 min) | Waiting on you: To push |
| Alerts (a failed job, a limit, credits) | `alerts` (`server/lib/alerts.mjs`) | A red strip under the header; pushes to ntfy and `#pepper` |
| Jobs' verdicts and reasons | `health.jobs` (job-status every minute) and `crons[]` overlaid with the same verdicts | The Jobs chip and its details |
| Jarvis up or down, this server, Tunnel, Review page, the Pi | `health.services` | The service chips |
| Who ran what, when, with how many tokens | `sessions.agentWork.runs` (7 days) | Agent work map, Today agent by agent, Latest runs |
| What was due today and whether it ran | `crons[].dueAt`, `crons[].lastRunAt`, `config.jobs` names | The Scheduled lane's filled and hollow marks |
| The next run of each job, resets, "You" events | `crons[].nextRunAt`, `usage.limits[].resetsAt`, asks with a `time` | Next 24 hours |
| Usage against the three limits, the plan, credits | `usage`, `plan`, `accountCredits` | Three rings and chips |
| Burn and the week's heat map | `sessions.hourly` | Burn, This week |
| The board itself | `GET /api/todos` | The Board tab |

What the page has no source for today, and what the home screen wants:

| Wanted | Source today | Gap |
|---|---|---|
| "Jarvis is waiting for a permission answer" | None. The prompt goes to a Discord DM; the dashboard can't read Discord | A Claude Code hook that posts to this server (section 5.2) |
| Acknowledging a known miss | None | The ack store (section 6) |
| What the agents posted to their feeds, the morning brief's text | None locally; `discord-post` sends and forgets | A local mirror written by `discord-post` (Phase 2, Jarvis's tool) |
| Approving or denying from the page | None | A `PermissionRequest` hook that waits on a decision (Phase 3, Ultron first) |
| Running a job from the page | None, and `launchctl` is Vision's protected scope | Not in this plan; "Ask Jarvis" instead |

## 3. Step 0: the flip (Orbit Phase 5), done 2026-11-10

The plan (`docs/superpowers/plans/2026-10-20-orbit-redesign.md`, Phase 5) said: when Jeff
says so, the new page becomes `index.html` and the old one `classic.html`; a week later the
old page goes. On 11-10 Jeff noticed it had never happened and said "Flip now". It went
live that evening (`f030839`; NEXT.md §9 has the checks that ran). Recorded here because
the home screen is the root URL or it isn't a home screen, and because the second half is
still to do.

**What changed.** In `web/`: `orbit.html` became `index.html` (the Orbit entry), the old
`index.html` became `classic.html` ("Control Room (classic)"), and `vite.config.js`'s two
inputs followed. Nothing in `server/` moved: `server/lib/static.mjs` serves `index.html`
at `/` and falls back to it for any path that isn't a file, so a bookmark or home-screen
icon pointing at `/orbit.html` (no longer a file) gets the Orbit shell too, hash route and
all (`/orbit.html#board/<id>` still opens that item). `static.test.mjs` covers the
fallback. The live root serves the Orbit bundle and `/classic.html` the old one (checked
by GET, 11-10 21:50).

**What didn't change.** The Tailscale Serve address and command (`tailscale serve --bg
--http=80 8322` forwards the whole port, not a page), so nothing for Vision. The server
and its launchd job: static files are read from `web/dist` on every request, so `npm run
build` was the deploy and no restart was needed. The API, the board, the mod (`mod/` talks
to `/api/`, never to a page).

**Rollback, if Jeff's Safari look finds something.** `git revert f030839`, then `npm run
build` in `web/`: seconds, no restart. Or point him at `/classic.html` meanwhile.

**Left to do, about 11-17** (the plan's second half, S, half a day): delete
`classic.html`, `web/src/App.jsx`, `web/src/main.jsx`, the `classic` Vite entry and the
classic components under `web/src/components/` that nothing else imports (check each:
`ErrorBoundary` and the format helpers are shared), rewrite README's "What it shows" for
the one page, and fold NEXT.md §8's layout notes into history. Gate: Jeff's Safari look
on the iPhone and iPad (Playwright has no WebKit here).

## 4. What Jeff sees

### 4.1 Phone (390 px), the Overview tab

```
┌──────────────────────────────────────┐
│ Jarvis · Mon 10 Nov          Updated │  navy band (as today)
│ [Overview]  [Board · 75]        12 s │
│ ● Jobs all OK · 1 ack  ● Jarvis up   │  health chips (as today)
│ ● Control Room  ● Tunnel  ● Pi       │
│ ▶ NOW  Jarvis · Fable · up 3 d       │  NEW: the Now chip (section 5.1)
│   2 working: Pepper 4 m, Vision 18 m │
├──────────────────────────────────────┤
│ NEEDS YOU · 6                        │  widened Waiting on you (5.3)
│ [Due soon 2] [Decide or do 3]        │
│ [To push 1] [Alerts 0 · 1 acked]     │
│ ┌──────────────────────────────────┐ │
│ │ ◆ TODAY  Example board item      │ │  cards as today
│ │   Vision · P1 · Decide           │ │
│ ├──────────────────────────────────┤ │
│ │ ⇡ pinas-config · 2 staged · C&P  │ │
│ ├──────────────────────────────────┤ │
│ │ ⚑ Jarvis is waiting on an answer │ │  NEW: from the hook (5.2);
│ │   permission prompt · 3 m        │ │  absent until Jeff adds it
│ │   Answer in Discord ›            │ │
│ └──────────────────────────────────┘ │
│ Show all ›                           │
├──────────────────────────────────────┤
│ USAGE                     resets 2h │  the three rings, as today
│   ◯ 4%     ◯ 2%     ◯ 1%           │
│  session   week    Fable           │
│ [Max] [Cloud credits $…] [renews…]   │
├──────────────────────────────────────┤
│ TODAY'S ROUTINES                     │  NEW list (5.4), from data
│ ✓ 07:30 Morning brief     ok        │  the Scheduled lane already has
│ ✓ 09:00 Scout             ok        │
│ ○ 16:45 Fantasy alert     Fri only  │
│ · next: Sun 04:30 Memory backup     │
├──────────────────────────────────────┤
│ ▸ More: agents, latest runs, next 24 │  the rest of today's Overview,
│   hours, burn, this week             │  folded on phones (5.5)
└──────────────────────────────────────┘
```

Order on a phone: Needs you, Usage, Today's routines, then the rest. This keeps the order
Jeff approved on 10-20 (Waiting on you first, usage second) and his 10-19 rule for phones
(usage in the first two blocks). The Now chip sits in the band so "what's running" is on
the first screen without a panel of its own.

### 4.2 iPad (820 px and up), the Overview tab

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│ Jarvis · Mon 10 Nov       [Overview]  [Board · 75]                    Updated 12 s  │
│ ● Jobs all OK · 1 ack  ● Jarvis up  ● Control Room  ● Tunnel  ● Review  ● Pi        │
│ ▶ NOW  Jarvis · Fable · up 3 d · 2 working: Pepper 4 m, Vision 18 m · next 16:45    │
├──────────────────────────────────────────┬─────────────────────────────────────────┤
│ NEEDS YOU · 6                            │ USAGE                        resets 2 h  │
│ [Due soon 2] [Decide or do 3]            │     ◯ 4%        ◯ 2%        ◯ 1%        │
│ [To push 1]  [Alerts 0 · 1 acked]        │    session      week        Fable        │
│ ◆ TODAY Example board item     Vision P1 │ [Max] [Cloud credits] [renews in 12 d]   │
│ ⇡ pinas-config · 2 staged · C&P          ├─────────────────────────────────────────┤
│ ⚑ Jarvis waiting on an answer · 3 m      │ TODAY'S ROUTINES                         │
│ ◇ Another example item                   │ ✓ 07:30 Morning brief   ✓ 09:00 Scout    │
│ …                              Show all › │ ○ 16:45 Fantasy alert (Fri) · acked      │
│                                          │ · next Sun 04:30 Memory backup           │
├──────────────────────────────────────────┴─────────────────────────────────────────┤
│ AGENT WORK MAP          │ TODAY, AGENT BY AGENT                  (as today)         │
│                         │ Jarvis ──●───●──────●───────│now                          │
│      ◯ john   ◯ don     │ Pepper ───────────●─────────│                             │
│   ◯ vision  ◉ JARVIS    │ Vision ──────●──────────────│                             │
│      ◯ pepper ◯ shuri   │ Scheduled ●───●─────○───────│                             │
├─────────────────────────┴──────────────────────────────────────────────────────────┤
│ LATEST RUNS · NEXT 24 HOURS · BURN · THIS WEEK                     (as today)       │
└────────────────────────────────────────────────────────────────────────────────────┘
```

The Board tab is unchanged in Phase 1. The mock numbers above are placeholders, not a
snapshot (the repo is public; never copy real board text into it).

## 5. The panels

### 5.1 The Now chip (new, Phase 1)

One line in the band, after the health chips, built from data the page already has:

- **Jarvis** from `health.services[kind=session]` (up or down, since when) and the lead's
  latest request in `sessions.agentWork` for the model family: "Jarvis · Fable · up 3 d".
  Showing the model is the "put Fable on the Jarvis OS" tie-in: when Jeff switches
  Jarvis's model, the chip says so from the transcript, not from a setting. Needs one new
  field per run, `model` (the family, as Burn already classifies it), from the same parse.
- **Working now** from `agentWork.runs`: an agent whose last request was within 5 minutes
  is working, within an hour is recent (the map's existing `ACTIVE_MS`). Counted and
  named: "2 working: Pepper 4 m, Vision 18 m".
- **Next** from `crons[].nextRunAt` with `config.jobs` names: "next 16:45 Fantasy alert".

Tapping it opens details below the band, like a health chip: each working agent with its
task line (the brief's `description`, already in `runs[].task`) and tokens.

### 5.2 "Jarvis is waiting on you" (Phase 1b, needs one line from Jeff)

Today a permission prompt from the Jarvis session reaches Jeff only as a Discord DM with
Allow and Deny buttons. The dashboard can't see Discord. It can see a hook: Claude Code's
`Notification` hook fires with the `permission_prompt` matcher when a session is waiting
for permission, and the installed CLI (2.1.321) also names a `PermissionRequest` event (the
strings are in the binary; the exact payload is to be confirmed against the docs for that
version before building).

Design: a hook command, `curl -s -X POST http://127.0.0.1:8322/api/ingest/needs-you -H
'Content-Type: application/json' -d @-`, posts the hook's JSON (`session_id`, `cwd`,
`transcript_path`, the event name). A `PostToolUse` or `Stop` hook posts the same shape as
a clear. The server:

- validates it like the other ingests (`server/lib/validate-ingest.mjs`): an allowlist of
  fields, 256 KB cap, JSON only, same-origin or no Origin;
- matches `transcript_path` to a session the sessions collector already knows, so the
  card can say *which* session waits (the lead, or an agent's run) and the page never
  shows a path;
- keeps at most 20 open waits, each dropped on a clear or after 30 minutes;
- sends them as `needsYou` in `/api/dashboard`: `[{ who, kind, since }]`, nothing else.

The card reads "Jarvis is waiting on an answer · permission prompt · 3 m · Answer in
Discord ›" (a link to Discord's app URL, which the CSP allows as a navigation, not a
load). It counts in Needs you. Hooks are global in `~/.claude/settings.json`, so every
Claude Code session on the mini posts, which is why the server matches the session rather
than trusting a name. Only Jeff can add the hook entry (auto mode blocks writes to that
file; `control-room-dev-gotchas` memory), so Pepper stages a draft and hands him the `cp`.
Until he does, the card is absent and nothing else changes.

Pushes: a wait older than 5 minutes becomes an alert, kind `needs-you`, counted, never
quoted ("1 session is waiting on you"), through the existing allowlist in
`server/lib/push-alerts.mjs`. It may be the most useful push the dashboard sends: today a
missed DM means Jarvis sits idle until Jeff opens Discord.

### 5.3 Needs you (widened Waiting on you, Phase 1)

The panel keeps its three tiles and adds a fourth, **Alerts**, so everything that needs a
tap from Jeff is in one count: board asks, repos to push, sessions waiting, and alerts.
An alert card carries the alert's text, when it started (the notifier knows, from
`server/data/notified.json`), and the one action the page can take: **Acknowledge**
(section 6). A limit alert has no ack; its card says what to do instead ("resets in 2 h").
The strip under the header stays for the first poll after a new alert, then the card is
the place. Acked alerts show in the tile's label ("Alerts 0 · 1 acked"), not as cards.

### 5.4 Today's routines (new list, Phase 1)

A phone-readable list of what the Scheduled lane already draws as marks: for each calendar
job due today (`crons[].dueAt` within today, local), its time, its name from
`config.jobs`, and its verdict: ran (its log was written after the due time, as the lane's
filled mark), due (not yet), missed (due, no run, and job-status says failed), or
acknowledged. Then "next: <weekday> <time> <name>" from `nextRunAt`. Jobs that run every
few minutes (`StartInterval`) stay out, as on Next 24 hours. On an iPad it sits under
Usage; on a phone it is the third block. Pure page work; the data is in the payload today
(`todayView()` in `web/src/lib/orbit/agents.js` computes the marks).

### 5.5 The rest, folded on phones (Phase 1)

The agent work map, Today agent by agent, Latest runs, Next 24 hours, Burn and This week
stay as they are, on an iPad in today's order. On a phone they sit under one "More"
disclosure that remembers its state per viewer (`localStorage`, wrapped in try/catch as
the board's filters are). Jeff's phone today starts the agent map about one screen down;
with Needs you growing, folding keeps the first two screens to what he came for.

### 5.6 Home-screen icon (Phase 1, tiny)

A `manifest.webmanifest` and an `apple-touch-icon` in `web/public`, `display:
standalone`, name "Control Room", theme `#0D2045`. The CSP's `default-src 'self'` covers
the manifest. In standalone mode Safari shows no Back button; the page's tabs and
"Open on the board" links already work without one, and the hash route survives a relaunch.
`server/lib/static.mjs` has no MIME type for `.webmanifest` (it would go out as
`application/octet-stream`), so one line there is the only server change in the layout
work.

### 5.7 Phase 2: the Feed tab and the brief

Jeff reads eight Discord channels to know what the agents said. `discord-post` (Jarvis's
tool) could also append each post it sends to a local file, `~/.local/state/jarvis/feed/
<agent>.jsonl` (`at`, `agent`, `title`, `text`), already past its secret check. A new
read-only collector reads the last 50 lines per file every minute (a few KB; the files
are the service user's own and the program check's folder rules apply to the folder), and
a **Feed** tab shows them newest first with the agent's avatar, filterable by agent, with
the morning brief and the Monday digest pinned at the top for their day. This replaces
reading the feeds, not `#jarvis`: the conversation stays in Discord. Jarvis's change is S;
the tab is M. It needs Jarvis to agree the file shape and Ultron to glance at a new read
(a path from config, same rules as the Pi watch's state file).

### 5.8 Phase 3: approvals as buttons (Ultron first)

The mechanism that could work, to be confirmed against the hook docs for the installed
CLI: a `PermissionRequest` hook posts the request (tool name, a short description the hook
payload carries, a nonce the server mints) to `/api/ingest/approval`, then polls
`GET /api/approvals/<nonce>` for up to its timeout; the page shows the request with Allow
and Deny; a tap `POST`s the decision; the hook returns it to Claude Code. On timeout the
hook returns no decision, and Claude Code asks as it does today, so **the Discord DM path
keeps working unchanged and is the fallback**. Rules the design must keep, for Ultron's
review: decisions are single-use and expire with the nonce; Deny is the default; the page
shows the tool name and the hook's own one-line description, never a command line or a
path; the endpoint stays loopback and tailnet only; every decision is logged with the time
and the viewer's address; and a decision can never widen a permission beyond the one
prompt (no "always allow"). The question for Jeff is whether a tap on any tailnet device
should carry the same trust as a tap in his Discord DM. Effort M to L, most of it the hook
contract test and the review. Running a job from the page (`launchctl kickstart`) is
Vision's protected scope and is not in this plan.

### 5.9 Room left for later (not designed here)

- **Events triggering agents:** `POST /api/ingest/event` as a sixth ingest kind with the
  same guards, stored like `needsYou`, so a Phase 1 server already has the slot. Who
  consumes events (Jarvis, a routine) is Jarvis's design.
- **Agent manifests ("apps"):** config's `roster.agents` already names and orders the
  agents; a manifest adds `about`, `jobs` and `repos` per agent. The Phase 1 Now chip
  and the Feed tab key on the roster key, so a manifest slots in without renaming.
- **Shared memory:** the agents' memory folders are files Jarvis already backs up; a
  read-only "what each agent knows" view is a collector like the Feed's, later.
- **Ambient input:** out of scope for this server; whatever listens posts an event.

## 6. Acknowledging a known miss

*Built 2026-11-10 as Phase 1a (NEXT.md §10 has the state and the go-live order). Two
details settled in the build: a cron's `since` matches within 5 minutes, because job-status
rounds a log's age to 0.01 h; and `health.jobs.list[]` rows are matched by the name the chip
shows, since the health panel carries no labels. The README's "Acknowledging a known miss"
is the reference from here on.*

### 6.1 The bug

On 2026-11-10 the dashboard shows the Friday fantasy alert (a weekly launchd job, Fridays
16:45) as failed: "Overdue · log 270 h old" on the crons panel, "log last written 269.7 h
ago, more than the 192 h expected" in the Jobs details, one line in the alert strip, and
one push. Its last run was Fri 10-30; the 11-06 run was really missed (the mini restarted
before Jeff's FileVault login; diagnosed in fantasy-football `90853c6`) and Jeff considers
it cleared. job-status (Jarvis's `jarvis/status.py`) allows a weekly job 192 hours (eight
days) without a log write, so one missed weekly run is red from day 8 until the next run
on day 14: here, from Sat 11-07 to Fri 11-13 16:45. The verdict is right. What's missing
is a way to say "I know".

### 6.2 What an ack is

An ack silences **one instance of one condition** for a bounded time. It never changes a
verdict (`ok` stays `false`, `state` stays `failed`: a real value even if unwelcome, never
an invented one), and it never carries over to a new failure.

```json
{ "key": "cron:launchd:<label>", "since": 1793559600000, "by": "jeff",
  "note": "mini restarted before login; next run Fri", "at": 1794380000000,
  "until": 1794692700000 }
```

- `key`: the alert's own key (`buildAlerts` already keys every alert on its subject, so
  nothing new to invent). Ack-able kinds: `cron`, `service`, and the two counted kinds
  that come later (`needs-you`, `credits:stale`). Not `limit`, `projection`, or a
  credit expiry: those move on their own and an ack would only hide money or a wall.
- `since`: the condition's instance, for a cron its `lastRunAt` at the time of the ack. If
  the job runs again and still fails, `lastRunAt` changes, the ack no longer matches, and
  the alert is red again: a new miss is never covered by an old ack. For a service, its
  `downSince`.
- `until`: when the ack lapses. Default for a cron: its `nextRunAt` plus 2 hours, so if the
  next run doesn't happen either, the alert comes back on its own. A job with no next run
  (an interval job): 24 hours. The page also offers "7 days". Hard cap 14 days.
- `by`: `jeff` from the page, or an agent key from a script (Jarvis, when Jeff tells him in
  Discord). A word of at most 40 characters, letters, digits and hyphens.
- `note`: optional, at most 200 characters, one line, with the same control- and
  direction-character filter as a board `title`. Shown in the details and in the board's
  tone of voice: what happened, not blame.

### 6.3 Who can ack, and how it's stored

Anyone who can reach the page can ack: that is the tailnet, which is Jeff's devices.
This is not a board write, so the Jarvis-only rule doesn't apply, and it shouldn't: the
whole point is Jeff's own tap. Jarvis can also ack from a script (`curl -X POST`) when Jeff
tells him to in Discord, with `by: "jarvis"`.

Stored in `server/data/acks.json` (the folder is gitignored and already holds
`notified.json`), written whole on each change, at most 50 entries, expired ones pruned on
each write and each build. Not in the board, not in `config.json`.

The API, with the board's guards (`guardWrite`: JSON only, same origin or no Origin) and a
4 KB body cap:

- `POST /api/acks` with `{ key, note?, until? }`: the key must name an alert raised in the
  **current** payload, so nobody can pre-ack a future failure; `since` is taken from that
  alert's source, not from the caller. Answers the list.
- `DELETE /api/acks/<key>`: un-ack. Answers the list.
- `GET /api/acks`: the list. Also carried in `/api/dashboard` as `acks`.

### 6.4 How it shows

- `/api/dashboard`: `alerts` leaves out an alert whose active ack matches (key and
  `since`); those alerts go in `acked` instead, each with its ack. `crons[]` entries and
  `health.jobs.list` entries gain `ack: { by, at, until, note }` when covered; their
  `ok`, `state` and `last` don't change.
- The health strip's Jobs chip: "all OK · 1 ack" in grey when nothing else fails
  (`healthChips()` in `web/src/lib/orbit/health.js` gains a tone for it). Its details show
  the job's row in grey with "acknowledged by Jeff until Fri 18:45 · mini restarted before
  login" and an **Un-ack** button.
- Needs you, Alerts tile: a red alert card has an **Acknowledge** button; tapping it opens a
  two-field form in the card (a note, and "until next run" or "for 7 days"), then saves.
  The count drops by one.
- The classic page and the mod: `crons[].ack` is new data they ignore, so they keep
  showing the job red until the classic page goes (section 3) and the mod gets a one-line
  "acked" suffix in its summary (its own small change, with a `claude plugin test` run).
- Today's routines (5.4) reads the job as "acknowledged", not "missed".

### 6.5 Pushes and expiry

The notifier (`server/collectors/notifier.mjs`) sees `alerts` without the acked one. Its
rule "forget a key when the alert clears while its source was readable" then forgets the
key. If the ack lapses with the condition still live, the alert comes back into `alerts`
and the notifier pushes it again: an expired ack re-notifies, which is what an expiry is
for. An ack of a `service` alert works the same, keyed on `downSince`. Nothing is pushed
for an ack itself. A line goes to the service log: `ack: <kind> by <who> until <time>`,
with the key, since the log is local and already holds job verdicts.

### 6.6 Should it ship ahead?

Yes, as its own small commit, and no, not rushed for this instance.

For: it is the one server piece Phase 1 needs, it is S (a day: store, two routes, the
`buildAlerts` filter, the chip tone, the card button, tests in two time zones, a mutation
pass), and the case recurs: any mini restart before a FileVault login misses whatever was
due, and a weekly job then shows red for six days each time. The next such miss is a
matter of time, and today the only answer is "wait".

Against rushing: the Friday alert clears itself on Fri 11-13 at 16:45 if that run
succeeds, three days away. Shipping needs Jeff's C&P, Ultron's look at a new write
endpoint, one service restart (Vision or Jeff) and the web build, which together fill
most of those three days. Build it now as the first slice; ship it on its own merits,
whichever Friday it lands before.

What it does not do: it doesn't change job-status's 192-hour allowance (Jarvis's code,
and the allowance is right: the job did miss).

## 7. Phases, effort and cost

| Phase | What | Effort | Needs | Restart? |
|---|---|---|---|---|
| 0 | The flip (section 3): done 11-10; the classic page's deletion about 11-17 | S, half a day left | Jeff's Safari look | No (build only) |
| 1a | Acks (section 6) | S, a day | Ultron (light), C&P, restart, build | Yes |
| 1b | Needs you widened, Now chip (+ `model` per run), Today's routines, phone fold, manifest, `needsYou` ingest and the hook draft | M, 3 to 4 days | Ultron (light: one ingest kind), C&P, restart, build; Jeff's `settings.json` line for the hook | Yes |
| 2 | Feed tab and the brief (5.7) | M, 2 to 3 days Pepper + S Jarvis | Jarvis's `discord-post` change, Ultron (new read), restart, build | Yes |
| 3 | Approvals as buttons (5.8) | M to L, a week with the review | Jeff's yes, Ultron's design review before code, hook contract confirmed | Yes |
| later | Events, manifests, shared memory, ambient | not estimated | | |

Phases 1a and 1b can be one commit or two; two keeps the ack reviewable on its own. Every
phase is one restart (Vision's or Jeff's), one live web build, and a round of the standard
checks (server tests in local time and Tokyo, web tests, mutations, headless Chromium at
390 and 1440 on a scratch server, then Jeff's Safari look).

Running cost: zero new `claude` processes (the server stays at about 12 an hour once the
10-30 change is live), no new network calls, and one new read of a few KB a minute in
Phase 2. Token cost of the build itself: the usual Pepper runs, with Jarvis's review
between phases. The Fable 5.2 trial is this design run; the build phases can stay on it
if it reads well.

## 8. What needs Ultron

- **Phase 1a:** `POST /api/acks` and `DELETE /api/acks/<key>`: a new write surface on the
  loopback/tailnet server. Low stakes (it can only hide an alert for a bounded time, and
  only one that exists), the board's guards, a small cap, and the key must match a live
  alert. A light review.
- **Phase 1b:** `/api/ingest/needs-you`: a fifth ingest kind with the existing guards, and
  the hook command line (what it posts, that it never posts the prompt's content, only the
  event, the session's path for matching, and that the server drops the path).
- **Phase 2:** a new read of a path from config (the feed mirror), under the program
  check's folder rules.
- **Phase 3:** the whole approvals design before any code: it grants a permission from a
  tailnet device. Ultron decides whether that trust is acceptable at all, and the rules in
  5.8 are the opening position.

Nothing in Phase 0 touches the server.

## 9. Decisions (answered 2026-11-10)

Jeff answered on Discord on 2026-11-10 ("yes to all BUT 5-both, 9-..."). Each with his answer.

1. **The flip:** yes. The classic page goes about 11-17, after his Safari look.
2. **The ack as its own small commit:** yes. Built 11-10 as Phase 1a (section 6).
3. **Who may ack:** yes. Jeff from the page (any tailnet device) and Jarvis by script when
   Jeff says so; default expiry the next run plus 2 hours, a 7-day option, a 14-day cap.
4. **The hook line in `~/.claude/settings.json`:** yes, in Phase 1b.
5. **Approvals:** **both**. Buttons on the page *and* the Discord DMs kept. Still Phase 3,
   and Ultron reviews the design before any code.
6. **`discord-post` keeps a local copy of each post:** yes.
7. **Phone order:** yes.
8. **Home-screen icon:** yes.
9. **Name:** if it comes off, the product is **"Jarvis OS"** (Jeff: "take some credit and a
   bow"). Nothing is renamed in Phase 1: the repo stays `claude-control-room` and the page's
   title "Control Room" until he says.
10. **New (11-10): messaging with Jarvis moves into Jarvis OS and replaces Discord** ("That
    might be the killer feature"). That is the new direction for Phase 2, pending Shuri's
    feasibility research; it is recorded here, not designed. The Feed tab (5.7) becomes part
    of it or gives way to it, once the research is in.

## 10. Rules this design keeps

- The server binds `127.0.0.1`; Tailscale Serve is the only way in; nothing new faces the
  internet. No Cloudflare route.
- The board is written by Jarvis only (`~/Projects/jarvis/bin/board-write`); the page keeps
  its edit-in-place, `If-Match` and 409/428 as today. Acks and waits are separate stores.
- No test write ever aims at `:8322`; scratch servers only.
- No new `claude -p` run; if one is ever added it passes `--strict-mcp-config
  --permission-mode manual`.
- The repo stays anonymous: no hostname, tailnet, Discord ids or private job labels in
  committed files (this document names the Friday job by what it does, not by its label).
- Every figure shown is real or marked unknown; an ack never rewrites a verdict.
- Changes to `~/.claude/settings.json`, `launchctl`, Tailscale Serve and Jarvis's tools go
  to Jeff, Vision and Jarvis respectively; this plan asks, it doesn't do.
