# Handoff: Claude Control Room dashboard

## Overview
A single-screen operational dashboard giving one person a snapshot of their Claude account:
what they're spending against their limits, what projects and scheduled crons are running, and
a personal backlog of ideas/to-dos about that setup. Three equal columns, always-on, read at a
glance from a desk browser (Mac mini) and an iPad.

## About the design files
The files in this bundle are **design references written in HTML** — a prototype of the intended
look and behavior, not production code to copy. The task is to **recreate this design in the
target codebase's environment** (React/Next, Vue, SwiftUI, whatever exists) using its established
patterns, data layer and component library. If no codebase exists yet, pick the framework that
best fits the deployment (a small React + Vite SPA with a thin server for API keys is a
reasonable default) and implement there.

`Claude Control Room.dc.html` is a self-contained streaming component format; treat its markup as
a spec for structure and styling, and its logic class as a spec for data shape and behavior.
It runs from `support.js` in the same folder — open the HTML directly in a browser to see it.

## Fidelity
**High fidelity.** Colors, type, spacing, and states below are final and exact. Recreate
pixel-faithfully, but substitute the target codebase's own components where equivalents exist.
All values derive from the "Modernist" design system in `styles.css` (included) — flat, zero
corner radius, 2px rules, one red accent, Archivo throughout.

---

## Screen: Control Room (single view)

### Page shell
- Background `#f3f2f2`, text `#201e1d`, font `Archivo` (400/500/600/700/800), antialiased.
- Bottom padding 64px. No max width — the three columns stretch to the viewport.

### Header (full width)
- Flex row, `align-items: flex-end`, `justify-content: space-between`, padding `24px 32px 16px`,
  `border-bottom: 2px solid #201e1d`.
- Left: eyebrow "ANTHROPIC ACCOUNT SNAPSHOT" — 11px / 600 / `letter-spacing .14em` / uppercase /
  `#7d7979`; then `<h1>` "Control Room" — 34px / 800 / `letter-spacing -.02em` / `line-height 1`.
- Right: two stat blocks, 32px gap. Each = 10px uppercase label (`.12em`, `#7d7979`, 600) over a
  22px / 800 tabular-nums value. "Session resets in" value is `#ec3013` and counts down live
  (`H:MM:SS`, or `MM:SS` under an hour). "Synced" shows local `HH:MM`.

### Alert bar (conditional)
Shown when any cron failed or any limit ≥ 85%. Full width, background `#ec3013`, text `#fff2ef`,
`border-bottom: 2px solid #201e1d`, padding `10px 32px`, flex row gap 16px.
Leading pill: "ATTENTION" — 10px / 800 / `.14em` / uppercase, padding `3px 8px`, background
`#201e1d`. Then one 13px/600 line per alert.

### Column grid
`display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0`. Columns 1 and 2 carry
`border-right: 2px solid #201e1d`. Each column: padding `20px 24px 32px`, flex column, gap 20px.
Every column opens with a header row: `<h2>` 15px / 800 / `.1em` / uppercase ("01  USAGE"),
`border-bottom: 2px solid #201e1d`, padding-bottom 8px, with a right-aligned 11px/700 `#7d7979`
summary or control.

---

### Column 01 — Usage

Column header right side carries an 11px/700 `#7d7979` note: "Billing cycle · 17 days left".

**Plan block**
- Row: plan name 20px / 800 / `-.01em` ("Max — 20×") and price 12px / 600 / `#605d5d`.
- Below, a 2-column grid with `border-top: 1px solid #d7d3d3` and a `1px #d7d3d3` divider between
  cells: "RENEWS" → `Aug 21, 2026`; "SEATS · EXTRA" → `1 · none`. Labels 10px uppercase `.12em`
  `#7d7979` 600; values 14px / 700.

**Limits** — three entries: Current session, Weekly · all models, Weekly · Opus. Each has
`pct` and a sub-line. Color is by heat, from a `warnThreshold` setting (default 85):
`≥ threshold → #ec3013`, `≥ 70% of threshold → #605d5d`, else `#201e1d`.
- Bars: label 13px/700 + right-aligned percent in the heat color; a 10px track `#d7d3d3` with an
  absolutely-positioned fill; sub-line 11px `#7d7979`. The session sub-line reads
  "resets H:MM:SS" and ticks.
