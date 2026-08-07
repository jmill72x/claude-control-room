# Claude Control Room Phase 2 — pace, history, and usage drivers

**Date:** 2026-08-06
**Status:** approved, pending implementation plan
**Builds on:** `2026-08-05-claude-control-room-design.md` (Phase 1, shipped)

Phase 1 answers "where am I right now". Phase 2 answers "where am I heading" and "why".

Three additions: a **pace projection** on each limit bar, a **history store** that makes trend
visible, and a **usage-drivers panel** built from data the dashboard already fetches and
currently discards.

---

## 1. Decisions taken

| Question | Decision |
|---|---|
| Layout | Column 01 may scroll; everything renders inline rather than behind a second view |
| Session window length | **Observed** from reset rollovers, never assumed |
| Sparkline range | Scaled per limit — session shows 24h, weekly shows 30d |
| Retention | Indefinite, monthly-rotated files; 30 days held in memory |
| Pace alerts | Yes, behind a confidence guard |
| Factors parsing | Lenient — must never take down limits parsing |

## 2. Why this data and not other data

**Only the `/usage` percentages are non-recoverable.** Token counts can be recomputed from the
transcripts on disk at any time, so persisting them would duplicate a source that already
exists. The limit percentages are point-in-time: uncaptured, that moment is gone permanently.
The history store therefore persists `/usage` snapshots only.

**The contributing-factors block is already on the wire.** Every poll fetches it and the parser
discards it. Surfacing it costs one parser extension and one panel — no new data source, no
extra CLI call.

## 3. The history store

`server/history.mjs`, owning `server/data/usage-history-YYYY-MM.jsonl`.

- **Append-only JSONL**, one record per **successful** `/usage` poll:
  `{ t: epochMs, limits: [{ label, pct, resetsAt }] }`. Never written for a failed, stale or
  absent reading — a gap in the file must mean "no reading", never "a reading of zero".
- **Monthly rotation.** At ~288 records/day a year is ~105,000 records (~21 MB). Rotating
  monthly means no routine operation ever parses a year-long file.
- **Retention is indefinite.** The data is non-recoverable and the volume is trivial; old
  months are archive nothing routinely reads.
- **In-memory window.** The server holds the most recent 30 days (~8,600 records) in memory to
  serve sparklines. At startup it warms that window by reading only the current and previous
  month's files.
- **Corruption tolerance.** Unparseable lines are skipped on read, matching the transcript
  parser. Never seed, never fabricate, never rewrite a file to "repair" it.

Interface:

- `append(snapshot)` — one record, current month's file
- `recent(sinceMs)` — records newer than a cutoff, from the in-memory window
- `warm()` — startup load of current + previous month

## 4. Window-length inference

Pace needs a window's **length**; `/usage` reports only its **end**. Weekly windows are seven
days (the label says so). The session window is not stated anywhere.

Rather than assume, observe: each poll records `resetsAt` per limit, and `server/lib/pace.mjs`
scans the history for forward jumps per label.

A forward jump is **not** exactly one window length — the original premise here was wrong, and
it put wrong numbers on the live dashboard. Session windows are user-initiated and therefore
not contiguous: the next window starts when you send the next message, so a jump spans
*idle + window*. Writing `R1` for the reset being superseded, `S` for the new window's start,
`W` for its length and `t2` for the reading that first showed the new reset:

    jump = (S + W) - R1 = W + (S - R1),    and    R1 <= S <= t2

so `jump - (t2 - R1) <= W <= jump`. **The lateness of the sighting, `t2 - R1`, is an exact bound
on the error** in reading the jump as the window. Inference therefore accepts a jump only when:

1. **Lateness.** `|t2 - R1| <= MAX_ROLLOVER_LATENESS_MS` (15 minutes — three poll intervals).
   Bounding the lateness bounds the error, by the arithmetic above rather than by judgement.
   Applied in both directions: a jump seen *before* `R1` is not a rollover at all, because that
   window had not ended. A reading with no usable `t` has no measurable lateness and is refused.
2. **Plausibility.** `jump >= MIN_PLAUSIBLE_WINDOW_MS` (30 minutes). The printed reset flaps by
   a minute between polls (`07:49`/`07:50` both appear in captured history); a flap caught right
   at a rollover is a *punctual* sighting, so this floor — not rule 1 — is what rejects it.
3. **The baseline only ever advances**, so a backward blip followed by a recovery cannot
   manufacture a rollover. It advances even for a jump that is refused: where the reset now is,
   is a different question from how long the window is.

- The answer is the **most recent** accepted observation, rounded to the minute.
- Weekly labels fall back to 7 days when no rollover has been observed yet.
- The session label has **no fallback**. Until a rollover is seen, that bar shows no pace and
  states plainly that the window length is not yet known. `null` always stands in preference to
  accepting a suspicious jump.
- Inference is self-correcting: if Anthropic changes a window, the next rollover reflects it.
  This is why recency wins and why no preference for a *repeated* length may override it — such
  a preference would keep reporting the old window for as long as its sightings outnumbered the
  new one's. With rule 1 doing the filtering, repetition is not needed for correctness.

