# Control Room mod for Claude Code

The Control Room dashboard as a side pane inside Claude Code, plus a
`/control-room summary` command that prints the board as text anywhere a pane
can't draw.

The mod is a thin client. The Control Room server stays the single source of
truth: the mod reads `/api/dashboard` and `/api/todos` and writes `/api/todos`,
exactly as the web page does, so the two can never disagree about what is true.

Built and tested against Claude Code 2.1.293. Mods need 2.1.287 or later in the
terminal.

## What it shows

Three tabs, switched with `1`, `2` and `3`:

| Tab | Contents |
|---|---|
| Usage | Plan and renewal, credits (grants with what's left and when they expire, usage credits), the three limit bars with resets, pace and a sparkline, this week by surface, project and model, drivers, recent sessions |
| Projects | Every project with its running state, then every cron with its schedule, next run and last result, failing first |
| To-dos | The board grouped by stage or tag, sorted by priority. Select an item to change its priority, move its stage, edit it, delete it with a confirmation, or hand it to Claude with **Work on it**. Done items are counted and hidden until you ask for them |

Alerts from the dashboard show at the top of every tab. A line under the tabs
says how old the reading is.

The rules are the web page's: a value the server couldn't read is shown as
unknown, never as zero. If the server stops answering, the last reading stays on
screen, marked with its age and the reason. Every request gives up after 5
seconds, because a server that hangs requests would otherwise hang the pane.

## Commands and keys

```text
/control-room            open the pane and give it the keyboard
/control-room summary    print the board as text
/control-room close      close the pane
```

Sent from a phone or the web over Remote Control, `/control-room` also prints
the summary, in case that app doesn't draw the pane.

| Key | What it does |
|---|---|
| `1` `2` `3` | Switch tabs |
| `r` | Re-read the dashboard now |
| Tab, Enter | Move between controls and press one |
| Esc | Give the keyboard back to the prompt |
| Ctrl+X then X | Close the pane |

## Where it draws

| Where you run Claude Code | What you get |
|---|---|
| Terminal | The pane: a sidebar in a wide fullscreen terminal, above the prompt otherwise |
| Code tab of the Desktop app | The pane |
| Claude mobile app, over Remote Control | The pane, without the add and edit fields, which that app doesn't draw yet. The summary prints as well |
| `claude -p` and the Agent SDK | The summary as text |

The mobile row follows the type definitions Claude Code 2.1.293 writes, which
list the mobile app as a surface that draws panes. The docs page describing 2.1.290
says otherwise, so treat the phone as unconfirmed until you've seen it there.

## Load it

For one session:

```bash
claude --plugin-dir ~/Projects/claude-control-room/mod
```

For every session, including the Desktop app, add the directory to the `env`
block in `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/absolute/path/to/claude-control-room/mod"
  }
}
```

The path must be absolute. The working copy is what loads, so a `git pull`
updates the mod.

## Settings

Change these in `/config` once the mod is loaded:

| Setting | Default | What it does |
|---|---|---|
| `dashboard_url` | `http://127.0.0.1:8322` | Where the server answers |
| `auto_open` | on | Opens the pane when an interactive session starts. Claude Code places a pane nobody asked for only in a wide terminal: 144 columns, or 110 once you've opened it yourself. It never takes the keyboard |
| `refresh_seconds` | 30 | How often an open pane re-reads the dashboard. A closed pane doesn't poll |

To point the mod at another server, change `dashboard_url`. The constant in
`hooks/register.js` is only a fallback, because the setting's default always fills
in first.

## To-do writes

Each change re-reads the server's list and applies itself to that, then writes
the result. An edit made on the web page a moment earlier therefore survives. If
the item is gone by then, nothing is written and the pane says so. A refused
write shows the server's error and the list the server actually holds.

## Files

| File | What it holds |
|---|---|
| `hooks/register.js` | Every Claude Code API call: fetching with the timeout, polling, saving, the command, the pane hook |
| `hooks/model.js` | The rules, as pure functions: grouping, sorting, heat, pace wording, the summary text |
| `hooks/view.js` | The pane's tree for each surface, as a pure function of state |
| `tests/` | The test kit's tests, run with no session or network, against a stub server and synthetic data |

## Tests

```bash
cd mod
claude plugin test        # 49 tests
claude plugin validate .
```

The fixtures are invented, not captured. The repo is public, and the project
keeps real job and project names out of its committed files.
