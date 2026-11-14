# War room: stop buttons

Board 83daafe7, slice 2. Slice 1 (main a4946a5) is the read-only Live agents panel on the
Overview. **Jeff picked option B with a Face ID gate on 2026-11-13, over Ultron's
recommendation of A; it is built and staged on `jos/war-room-2` (Control Room) and
`jos/war-room-stop` (Jarvis's repo, channel 0.4.7).** The build is the last section,
"Built: option B with Face ID". The sections before it are the design as written before
the pick, kept for the reasoning.

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

## Built: option B with Face ID (2026-11-13)

### The path of one stop

1. **Row.** The server marks a live row `stoppable` (`server/lib/live-agents.mjs`) when it
   is a subagent of a roster agent other than the lead, its meta file says
   `requestShape: "background"` (a foreground run can't be stopped), and its session is
   named as the lead's. The page shows **Stop** on such a row only on an approver device
   (`GET /api/stepup/status` answers 200 only to one).
2. **Confirm sheet.** "Stop Pepper? <brief line>, running 42 min." The brief line is shown
   to Jeff and goes nowhere else.
3. **Face ID.** `POST /api/agents/<id>/stop/challenge` issues a WebAuthn challenge bound
   to this device and `stop:<id>`, 2 minutes, single use. The browser's Face ID sheet
   signs it with the device's platform passkey; `POST /api/agents/<id>/stop` carries the
   answer (`server/lib/stepup.mjs` verifies it).
4. **Stop line.** The server appends a store message of the new kind `stop`
   (`from: jeff`, the device name, fixed text for the page's thread, and
   `meta.stop = { row, agent, start }`), and the channel stream sends it as
   `{type: "stop", seq, id, at, row, agent, start}` (`server/lib/chat-socket.mjs`).
5. **Channel.** Channel 0.4.7 (`jarvis-local/plugins/jarvis-channel/server.mjs`) checks
   each field against one shape and writes its own words into a tag with
   `chat_id="jos-stop"`, `user="jeff"`, `stop_request="1"`, `row`, `agent`, `started`.
6. **Lead.** The channel's instructions tell the session: run
   `stop-match.mjs <row> <agent>` (by the absolute path of the channel's own folder, so
   the copy in the release worktree under the reviewed hash, never the main tree); call
   `TaskStop` only with the `task_id` it prints; then
   `stop-match.mjs --after <row> <agent>`; reply in chat with `reply_to` the stop's id.

### Ultron's two objections

- **"It needs a new kind of channel event that counts as Jeff's, while `jos-events` must
  stay data-only."** It is a separate kind end to end, so `jos-events` is untouched: its
  own store kind (`stop`, which only `from: jeff` with a device can make; the store
  throws otherwise), its own stream line type, its own hello capability (`stop`; a
  channel that didn't declare it is never sent one, and the route answers 503 while it
  holds the socket), and its own `chat_id` (`jos-stop`). What makes it Jeff's is not
  the label but where it can come from: only the stop route appends one, and the route
  needs a paired approver device's cookie, the page's own https Origin, and a Face ID
  assertion for that row. And what it can do is one thing: the instructions limit it to
  `TaskStop` on an exact match, never an OK or an instruction (C3). The line carries no
  text at all, so even a forged one could only name a row id, a roster key and a time.
- **"The server knows the lead session only by name, which any terminal can claim"
  (L4).** The name decides only where a **Stop** button appears. It never decides what
  is stopped. A stop goes to the one channel process holding the socket (the lead's,
  launched by `jarvis-start`; the server's token and epoch rules, unchanged), and the
  lead matches the row id only against **its own** session's subagent files: the
  matcher reads `CLAUDE_CODE_SESSION_ID` from the lead's own Bash and hashes
  `~/.claude/projects/*/<that id>/subagents/agent-*.jsonl`. A terminal that names itself
  "Jarvis" gets Stop buttons on its rows, and a stop on one finds no match in the lead's
  session, so nothing is stopped and Jarvis says "not found" (tested). `TaskStop` itself
  reaches only the calling session's tasks.

### Ultron's conditions, adapted to B

- **C1 (only fixed text, the row id, the roster key and the start time reach Jarvis).**
  The stream line has exactly `type, seq, id, at, row, agent, start` (tested by key
  list); the server's text never goes down it (tested with a hostile text). The channel
  builds the words from the three checked fields. The store text (for the page and
  `fetch_history`) is fixed words from the roster key and the start time. The brief
  line and the session name never leave the page.
- **C2 (exact match by hashing the lead's own paths; no match, no stop).** `stop-match.mjs`
  hashes `path.join(home, '.claude', 'projects', <project>, <session>, 'subagents',
  'agent-<id>.jsonl')`, the same spelling the collector walks; it needs exactly one hit,
  the meta's `agentType` equal to the stop's roster key, and `requestShape:
  "background"`, and prints the task id from the file name. Checked on the mini against
  a real run: the Control Room's code gave row `e4261c42…` for this very build's run,
  and the matcher found task `aec88700d3677e145` for it (read-only; no stop called).
- **C3 (never an OK or another instruction; refused from Shortcut keys).** The
  instructions say so in words; every stop and step-up route refuses any request with an
  `Authorization` header (how a Shortcut key authenticates) before looking at anything
  else, and needs the device cookie.
- **C4 (approver devices only).** Every route, the status read included, answers 403 to a
  device without the approver mark; a passkey confirm checks the mark again at confirm
  time; a revoke deletes the device's passkey.
- **C5 (one per row per minute; "already finished" reported, not retried).** The route
  refuses a second stop for a row within 60 s (429), and caps all stops at 6 a minute.
  A row no longer live is 404 "not live now; it may have finished", checked again after
  the Face ID wait. The channel line is delivered only within 2 minutes of the tap
  (`STOP_DELIVER_MS`), so a stop replayed after a channel restart can't land late; one
  that misses is marked undelivered and the page says so. The matcher reports
  `finished: true` for a run whose last line ended it or that is quiet past 15 minutes,
  and the instructions say not to retry.
- **C6 (a Bash child left running is reported).** `stop-match.mjs --after` reads the run's
  transcript for Bash calls with no result (and ones sent to the background), and looks
  for processes whose command line holds the command's first line; the reply must say
  when one still runs. Matching by command text is best effort (a command shorter than 8
  characters is never matched): it can miss a process, and it says "no matching process"
  rather than "nothing running" in that case.

### Face ID (WebAuthn step-up)

Nothing like it existed (the approvals design's Phase C was never built), so this is a
minimal one, for stops only (`server/lib/stepup.mjs`, about 230 lines, node:crypto, no
dependency):

- **Registration** on an approver device: `POST /api/stepup/register/options` (ES256,
  platform authenticator, `userVerification: "required"`, attestation `none`), the
  browser makes the passkey, `POST /api/stepup/register` sends the credential id,
  clientDataJSON, authenticator data and the public key as SPKI (`getPublicKey()`). The
  server checks type, challenge, origin, not cross-origin, the rpId hash, UP and UV, the
  credential id in the attested data, that the key is P-256, and that the attested COSE
  key holds the SPKI key's x and y. Then it is **pending**: the page shows a 6-letter
  code, and it counts only once confirmed at the machine with `bin/chat-pair passkey
  <CODE>` (the admin socket; 10 minutes, 3 wrong codes end it; one pending set-up at a
  time). That is the same confirm a first pairing takes, so a stolen unlocked phone can't
  enrol its own passkey from the page alone. Kept in `data/chat/passkeys.json` (0600),
  one per device.
- **Assertion:** the challenge is the server's (32 random bytes), single use, 2 minutes,
  for one device and one purpose; the answer must name that device's credential, carry
  type `webauthn.get`, the challenge, the request's own Origin, not cross-origin, the
  rpId hash, UP and UV, a signature that checks, and a counter that moves up when it
  moves (synced passkeys stay at 0).
- **Why not CBOR:** the page sends SPKI, and the x/y check ties it to the attested data,
  so the server never parses attestation CBOR. Attestation is `none`: the confirm at the
  machine is the trust step.
- **Costs and limits:** UV on Apple devices accepts the device passcode when Face ID
  fails, as every passkey does. A passkey synced by iCloud Keychain to another Apple
  device works there too, but only with that device's own paired approver cookie, which
  the route checks first. Needs HTTPS (the Serve name; loopback http can't).

### Tests and checks (2026-11-13)

- Control Room: `server/test/agent-stop.test.mjs` (12 tests after the review fixes: a software P-256
  authenticator for the full register, confirm, challenge and stop path, and each
  refusal), a stream test in `server/test/events.test.mjs` (capability, 2-minute window,
  undelivered mark, store guard), and `web/test/orbit-stop.test.js`. Mutation pass over 20
  guards: all killed but one equivalent (the challenge's age check, which the sweep
  before it always covers). Full server suite: 1195, one failure that main has too
  (`acks.test.mjs`, "an alert with no since").
- Headless Chromium, a scratch https server running the real chat, stop and step-up
  routes with a **virtual platform authenticator** (CDP WebAuthn, UV on): set up Face ID,
  confirm the code, stop, a second stop refused in words; light and dark at 390 px, no
  sideways scroll.
- Channel: `test/stop.test.mjs` (9 tests) and the updated hello/instructions tests; the
  channel's unit suites pass (100). The e2e harness (`test/e2e`) was not extended or run.

### Not verified

- `TaskStop` with an agent id from the file name (`agent-<id>.jsonl`). The tool's own
  description says a background agent is stopped "by its ID"; the first real stop shows
  it. If it wants another id, the matcher prints the wrong one and TaskStop fails, which
  Jarvis reports (no wrong stop: the id is this session's own run either way).
- Whether TaskStop ends a running Bash command's process (step 2 of "Steps before
  building"); `--after` reports it either way.
- Safari and real Face ID on the iPhone and iPad (only Chromium's virtual authenticator).
- The lead running `stop-match.mjs` without a permission prompt (a Bash allow rule for it
  is Jarvis's and Jeff's call).

### Ultron's review fixes (2026-11-13, "ship with fixes": 1 medium, 9 low)

- **M1, the confirm by any same-user process.** `chat-pair passkey` refuses without an
  interactive TTY, shows the device name and when it was set up (`GET /admin/passkey`,
  never the code), and asks for the name typed back; the server refuses a confirm whose
  name doesn't match (a wrong one counts as a wrong try). The channel's instructions say
  never to run `bin/chat-pair` in any form or use `admin.sock`. Plain pairing codes are
  left as they were: the lead's channel e2e harness runs `chat-pair <CODE>` without a
  TTY. This is a speed bump against a same-user process (it can still open a pty or the
  socket), not a wall; the wall is that Jeff reads the name before typing it.
- **L2.** A made passkey waiting for its code blocks a new set-up from any device until
  it is confirmed or its 10 minutes pass; `/api/stepup/status` answers `pending` and
  `pendingUntil`, never the code.
- **L3.** At most one `passkey-pending` alert per device per 10 minutes.
- **L4.** The approver mark taken off forgets the device's passkey, as a revoke does
  (`deviceEvent` in `lib/stepup.mjs`).
- **L5.** Only a last line that ends the run counts as finished; a run quiet past 15
  minutes still matches, with `quiet: true`.
- **L6.** `--after` looks only at processes under the session's own claude process
  (`CLAUDE_PID`, walked by parent pid); without it, none. The instructions say never to
  kill a pid it prints: tell Jeff, and kill one only with his OK.
- **L7.** The matcher reads a meta file only if it is a regular file (lstat, no link) of
  at most 64 KB.
- **L8.** `fetch_history` labels a stop "jeff (stop request, handled by its jos-stop
  tag)" and an event "system (event)".
- **L9.** The channel drops a stop line older than 2 minutes too (logged and acked).
- **L10.** The instructions say to run the matcher exactly as written, with no
  environment assignments, extra arguments or other commands.

### Go-live order

1. C&P both branches. 2. Restart the Control Room (the route answers 503 until the
channel says `stop`). 3. Release channel 0.4.7 and restart Jarvis's session through
`jarvis-start`. 4. On each approver device: Stop on a live row, Set up Face ID, then
`bin/chat-pair passkey <CODE>` at the mini. 5. A first stop on a scratch background
agent running `sleep 300`, to settle the two unverified TaskStop points.

