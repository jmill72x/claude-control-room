# A projection from the recent rate, and a wake-up when the board sits idle

Board items f66a4a7e ("the projections need to be more dynamic") and 5ffd0041 (continuous
burn-down). Written 2026-11-19, before the build. Both build on the proactive check
(`docs/design/2026-11-18-proactive-check.md`) and change nothing in its other rules.

## 1. The projection

**The problem.** A weekly limit's projection was a straight line from the start of the
week: the percent divided by the share of the week gone. On 2026-11-19 at 07:00 that
read 102% (all models) and 154% (one model) while the first had moved two points
overnight and the second had stood still for a day. One heavy day early in the week keeps
a straight line high for the rest of it.

**The rule.** For a weekly limit, `projected = pct + rate × time left`, where `rate` is
what the limit gained since the newest reading at least 24 hours old (`RATE_LOOKBACK_MS`),
from the `/usage` history the server already keeps. Twenty-four hours always holds one
whole day and night, so the rate does not swing with the hour it is read at.

- **Which readings count.** Only this window's: walking back from now, a reading belongs
  while its printed reset is within 30 minutes of the current one (the printed minute
  flaps), or, when it prints no reset (a weekly limit at 0% prints none), while it was
  taken after the window's start. The walk stops at another window's reading and at a
  fall of more than 5 points (`RESET_DROP_PCT`): the limit was reset early (2026-10-19:
  93% to 0% on the same printed reset). The three dips in the history were 1 point each.