**By surface · this week** — a single 26px stacked bar, `border: 1px solid #201e1d`, segments
flex-weighted by percent: Cowork `#201e1d` (41%, 18h 20m), Code `#ec3013` (34%, 15h 10m),
Chat `#d7d3d3` (25%, 11h 05m). Percent printed inside each segment at 10px/800 in the segment's
foreground (`#f3f2f2` / `#fff2ef` / `#201e1d`). Legend below: 9px swatch with a 1px ink border,
11px/600 name, 11px `#7d7979` hours.

**By model · this week** — rows of `grid-template-columns: 70px 1fr 52px`, gap 10px, padding 5px 0,
`border-bottom: 1px solid #eae7e7`. Name 12px/700; a 6px `#d7d3d3` track with an `#201e1d` fill;
right-aligned 11px/600 `#605d5d` token count. Sonnet 54% / 41.2M, Opus 33% / 25.1M,
Haiku 8% / 6.4M, Fable 5% / 3.8M.

**Recent sessions** — rows of `grid-template-columns: 48px 1fr auto`, padding 7px 0,
`border-bottom: 1px solid #eae7e7`. Time/day 11px/600 `#7d7979`; title 12px/700 over a 10px
`#7d7979` "surface · model" line; then a 56px mini track (fill in heat color) and a 32px
right-aligned 11px/800 percent.

---

### Column 02 — Projects & crons

Header summary: "N running · M total".

**Project rows** — `grid-template-columns: auto 1fr auto`, gap 12px, padding 11px 0,
`border-bottom: 1px solid #d7d3d3`.
- Status dot: 10px square, `1px solid #201e1d`, `#ec3013` when running, `#bab6b6` when idle.
- Middle: name 14px / 700 / `-.01em`; under it a tool pill — 9px / 800 / `.1em` / uppercase,
  padding `2px 6px`, Code = `#201e1d` on `#f3f2f2`, Cowork = `#d7d3d3` on `#201e1d` — plus an
  11px `#7d7979` detail line ("edited 4m ago · main").
- Right: "RUNNING"/"IDLE" 11px / 800 / `.06em` / uppercase in the dot color, over an 11px
  `#7d7979` open-task count.

**Crons** — sub-header `<h3>` 13px / 800 / `.1em` / uppercase with a
"N failing · M scheduled" summary, `border-bottom: 2px solid #201e1d`.
Rows sort **failures first**, then by soonest next run. Each row:
`grid-template-columns: 1fr auto`, padding `11px 10px 11px 12px`,
`border-left: 3px solid` (`#ec3013` failing, `#201e1d` healthy), row background `#fff2ef` when
failing else transparent, `border-bottom: 1px solid #d7d3d3`.
Left: name 13px/700 over a human-readable schedule 11px/500 `#605d5d` ("Every day, 02:00").
Right: "in 10h 50m" 13px/800 tabular-nums, over last result 10px / 800 / `.08em` / uppercase in
the edge color ("Failed 02:00 · 429").

---

### Column 03 — Ideas & to-dos

Header note: "Saved on this device". Three lanes — **Idea → Doing → Done** — each with an 11px /
800 / `.12em` uppercase title, a count, and `border-bottom: 1px solid #201e1d`.

Item card: `grid-template-columns: auto 1fr auto`, gap 10px, padding `9px 10px`, background
`#eae9e9`, `border-left: 3px solid` (idea `#bab6b6`, doing `#201e1d`, done `#d7d3d3`).
- Left button: 16px square, `1.5px solid #201e1d`, fill transparent / `#9b9797` / `#201e1d` by
  lane, glyph ` ` / `›` / `✓` at 10px/800 in `#f3f2f2`. Clicking it advances the lane
  (idea→doing→done→idea). Tooltip "Move to <lane>".
- Text 13px / 600 / `line-height 1.35` / `text-wrap: pretty`; in Done it is `#9b9797` and
  line-through. Below it a 9px / 800 / `.1em` uppercase `#7d7979` tag.
- Right: `×` delete button, 14px, `#9b9797`, hover `#ec3013`.
- Lane footer: a full-width text input, 12px/500, padding `8px 10px`,
  `border: 1px solid #d7d3d3`, transparent background, focus border `#201e1d`. **Enter** adds an
  item to that lane and clears the field. Placeholders: "+ new idea", "+ start something",
  "+ log something done".

---

## Interactions & behavior
- **Live clock**: one `setInterval` at 1s updates the header countdown and the session limit
  sub-line. Guard against duplicate timers; clear on unmount.
- **Alerts**: derived, not authored — any failing cron or any limit ≥85% produces a line.
- **Kanban**: add (Enter), advance (click box), delete (×). Persisted to `localStorage` under
  `claude-control-room-todos-v1` as `[{id, text, lane, tag}]`, seeded with examples on first run.
  In production this should move to real storage so it survives devices.
