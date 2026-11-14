# War room: stop buttons (design only, for Jeff to decide)

Board 83daafe7, slice 2. Slice 1 (built 2026-11-13, branch `jos/war-room`) is the
read-only Live agents panel on the Overview. This page says how a Stop button on one of
its rows could work. Nothing here is built.

## What Claude Code can stop, and from where

- **A subagent runs inside the session that started it.** Jarvis's agents are subagents
  of Jarvis's session: no process of their own, no socket, no CLI to reach them from
  outside. The one supported stop is the **`TaskStop` tool**, called *by that session*:
  it "stops a running background task by its ID" (a background shell, a background
  agent, a named agent or a teammate). Nothing outside the session can call it.
- **A foreground subagent can't be stopped that way.** While the parent waits on it, the
  parent takes no turn, so it never sees the request until the subagent returns. Only
  background agents are stoppable. Whether Jarvis's briefs all run in the background is
  to check (step 1 below).
- **A `claude -p --agent` run** (a routine started by launchd) is its own process. It
  could be signalled by pid, but that kills a routine mid-write, and the routines'
  LaunchAgents are Vision's. Left out.
- **`claude agents` (the agent view)** dispatches and lists background sessions;
  `--json` lists them. Its help (2.1.325) shows no stop command. Polling it was dropped on
  2026-10-30 (README, "How often the server starts `claude`"). Left out.
- **Interrupting Jarvis's terminal** (Esc, a signal to its tmux pane) stops everything at
  once and is session puppeting (rule 5). Never.

## The design: Stop asks Jarvis, through the chat Jeff already uses

1. A **Stop** button on a live row (only rows whose session is the lead's).
2. Tapping it opens a confirm sheet naming the run: "Stop Pepper? Build war room slice 1,
   running 42 min." with **Stop** and **Cancel**.
3. **Stop** sends one chat message from Jeff's paired device, through the chat route that
   already exists (`POST /api/chat`, same-origin, device token), with a structured part
   the page fills: the run's agent type, its brief line and its start time. No new write
   route on the server.
4. Jarvis's session gets it as Jeff's message, finds the background task whose agent and
   brief match, and calls `TaskStop` on it. It replies in chat with the result ("stopped",
   "already finished", "not found", "can't: runs in the foreground").
5. The row leaves the panel when the transcript stops being written (up to 15 minutes, the
   live window, marked "quiet" after 2), or at once if a later slice reads TaskStop's
   result.

**Option B (later, if A is too slow):** a `stop` verb in the Jarvis channel plugin, so
the request reaches the session as a typed event, not free text. It needs a channel
release and a new server route (`POST /api/agents/<id>/stop`), so it is the larger
change and the one with the most to review.

## What it can and can't stop

- **Can:** a background subagent of Jarvis's session, between its tool calls.
- **Can't:** a foreground subagent (step 2 of "What Claude Code can stop"), a subagent of
  another session (another terminal, the Claude app), a `--agent` routine, the lead's own
  session, a tool call already running (TaskStop ends the agent; whether it kills a
  Bash command's child processes is to check), and anything already done (files written,
  posts sent, staged changes: a stop is never an undo).
- **Delay:** Jarvis acts at its next turn. If Jarvis is mid-turn, the stop waits.

## The gate

Jeff's rule of 2026-11-12: Jarvis OS allows what the Claude app allows, and adds no
stricter gate. In the app, stopping a task is one tap (or Esc) with no confirmation.
**My pick: the confirm sheet only (two taps), no Face ID**, from a paired device, with
the chat's own checks (pairing, same origin, the device token). Face ID (WebAuthn) would
be stricter than the app and is out by that rule. The confirm sheet is there because a
Stop sits next to scrolling on a phone, not as a security gate. Every stop shows in the
chat thread, so it is on record.

## What Ultron must check

- The stop message can't be forged into another instruction: its structured part is
  built by the page from the row's own fields, shown in the sheet as it will be sent, and
  Jarvis acts only on that part (agent type, brief line, start time), never on free text.
- Jarvis's matching: two runs of one agent with similar briefs must not be confused; no
  match means no stop, and Jarvis says so.
- Nothing in the row or the message exposes a prompt, a path or a session id.
- A stop on a run that already ended is harmless and reported, not retried.
- Option B only: the new route's auth (paired device, same origin, the token), rate limit,
  the opaque id resolving server side to a live run of the lead's session only, and the
  channel event's handling (an event is data, so the session must treat a `stop` as Jeff's
  only when the channel marks it as from his device).

## Steps before building

1. Check in Jarvis's session (Jarvis, not Pepper): are briefs started with
   `run_in_background`, and does `TaskStop` accept the agent id or name they get?
2. Try TaskStop on a scratch background agent running a long Bash command: does the
   command's process end too?
3. Jeff decides: option A or B, and the gate (confirm only, my pick).