- **A rate is never negative.** A dip gives a rate of 0 and a projection equal to the
  percent. So does a quiet day: after one, a limit at 97% projects 97%. A projection
  under 100% therefore never means "room" on its own; the idle rule (§2, rule 2) also
  stops at 90% of the limit itself (Ultron's M1, 2026-11-19).
- **A gap in the readings** (the server was down) leaves the baseline older than 24 hours.
  It is still the newest measured rate, over its true span, and the basis says the span.
- **The fallback** is the straight line, as before: early in the week (no reading of this
  window is 24 hours old yet), after a reset (the same), and when the history does not
  reach back. Under 10% of the window there is still no projection at all.
- **The session limit keeps the straight line.** Its window is 5 hours and nobody asked.
- **The basis travels with the number**: `pace.basis` is `recent` or `window`, and
  `pace.basisMs` the span the rate was measured over. Every place that says the
  projection says the basis ("at the last 24 h rate", or for the straight line "at the
  week's average rate"): the alert line ("… projected to reach 112% by reset at the
  last 24 h rate"), the Heads up row and the lead's event, a new line under each weekly
  figure on the page's Usage panel ("heading for 64% at the last 24 h rate"), and the
  mod's pace line. `pace.state` (ahead, on, under) still compares the percent with an
  even pace; only the projection changed.
- **Who uses it.** `lib/alerts.mjs` (the `projection` alert, over 100%), the proactive
  check's `week` rule (over 100% once 25% of the week is gone) and its new idle rule
  below. The limit warnings (`lib/limit-warnings.mjs`) never used a projection: they fire
  on the percent itself (80%, 95%, 90%), so nothing changes there.

**Why 24 hours.** A backtest over every complete week in the history (12 for all models,
8 for the model-scoped limit; a reading every 30 minutes after 25% of the week): the
24-hour rate was wrongly over 100% on 8% of readings against the straight line's 12%, a
mean error of 5.7 points against 6.1, and in the one week that reached 100% it said so on
every reading (the straight line missed 9%). 48 hours scored between the two. The sample
is small; the constant is one line to change.

## 2. The idle wake-up

**The problem.** The lead wakes only on events. When the last agent run ends and nobody
writes, nothing starts the next one, though the board holds work and the limits have
room.

**The rule** (`idle`, in the proactive check's pass, every 5 minutes): one event for the
lead when all of these hold, each read this pass (a source that can't be read means no
wake-up: "can't tell" never acts):

1. **Nothing is running.** The sessions panel is current and its live agents list
   (`lib/live-agents.mjs`: a run that wrote within 15 minutes and has not ended) is
   empty, and the lead is known (`agentWork.lead` is a name). With no agent work block,
   or no lead (no roster), the lead's quiet can't be counted, so it is "sessions not
   current". `leadLast: null` passes only when the lead is known and has made no request
   in the transcripts read (Ultron's L2).
2. **There is room.** The usage panel is current, the session limit is under 75% (the
   proactive check's own step), at least one weekly limit has a percent (with none,
   usage can't tell: Ultron's L1), and every weekly limit is both **under 90%**
   (`IDLE.weekPct`, the limit warnings' weekly step, `WEEKLY_STEPS`) and **projected
   under 100%** (§1); a weekly limit with no projection yet counts by its percent. The
   90% holds whatever the projection: the 24-hour rate after a quiet day is about 0, so
   a limit at 97% projects 97% and would otherwise still invite runs into the last 3%
   (Ultron's M1).
3. **There is work.** The board file holds at least one open item (lane `idea` or
   `doing`) with no `ask`.
4. **It has lasted.** The three have held for 10 minutes (`IDLE.settleMs`), counted
   from the later of the first idle pass and the lead's own session's last request
   (`agentWork.leadLast`), so neither the moment between one run's end and the lead
   starting the next, nor a conversation with the lead, is "idle".

**The words** are fixed, built from whole numbers only (`checkIdle`, `idleText` in
`lib/proactive-text.mjs`, checked again in the events module): how many workable items,
how many of them P0 and P1, how many in `doing`, the session percent, the highest weekly
projection, and how many wake-ups went out since a run was last seen. No id, no title.

    Idle: no agent run is live. 14 open board items have no ask (1 P0, 5 P1; 3 in
    doing). Session at 12%, highest weekly projection 64%. 2 idle events since the
    last run.

**Delivery.** `events.idle(fields, { nights })`: source `proactive`, type `idle`, no
alert key, and the kill switch `events-off` like every event. Its life at delivery is
15 minutes (`IDLE_EVENT_TTL_MS`), not the 2 hours of other events: it says the board
sat idle a moment ago, and the next one follows within the hour while that still holds
(Ultron's L4). It checks quiet hours itself, whoever calls: from 22:00 to 07:00 it
answers `quiet` and makes nothing unless the caller passes `nights: true`, which the
check does only when `idle.quietHours` is false (Ultron's L5). It never waits out a
window and is never held for later: a wake-up that is not made now is not made (the
next pass decides again). No socket source may be named `proactive` or anything
starting `proactive-` (`readEventsConfig`), so none can share the idle ledger's name
and its hour (Ultron's L3).

**Limits.**

- **At most one an hour**, kept twice: the check's own state (`proactive.json`, so a
  restart does not repeat one) and the events ledger (`IDLE_EVERY_MS`), which refuses a
  second within the hour whoever asks. That spacing is its whole cap: 24 a day at most.
- **It backs off while nothing follows.** Each wake-up after which no run is seen doubles
  the wait: 1, 2, then 4 hours (`IDLE_BACKOFF_MAX`). A run seen live puts it back to 1.
  Otherwise an unanswered wake-up would cost the lead a turn every hour of the day. A
  state that is neither idle nor a run (a stale panel, a high limit) does not put it back.
- **Outside the other caps**: counted in the ledger under a name of its own, so it uses
  up neither the heads-ups' 8 a day nor the others' 30.
- **Quiet hours 22:00 to 07:00**: no wake-up, and none held for the morning; the 07:00
  pass decides afresh. A config switch turns the night on (§3).

**What it never does.** It starts nothing, writes nothing to the board, pushes nothing to
a phone. The lead decides what to start.

**The page.** No new row: Heads up lists things that want the owner's eye, and an idle
board does not. `GET /api/proactive` carries an `idle` object (the switch, the state, the
counts, when it last went) for a check after go-live.

## 3. The switches

    "proactive": { "enabled": true, "idle": { "enabled": true, "quietHours": true } }

- `idle.enabled`: absent or false, no idle wake-ups. The rest of the check is unchanged.
- `idle.quietHours`: true or absent keeps 22:00-07:00 quiet (the default); false lets
  the wake-up go at night too, for overnight builds.
- The kill file `~/.local/state/jarvis-os/idle-off` stops the wake-ups at the next pass,
  no restart. `proactive-off` and `events-off` still stop everything they stopped.

## 4. For the lead's side (not this repo)

- The channel's standing words say an event alone never justifies a write. The idle
  event is only the alarm clock; what lets the lead start a run is the owner's standing
  ask of 2026-11-19, and the lead's own instructions need a line saying so.
- The channel names an event type it does not know `unknown`; `idle` needs adding beside
  `heads-up`. The words arrive either way (`source="proactive"`).

## 5. Open questions for the owner

1. **Weekly gate**: every weekly limit under 100% (built), or only "all models", so a
   model-scoped limit running out does not stop runs on another model. My pick: as
   built, since the lead's own session may run on the scoped model.
2. **Nights**: quiet by default (built); `idle.quietHours: false` for overnight builds.
3. **The back-off** (1, 2, 4 hours): or a flat hour.
