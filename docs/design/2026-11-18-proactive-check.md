# The proactive check: wake the lead only on a hit

Board item a77b4757, "Proactive check: ping Jeff only on a hit". Written 2026-11-18, before
the build. It is pick 5 of the 11-11 agent-OS survey (a cheap precheck, silent unless
something changed), which the owner said yes to on 11-12. It turns Jarvis OS pillar 7,
anticipation, into a daily habit: the server spots a pattern, and the lead proposes the
next step.

## 1. What it is

A pass inside this server, every 5 minutes, with no model and no network. It reads what the
server already has (the board file, the crons panel, the heal ledger, the usage panel, the
Shortcut keys), finds **hits**, and on a new hit makes one event for the lead's session
through the existing events path. It never writes the board, never pushes to a phone, and
never starts anything. Off unless config says `"proactive": { "enabled": true }`.

## 2. The rules and their thresholds

Every number is a constant in `server/lib/proactive-text.mjs` (`RULES`), not config, like
the limit warnings' steps. The page and `GET /api/proactive` show them.

| Rule | A hit when | Key | Material change (fires again) |
|---|---|---|---|
| `due` | an open item (`idea` or `doing`) whose `due` is before today's local date | `due:<id>` | the due date changes |
| `ask` | an open item whose `ask` (its `what` and `kind`) has stood unchanged for 3 days | `ask:<id>` | the ask's words or kind change |
| `stale` | an open P0 item unchanged for 2 days, or an open P1 item unchanged for 7 | `stale:<id>` | the priority changes |
| `fails` | one launchd job failed on 3 distinct runs in 14 days | `fails:<hash of label>` | the count reaches the next band (3, 6, 12, 24, ...) |
| `heals` | one heal target healed 3 times in 14 days (the heal ledger's `distinctHeals`) | `heals:<target id>` | the same bands |
| `week` | a weekly limit projected over 100% by its reset, once 25% of the week has passed | `week:<label>:<window>` | none: once per window |
| `session` | the session limit at 75% or more | `session:<window>` | none: once per window |
| `expiry` | a working Shortcut key whose idle expiry is 7 days away or less | `key-expiry:<key id>` | the expiry day moves |

How each source is read, and why:

- **The board has no "changed at" or "asked at" field.** The check keeps its own
  fingerprint of each open P0/P1 item (its text, title, lane, tag, priority, owner, due and
  ask) and of each open ask, with the time it first saw that fingerprint. "Unchanged for 7
  days" therefore means "the check has seen it unchanged for 7 days": the clocks start the
  day the check goes live, and the first `stale` and `ask` hits come 2, 3 or 7 days later.
  The 20 history copies span less than a day, so seeding from them would buy little.
- **The board is read with `readFile` and `JSON.parse`, never the board store.** The
  store's read seeds an empty board and sets a damaged file aside, both writes. A file that
  can't be read or parsed makes the board "unreadable" for that pass; on the fourth such
  pass in a row the log says so once, by the error's code (`ENOENT`, `SyntaxError`, `not a
  list`), and again once it can be read. server.mjs names the file once (`TODOS_PATH`), for
  the store and the check alike.
- **A board id is said only in an opaque shape** (`OPAQUE_ID`): a UUID, a 13-digit time and
  a short random part, 8 hex, or a number of at most 9 digits, all lower case. The board
  takes any non-empty id, and a plain-looking one (`Jarvis-system-note.approve-pending-pairing`)
  would otherwise reach the lead verbatim. Any other id is still tracked by its key but said
  as "an item (…; see Heads up)", and the page shows it as "A board item" with no link. All
  241 open items had an opaque id on 2026-11-18.
- **Nothing counted job failures over time,** so the check counts them: a failed run is a
  crons-panel row with `ok: false` and no heal hold ahead (`holdUntil`), one per distinct
  `lastRunAt` (two times within 2 minutes are the same run: job-status's times wobble by up
  to 36 s), or, with no `lastRunAt`, one per change from not failing to failing. A job a
  heal loop is checking is not counted until the hold ends; one it marked quiet reads
  `ok: true`. A job whose alert key `cron:launchd:<label>` is in config's
  `events.excludeKeys` is not counted at all, and its record goes, as the events module
  skips it. The heal ledger's own count (the design's §5.6 "3 in 14 days") is the
  `heals` rule.
- **Usage reuses the limit warnings' parts**: `ruleFor` names the limit, `windowOf` keys the
  window (the reset rounded to 10 minutes, since `/usage` flips the minute), and the pace
  code's `projectedPct` and `elapsed` (already refused under 10% of the window). The 25%
  floor is mine: early in a week a projection swings widely. A told usage key is kept until
  its window ends, so a reading that dips and comes back tells nothing twice.
- **No second push.** A usage hit feeds the event and the page only. The limit warnings
  already push the phone at 80% and 95% of the session and 90% of a week, and already make
  the lead's event at those steps, so a session hit first seen at 80% or more is marked told
  without an event (`silent`).
- **Expiry: only what the server can see.** The Shortcut keys' idle expiry is the one token
  expiry here. The Claude login's hard expiry is not visible to this server: the login watch
  (Jarvis's `bin/login-watch`) watches transcripts for failed requests and keeps no date,
  and the date itself sits in the Keychain credential, which this server must not read. That
  is a question for the owner (§9), and until then the board item for the renewal, with a
  `due` date, is caught by the `due` rule. Credit grants already alert at 7 days (lib/alerts.mjs).

## 3. Keys and state

A hit's key names its subject, never its words. It fires once, until the condition clears
(the key is forgotten) or changes materially (its fingerprint changes). A key leaves the
process only as a 16-hex hash (`keyHash`, the events' own), so a launchd label or a limit
label never reaches the page or the lead.

The state is `server/data/proactive.json` (gitignored with `data/`), written whole through
`lib/sent-store.mjs`: a temp file made 0600 with `wx`, then a rename, and a sweep of
interrupted temp files at start. It holds:

- `board`: per open item it tracks, the fingerprint and since when, and the ask's.
- `jobs`: per job (by label hash), whether it was failing at the last pass, its last run
  time and its failed runs of the last 14 days (at most 64).
- `hits`: per key, the fingerprint, when it was first found, when it was told (or null),
  when it was held for the night (or null), how long a told key is kept, and `silent`.

A file that can't be read is an empty state (every clock starts again: no false hit, only
a later one). Bad entries are dropped one by one on load.

A source that can't be read this pass (the board file, a crons or usage panel that is not
current, a Shortcut keys list that throws) keeps its keys and its last hits for the page:
absence of evidence is not a clear. The page marks each such row "as of <when it was last
read>, not read since" (`current: false`, `readAt`). No keys list at all (the Shortcuts
off) is a reading: their hits clear. A usage hit whose window has ended leaves the view at
once, whether or not a pass has run since.

## 4. Delivery

- **One event a pass at most**, made by `events.proactive(hits)` in `lib/events.mjs`:
  source `proactive`, type `heads-up`, one item per hit. The words come from
  `proactiveText` in `lib/proactive-text.mjs`, built from typed fields only (a board id of
  an opaque shape, a priority, a lane, a whole number, a date, a job or target name from
  config, a limit's fixed name, a key name that is a plain name), each checked again inside
  the events module. A board title, an ask's words, a launchd label or a log line never go
  in. The lead reads the titles from the board.
- **Capped**: at most 5 named per rule ("and N more"), and 1,200 characters in all, cut at a
  rule's boundary with "and more on the page".
- **The events path's limits, with a day cap of its own**: 6 an hour, and 8 heads-up events a
  day that count toward neither the others' 30 nor anyone else's, so heads-ups never push
  out a job failure or an outage; the 60 s coalescing, the kill switch `events-off`, and
  the 2-hour life at delivery. The items carry no alert key, so liveness is not checked and
  the events ledger never holds the check's keys (it would never forget them).
- **Sent means taken.** A hit is marked sent only when `events.proactive` answers `made` or
  `coalescing`. `held` (a cap) and `off` (the kill switch) take nothing and count nothing
  (no held-back or suppressed line, which would count the same hits every 5 minutes), so
  the hits stay unsent and the next pass offers them again; the log says so once a spell
  (`proactive: N heads-ups not sent (held); offered again each pass`). A refused store
  write is the same. "Sent" is handed to the events path, not read by the lead.
- **With the chat off no pass runs.** The server makes the events path and the paired
  devices only with the chat on, so there would be nobody to tell and no page that could
  read the hits; the start line says `proactive: on in config, but no passes run: …`.
- **Quiet hours 22:00 to 07:00 local** (the events' own constants): a hit found then is held.
  At 07:00 (a timer set for the moment, as well as the 5-minute pass), every held hit that is
  still current goes in one event with anything new. A held hit that cleared overnight is
  dropped. The items are marked `immediate`, so the events module never holds them again.
- **The page**: a read-only "Heads up" section on the Overview, after Needs you, shown only
  while there is a hit. Each row is one hit; a board hit shows the item's title from the
  board the page already has and opens it. Read from the new GET, with the device cookie.
- **The GET**: `GET /api/proactive`, read-only, with exactly the Feed's rule (a paired
  device's cookie, and the owner's tailnet login when `chat.login` is set; with the chat
  off, nobody). It is not in `/api/dashboard`, which any tailnet browser reads, because an
  expiry hit names a Shortcut key. The morning brief can read it later only through a
  paired device's rule; a routine has no cookie, so that needs a decision then (§9).

## 5. The switches

- `config.json`: `"proactive": { "enabled": true }`. Absent is `unset` and off; `false` is
  off. Read at start, so a change needs a restart.
- The kill file `~/.local/state/jarvis-os/proactive-off`, beside the other kill files: while
  it exists a pass reads nothing and tells nothing (no restart). The page says so.
- The events' `events-off` holds delivery as it does for every source.

## 6. Go-live, in this order

1. Ultron reads the new surfaces (§7): done 2026-11-18, GO with fixes, all seven in (§8).
2. The owner's C&P, then `cd web && npm run build` (the page needs the new section; with
   the old server the page's GET answers 404 and the section stays hidden).
3. Jarvis adds `"proactive": { "enabled": true }` to `server/config.json`.
4. A restart of the service (the owner's OK; Vision's scope).

**Post-restart checks:** the log has `proactive: on, every 5 min, quiet 22:00-07:00 held to
07:00; events on`; after the first pass, `stat -f %Lp server/data/proactive.json` prints
`600`; from a paired device `GET /api/proactive` answers `status: "on"` with `checkedAt`
under 5 minutes old, and from the mini without a cookie it answers 401; any `due` hit shows
under Heads up; the first event (if any) arrives as `chat_id="jos-events"` with
`source="proactive"` (the channel names it `event="unknown"` until it learns `heads-up`).

**Rollback:** `touch ~/.local/state/jarvis-os/proactive-off` (stops at the next pass, no
restart), or remove the `proactive` block and restart, or revert the commit (no data
migration: `proactive.json` is only read by this code).

## 7. For Ultron

- `lib/proactive.mjs`: the board read (never the store), the job-run counting, the told /
  held / forget rules, the 07:00 timer.
- `lib/proactive-text.mjs` (`checkHit`, `proactiveText`): every field typed, every outside
  string refused unless it is a plain id or a config name.
- `lib/events.mjs` (`proactive`): a new in-process source, no socket name, no alert keys.
- `lib/proactive-routes.mjs`: the Feed's guard, shared through `lib/feed-routes.mjs`.

## 8. Ultron's review (2026-11-18): GO with fixes, all seven in

- **M1** (medium): a board id could carry words into the lead's event. Fixed by `OPAQUE_ID`
  (§2), used by `boardHits` and `checkHit` alike.
- **L1**: "told" meant handed over whatever the answer; now sent only on `made` or
  `coalescing` (§4), and the page says "sent".
- **L2**: heads-ups shared the 30 a day; now their own 8 (§4).
- **L3**: the failure rule ignored `events.excludeKeys`; now it skips those jobs (§2).
- **L4**: the page could show stale rows as current; ended usage windows drop out, rows
  from an unread source are marked, and a keys list that throws is "not current" (§3).
- **L5**: the start line promised a page nobody could read with the chat off; now no pass
  runs then, and the line says so (§4).
- **L6**: the board path was written twice and an unreadable board was silent; one
  constant, and one log line after 3 unreadable passes (§2).

## 9. Open questions for the owner

1. **The Claude login's expiry.** (a) The login watch also reads the credential's
   `refreshTokenExpiresAt` and writes only that date to its state file, which this check
   then reads; (b) Jarvis keeps a board item for the renewal with a `due` date, which this
   check already catches; (c) nothing. My pick: (b) now, since it needs no new code near a
   token; (a) only with Ultron's review of the Keychain read.
2. **The thresholds** in §2 (P0 2 days, P1 7, asks 3, 3 failures or heals in 14 days,
   weekly projection over 100% after 25% of the week, session 75%, expiry 7 days). My pick:
   ship these and adjust after a week of hits.
3. **The morning brief's read**: a routine has no device cookie. Options when that day
   comes: the ingest socket gains a read route, or the check writes a summary file the
   routine reads. Not needed for go-live.