## 5. Pace

Given window length `W`, reset `R`, current percentage `p`:

```
windowStart  = R - W
elapsed      = (now - windowStart) / W        // 0..1
expectedPct  = elapsed * 100
projectedPct = p / elapsed                    // linear extrapolation to window end
```

**Rendering.** A tick mark on the existing bar at `expectedPct` — where you would be burning
evenly — plus a sub-line: `on pace`, `ahead of pace · projected 118% by reset`, or
`under pace`. The bar itself is unchanged; the tick is an addition, not a redesign.

**Confidence guard.** No projection when `elapsed < 0.10`. Dividing by a small elapsed fraction
produces wild figures, and a projection that cries wolf trains the user to ignore the one
signal that matters — a failure this project has already had to fix once. Below the threshold
the sub-line reads `too early to project`.

`projectedPct` is not clamped: a projection of 180% is meaningful information. The **tick
mark** is clamped to the bar's width, the same way the credits bar clamps its fill while
printing the true figure.

## 6. Sparklines

A small inline SVG beneath each limit bar. **Range is scaled per limit**, because percentages
reset to zero each window: a uniform 30-day range would render the session bar as roughly 144
sawtooth spikes.

- Session limit → last 24 hours
- Weekly limits → last 30 days

One component, a range argument. Fewer than two data points renders an explicit "not enough
history yet" state rather than a flat line, which would read as "no usage".

## 7. The usage-drivers panel

Bottom of column 01, showing the 7-day window.

`/usage` returns, per window:

```
Last 7d · 5477 requests · 12 sessions
  100% of your usage came from sessions active for 8+ hours
  85% of your usage came from subagent-heavy sessions
  74% of your usage was at >150k context
  Top skills: /superpowers:subagent-driven-development 2%, ...
  Top subagents: general-purpose 28%
  Top plugins: superpowers 4%
  Top MCP servers: claude-in-chrome 14%
```

**Rendered with the existing model-rows idiom** — name, track, right-aligned percentage —
and **deliberately not as a stacked bar or pie.** Anthropic's own output states these are
"independent characteristics, not a breakdown"; they do not sum to 100, and rendering them as
parts of a whole would misrepresent them.

**The caveat is mandatory, not decorative.** This block is explicitly *"based on local sessions
on this machine — does not include other devices or claude.ai"*, while the percentages above it
are account-wide. The panel carries that distinction visibly. Two figures of different
provenance sitting in one column without it would be actively misleading.

Request and session counts (already parsed, currently unrendered) appear in the panel header.

## 8. Parser extension, with two failure semantics

`parse-usage.mjs` is the most fragile component in the project — it reads an undocumented CLI
format. This extension widens that surface, so the two halves fail differently:

- **Limits parse strictly.** Unchanged: a malformed limit line throws, the panel goes
  unavailable. These are the primary numbers.
- **Factors parse leniently.** A malformed or absent factors block yields `factors: null`. The
  drivers panel reports unavailable; limits are untouched.

A format change in the supplementary block must never take down the primary numbers.

## 9. Alerts

One new rule in `lib/alerts.mjs`: a limit projected to exceed 100% before its reset, subject to
the same confidence guard. Wording names the limit and the projected timing —
`Weekly · all models projected to cap Thursday`.

This complements rather than replaces the existing threshold rule: 85% tells you that you are
nearly out, pace tells you while you can still act.

## 10. Degradation

Every addition follows Phase 1's rules.

- No history → sparklines show "not enough history yet", never a flat line.
- No observed window length → no pace, stated explicitly.
- `elapsed` below the guard → "too early to project".
- Factors unavailable → panel reports it; limits unaffected.
- History file unreadable → the store reports it; the rest of the dashboard is unaffected, and
  it must not be confused with "no usage".

## 11. Testing

- **Pace maths at boundaries:** `elapsed` at 0, at the guard threshold, at 1 and beyond; `p` at
  0 and above 100; a `resetsAt` in the past.
- **Window inference:** a clean rollover, no history, a single reading, a reset that moves
  backwards (clock change or a corrected reading) — which must not produce a negative length.
- **History store:** append, read-back, month rotation across a boundary, corrupt-line
  tolerance, and that a failed poll writes nothing.
- **Factors parsing:** the real captured block; a malformed block leaving limits intact; an
  absent block; and a factors line with an unfamiliar category, which must pass through rather
  than being dropped.
- **Timezone independence** on everything date-bearing, verified under at least two zones.
  Phase 1 lost multiple review rounds to this.

## 12. Out of scope

- Any second view or navigation — column 01 scrolls instead.
- Persisting token aggregates: recomputable from transcripts, so storing them duplicates a
  live source.
- Cost or pricing estimates: this is a subscription; per-session cost is not billed and would
  hardcode figures Anthropic can change.
- Chat usage: permanently unmeasurable locally (Phase 1 §2).