- **Focus**: `*:focus-visible { outline: 2px solid #ec3013; outline-offset: 2px }` — do not fall
  back to the browser default ring.
- **Responsive**: at desk width, three columns. For iPad portrait, collapse to one column with the
  same order (usage → projects/crons → ideas) and drop the vertical rules; the header stat blocks
  wrap under the title. (Not built in the prototype — implement.)

## State & data
Local UI state: `now` (tick), `todos`, plus the derived alert list. Two settings:
`showAlertBanner` (bool) and `warnThreshold` (number, default 85 — drives all heat coloring).

Everything else is server data. All figures in the prototype are **mock** and shaped as:

```ts
plan     { name, price, renews, seats }
limits   [{ label, pct, sub }]
tools    [{ name: 'Cowork'|'Code'|'Chat', pct, hours }]
models   [{ name: 'Sonnet'|'Opus'|'Haiku'|'Fable', pct, tokens }]
sessions [{ when, label, detail, pct }]
projects [{ name, tool: 'Code'|'Cowork', running: bool, detail, tasks }]
crons    [{ name, schedule, nextRunAt, ok: bool, last }]
todos    [{ id, text, lane: 'idea'|'doing'|'done', tag }]
```

### Wiring it to real data — the actual work
This is the part to scope first; the UI is the easy half.

1. **Usage & plan.** Check Anthropic's current developer documentation for the usage/cost
   reporting and admin endpoints available to the account type in question, and confirm what a
   *consumer subscription* (vs. an API org) exposes — they are different surfaces, and
   subscription-side session/weekly limit percentages may not be available programmatically. If
   they aren't, the honest fallbacks are (a) render only what the API does expose and label the
   rest, or (b) derive burn locally from client-side session logs. Do not invent endpoints; verify
   before building.
2. **Projects.** "Running/idle", last activity and open-task counts for Code and Cowork projects
   most likely come from the local machine, not a public API — e.g. a small local agent that
   watches working directories, git state and running processes and POSTs a heartbeat to the
   dashboard's backend. Design the projects feed as a generic ingest endpoint so any source can
   fill it.
3. **Crons.** Same shape: whatever runs the schedules (system cron, a scheduler service, GitHub
   Actions) reports name, cron expression, last exit status and next fire time. Convert the cron
   expression to the human string on the server; send `nextRunAt` as an ISO timestamp and count
   down on the client.
4. **Secrets.** No API key in the browser. Put a thin backend between the dashboard and any
   Anthropic API, cache responses (usage data does not need per-second freshness — 1–5 min is
   plenty), and let the UI poll that.
5. **Degradation.** Every panel needs a loading and a stale/unavailable state. A dashboard that
   silently shows old numbers is worse than one that says it's stale.

## Design tokens (from `styles.css`)
- Ground `#f3f2f2` · surface `#eae9e9` · ink `#201e1d` · accent `#ec3013`
- Neutrals: 100 `#f8f4f4`, 200 `#eae7e7`, 300 `#d7d3d3`, 400 `#bab6b6`, 500 `#9b9797`,
  600 `#7d7979`, 700 `#605d5d`, 800 `#444141`, 900 `#2d2b2b`
- Accent ramp: 100 `#fff2ef`, 200 `#ffe0d9`, 300 `#ffc4b8`, 500 `#ff563c`, 600 `#dd2b0f`,
  700 `#ae1800` (accent text on light ground), 800 `#7c1405`
- Spacing 4 / 8 / 12 / 16 / 24 / 32 · **radius 0 everywhere** · rules 2px structural, 1px internal
- Type: Archivo 400/500/600/700/800. Scale in use: 34 / 22 / 20 / 15 / 14 / 13 / 12 / 11 / 10 / 9.
  Uppercase labels carry `.08em`–`.14em` tracking; all numerics use `font-variant-numeric: tabular-nums`.
- Shadows exist in the system but are unused here — the design is flat.

## Assets
None. No images, no icon font. The only glyphs are `›`, `✓`, `×`. If icons are wanted, the design
system specifies Lucide. Archivo loads from Google Fonts — self-host it in production.

## Files in this bundle
- `Claude Control Room.dc.html` — the prototype (open in a browser)
- `support.js` — runtime the prototype needs; not for production
- `styles.css` — the Modernist design system token sheet and component layer
- `design-system-readme.md` — how that system is meant to be used
- `screenshots/control-room-full.png` — the full dashboard as built (2× capture)
