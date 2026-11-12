# Approvals as buttons in Jarvis OS

Written 2026-11-11 by Pepper for Ultron (review first) and then Jeff (sign-off); **built the
same day** (section 0) with Ultron's findings fixed and Jeff's decisions applied. Board item
2422f9d1; it replaces §5.8 of
`docs/design/2026-11-10-jarvis-os-home.md`. Jeff's words: "both" (2026-11-10: buttons on the
page *and* the Discord DMs that exist today) and "Do it" (2026-11-11). His earlier word on the
board (09248dc0, 11-11) still stands until he changes it: the chat launched without approvals,
and approvals come after the two-week trial.

Facts from the Claude Code docs are quoted from code.claude.com (channels reference, hooks
reference) as read on 2026-11-11, for the installed CLI 2.1.322.

## 0. Built, and what changed from the design (2026-11-11)

**Jeff's decisions (19:28Z, then a correction):**

1. Build it all now (A0 and A1), behind switches. Turn-on was to be two steps (Deny only,
   then Allow after about 3 clean days). **Jeff, later the same day: Allow goes on at
   go-live** ("It's just us in here"), and at 20:37Z: one go-live, after the build
   review's fixes (0.1), with no Deny-only step first. The two-flag lock stays exactly as built, because it
   is what stops Jarvis from enabling Allow himself: at go-live Jeff creates both flags.
   Deny-only first remains a documented fallback (NEXT.md §10, the runbook).
2. Approvers: his iPhone, iPad and Mac. The mark is set only on the mini, over the admin
   socket, alerted on every change; a revoke clears it.
3. OK to an async, log-only `PermissionDenied` hook telling the server when auto mode's
   classifier blocked something. Page cards are Deny-only for 15 minutes after a block in
   the lead's session. The hook only posts to the loopback-only needs-you ingest and decides
   nothing.
4. Keep Remote Control: it is a third approval surface (sections 5.2, 6.3).
5. He accepts that any surface can approve the classifier's fallback prompts.
6. The rest as recommended: the lead's session only; a Deny-only list (reworked as an
   allowlist, below); Face ID later; 10 minutes, counted from `relayedAt`; no auto-deny.

**Ultron's findings (board 5b84c006, 3bf36a61, a3e1b589, 5dff34fb, c22a5703, 3e93ecd3), as
fixed:**

| Finding | Fix |
|---|---|
| H1 a silent preview cut (3,500 in all, no marker) could push the command off the card | Channel and store keep each field whole to about 16k code points (channel 16,000; server 16,100, room for the channel's marker); anything still cut gets a marker, `cut: true`, and is Deny-only. The server parses `input_preview` into fields; the card shows `command`, `file_path`, `url`, `content` first; a preview that won't parse is Deny-only. Tested with a 3,400-code-point Bash description placed before the command, in the server, channel and e2e suites |
| H2 nothing unset the relay variable; the server had no mode | `jarvis-start` execs claude through `env -u JARVIS_CHANNEL_PERMISSION_RELAY` unless a flag allows it. Server config `chat.approvals` is `off` (default), `deny` or `on`; off answers 403 on both permission routes. Deploy order: server first, check that a verdict gets 403, then the channel |
| M3/M6 the auto-mode fallback and Remote Control were missing from the threat model | Both are in 6.3. The `PermissionDenied` hook (decision 3) opens a 15-minute Deny-only window; the card says why it is asking when a block for the same tool came just before |
| M4 under A0, Jarvis could turn Allow on himself | The channel has a deny mode (`deny`, and the old `1`, drop every Allow at delivery); `allow` needs Jeff's second flag `approvals-allow` beside `approvals-enabled`. `jarvis-start` alerts #pepper on every start with the relay on and on any change of mode; the server alerts its own mode at each start and any change. `server/config.json`, `bin/chat-pair` and `~/.local/state/jarvis-os/` are on the Deny-only list for Bash as well as Edit and Write |
| M5 G6 was a denylist | (Reworked again in 0.1: Bash is now Deny-only by default.) Bash is an allowlist: one command, none of ``; | & $ ` > < ( )``, newline, quotes, backslash, globs or braces, no `-c`, and a first word on a short list (git only with status, diff, log, show, rev-parse). Paths are normalised (`~`, `..`, case, the real path of the parent). Added: `.claude/`, `.mcp.json`, `machine-setup/git-hooks`, `~/Projects/jarvis/`, `.github/workflows`, `~/.zshenv` and the other shell startup files. Read, Glob and Grep are Deny-only for `~/.claude/channels/`, `~/.ssh`, `.env` files and keys; WebFetch for a query string or a host off a short list; unknown tools always |
| L7 repeated ids | Requests are keyed by channel session and id; a hello from a new channel process expires every open request; a repeat in one session is an unanswerable `repeat` card |
| L8 the verdict stream | A verdict line goes to the channel only when it is `from: jeff` and `meta.requestId` names its request; it carries `answeredAt` |
| L9 expiry | Counted from the channel's `relayedAt`; a request more than 2 minutes old on arrival is `late`: shown with "answer at the terminal", no buttons, no push |
| L10 ntfy shows on a lock screen | Chat alerts send ntfy only "A chat security event on the Control Room: details in #pepper"; #pepper gets the details |
| L11 the hash | `shown` = sha256 of `JSON.stringify([tool, description, inputPreview])` as delivered |
| L12 lockout and secrets | Refusals with no paired device behind them are counted apart (alerted past 10 in 10 minutes) and lock nobody out; a description that looks like a credential never reaches the disk |

**Added while building:** invisible and direction characters (U+202A-202E, U+2066-2069,
zero-width, C0 controls) are shown as `⟦U+202E⟧` and make a request Deny-only, a second line
behind Claude Code's own sanitising (a headless check showed a raw override flipping text on
the card). A flood of more than 5 open requests makes cards Deny-only for 10 minutes. The
answered card stays, saying "Allow sent from iPad at 14:02. Claude Code uses it if the prompt
was still open", until dismissed.

### 0.1 Ultron's build review, as fixed (2026-11-11, later the same day)

Ultron reviewed the build (board ac24e766, ef1b52b2, 8b305b6c, 3add3aa8, 0ed35868). **Jeff's
decisions (20:37Z):** no Deny-only go-live first ("just wait and do it all at once"): go live
once, with Allow, after these fixes pass Ultron; and page Allow for writes only inside a short
folder allowlist (his option b: "we can always change it if it's a problem"). Built on
`jos/approvals-fixes` in both repos; the channel is 0.4.4. Where this table and sections 1 to
12 disagree about the Deny-only rules, this table and README "Approvals as buttons" win.

| Finding | Fix |
|---|---|
| H-a whitespace folding: Claude Code folds each run of whitespace in a relayed preview to one space (channels reference), so `cat notes.txt` + newline + `rm -rf ~/Projects` may arrive as one "plain" command | **Bash is Deny-only on the page** (config `chat.approvalsBash`, default `"deny"`). This is the stricter of the two options, chosen because no grammar can tell `cat A B` from `cat A` + newline + `B` by the text alone. The other option is built and off: `"strict"`, a per-command grammar (a listed command; only that command's own options, exactly spelled; every other word an absolute path that passes the path rules and is not a file that can be run; no command that takes a free word, so no grep, rg, echo or which). Its known leftovers: a file made runnable between the check and the run, a number or commit id that is also a command on the path, and git reading a repo's own config. Tests use the folded form in the server suite and end to end. Section 9.2's A1-F records what a real preview looks like; until it is run, assume folding |
| H-b the long s: APFS reads ſ (U+017F) as s, so `~/.ſsh`, `~/.zſhrc` and `LaunchAgentſ` dodged every protected name; Node's `realpathSync` and `toLowerCase` don't fold it | Anything outside printable ASCII in a Bash command, a path, a Glob pattern or a Grep glob is Deny-only (file content and search text are not paths and stay free). Real paths come from `realpathSync.native`, which answers each name as the disk stores it. Tested with ſ, the Kelvin sign (K) and fullwidth letters, and with a real folder on the mini's disk (the test confirms APFS folds ſ) |
| M writes: the protected list was too short | Jeff's option b. Write, Edit, MultiEdit and NotebookEdit (and `touch`/`mkdir` under the strict grammar) can be allowed only inside config's `chat.approvalsWriteFolders`, by the path as written and by its real path. The default is no folders, so no page Allow for any write. The protected list stays as a second layer inside those folders: `.git`, `.claude`, `.worktrees`, `.mcp.json`, GitHub workflows, machine-setup, the jarvis repo, this repo's `server/`, `web/`, `bin/` and `mod/`, `server/config.json`, shell startup files, flag names. Read and write are both Deny-only for `~/.claude.json`, `~/.gitconfig`, `~/.config/git`, `~/.config/gh`, `~/.cloudflared`, `~/.aws`, `~/.docker`, `~/.local/bin`, `/opt/homebrew` and `~/.tmux.conf`, and a search rooted above any of them (`~`, `~/.config`, `/`) is Deny-only too |
| 4 Glob and Grep wildcards | Both need an absolute, literal folder (`path`); a wildcard there is Deny-only. A Glob pattern or Grep glob must be relative, with literal folder names (or a whole `**`) and wildcards only in its last part. Grep reads what its glob picks, so there the last part is a literal name or `*.ext`, never one that picks key or `.env` files |
| 5 options | The strict grammar lists each command's options; anything else (`--hostname-bin=…`, `-f/path`, `--output=…`) is refused. rg and grep are not on the list at all |
| 6 touch, mkdir, flag names | Every path in a Bash command must be absolute. The names `approvals-*`, `channel-enabled` and `*-off` are protected in any folder |
| 7 `..` | Deny-only in any path, absolute ones included |
| 8 hidden characters in parsed fields | The preview is JSON text, where a hidden character can sit as an escape (`\u202e`) that only parsing brings out. Each parsed field (names and nested values included) is checked, the card's fields go through `revealHidden`, and the request is Deny-only |
| 9 unknown input keys | Each tool has a short list of inputs it is known to take (`TOOL_KEYS`); any other key is Deny-only (`run_in_background`, `dangerouslyDisableSandbox`, …) |
| 10 the server didn't know the channel's mode | The channel sends `relay` (`off`, `deny` or `allow`) in hello and in every heartbeat. Unless it says `allow`, the server treats `"on"` as `"deny"`: the card is Deny-only ("the channel delivers Deny only") and an Allow is refused with 403. A channel that doesn't say (0.4.3 and older) counts as unknown, so Allow needs the 0.4.4 channel. A change of the reported mode is alerted |
| 12 the env variable alone turned the relay on | The channel reads the two flag files itself, by `jarvis-start`'s rule (a regular file of the owner's, not a symlink, in the 0700 state folder), and its mode is the stricter of the variable and the flags. The flags are read again for each request and each Allow, so removing `approvals-allow` stops Allow at once, without a restart. Ultron's monthly sweep now checks that no settings file sets `JARVIS_CHANNEL_PERMISSION_RELAY` |

**Known limits, accepted or for later:** a Grep rooted in a project folder can still read an
`.env` file inside it (the page can't see the folder's contents); hard links are not followed;
a path whose own whitespace was folded is shown with single spaces.

**Where:** README "Approvals as buttons" (claude-control-room) is the reference; the lead's
repo holds the channel (0.4.5 since 0.2 below) and `jarvis-start`. Sections 1 to 12 below
are the design as reviewed, corrected where the build changed it.

### 0.2 Ultron's final read, and exact Bash commands (2026-11-11, night)

Ultron read the merged build once more before go-live (board 97332dd5, bf222809, 4f52c42f)
and designed a safe way to approve shell commands (board 320ecc71). **Jeff's decisions
(21:32Z): yes to all three.** Keep the write folders he approved, but protect the code
inside them; build the exact-command hook for Bash; accept that the Discord DM has the same
folded-preview blind spot for now (the DM is the official plugin's; no work there). Built
on `jos/approvals-final` in both repos; the channel is 0.4.5. Where this section and the
ones before it disagree, this section and the README win; in particular
`chat.approvalsBash: "strict"` no longer exists as a value (a grammar over a folded
preview was never sound): the values are `"deny"` and `"exact"`.

| Finding | Fix |
|---|---|
| High (gated Allow): inside the write folders a page Allow could write code that runs later without anyone asking: a scheduled job's scripts and source, a virtualenv's `.pth`, a posting agent's drafts and `skill.md`, `CLAUDE.md`, `.gitignore`, a Worker's `wrangler.jsonc`, a workflow folder | A second layer inside the write folders, in two parts. **Generic rules** (any folder): an existing file with an execute bit; anything under `.venv`, `node_modules`, `.husky` or `.github`; the names `CLAUDE.md`, `AGENTS.md`, `skill.md`, `.gitignore`, `.gitattributes`, `.gitmodules`, `package.json`, `package-lock.json`, `pyproject.toml`, `requirements*.txt`, `setup.py`, `conftest.py`, `sitecustomize.py`, `*.pth`, `Makefile`, `wrangler.jsonc`, `wrangler.toml`, `*.plist`, `.envrc`, `_headers`, `_redirects` (and, added while building, their twins `setup.cfg`, `usercustomize.py`, `GNUmakefile`, `wrangler.json`). **Per folder:** config `chat.approvalsWriteProtected`, a flat list of absolute paths, each protecting a file or a whole folder (a repo's `src/`, `ops/`, `tests/`, `scripts/`, `launchd/`, a drafts folder a job posts from, a manifest). Both are judged on the path as written and on its real path, and a protected entry that is itself a link protects its target too. The recommended entries for the owner's folders are in the go-live runbook's config block (kept outside this public repo, see NEXT.md §10). A list the server can't read turns page writes off whole. Every write Ultron showed as allowed is a test that now says Deny-only, and the docs, notes and content files beside them still pass |
| Go-live patch (`jos/approvals-h1`, after the merge; board 97332dd5 high, 669ea1d2 medium): a Python module written beside a job's entry point is imported ahead of the standard library's (`json.py`), and `CLAUDE.local.md` is obeyed like `CLAUDE.md`; `/System/Volumes/Data/Users/…`, `/.nofollow/…`, `/.vol/…` and the like name the same files, and the real path does not fold them back, so no home-folder rule saw them | Deny-only for a write in any write folder: `*.py`, `*.pyc`, `*.pyw`, `*.so`, `CLAUDE.local.md`, `pytest.ini`, `tox.ini`, `.python-version`, and anything under `.vscode/`. Deny-only for reads, searches, writes, reply files and tier-1 Bash: any path under `/System`, `/Volumes`, `/.vol`, `/.file`, `/.nofollow` or `/.resolve`. `.dev.vars*` joins the private files. Known cost: a Python sample in a docs folder can't be allowed from the page (the terminal or Discord still can), and a search pattern whose first folder is named `system` or `volumes` is Deny-only too |
| Medium: a channel reply's `files` could attach almost any readable file to a Discord message (a shell history, say) | The page may allow `files` only inside `~/.local/state/jarvis/outbox/`, the folder made for sending, by the path as written and by its real path; anything else is Deny-only. Same rule for the Discord and the Jarvis OS reply tools |
| Lows: private reads | Added for reads and writes: `*_history` files, any `browser-profile` or `.wrangler` folder, `~/.gnupg`, `~/.config/gcloud`, all of `~/Library` (no exception was needed: a prompt for a log there can be answered at the terminal or in Discord), `~/.claude/projects` (transcripts), and the Control Room's `server/config.json` and `server/data/` |
| Lows: wide searches | A Grep or Glob rooted at `~/Projects` itself is Deny-only, as is one rooted at `~/Library` or above the Control Room's config and data (its repo root, `server/`) |
| Lows: paths | A space in a write path is Deny-only (the relay folds whitespace; a tab or a line break already was). The last part of any path is `lstat`ed and a symbolic link is Deny-only |
| Lows: write folders | A folder is refused when it is `~/Projects`, or holds or sits inside the lead's repo, machine-setup or the Control Room's `server/`, `web/`, `bin/`, `mod/`, by its real path too. The accepted list is logged at each start |
| Lows: the channel | The flag folder is found from the account's own home (`os.userInfo()`), not `$HOME`, which a settings `env` block could redirect (0.4.5). The security sweep's check now covers `settings.local.json`, the project settings under `~/Projects`, the managed settings, and the `com.jeff.jarvis*` jobs' `EnvironmentVariables`, for the relay variable, the channel's test switch and `HOME` |

**Exact Bash commands (Ultron's design).** The relay's preview folds whitespace, so it
can't say whether a command is one line or two. Claude Code's `PermissionRequest` hook does
get the tool's real input, and runs just before the prompt. Section 3.2 explains why that
hook was not chosen to *decide* anything, and that stands: this one only reports.

1. **The hook never decides.** It prints nothing, always exits 0, has the matcher `Bash`
   only, is not `async`, sets no `onFailure`, and is limited to 3 seconds (its curl to 2).
   The hooks reference: "Exit code 0 with no output means the hook has no decision to
   report, so the tool call continues through the normal permission flow", and a timed-out
   hook "renders no decision". No report at the server means Deny-only on the page. The
   entry is in the README; the suite runs that very command against a scratch server.
2. **Matching is by content.** The relay carries no id the hook also sees, so the server
   (`lib/exact-commands.mjs`, `lib/approvals.mjs`) takes the reports from the lead's session
   (by its roster name, never "a session nobody can name") that arrived from 30 s before
   the channel got the prompt to 5 s after, and keeps those whose text, under the server's
   own fold (each run of whitespace to one space, nothing trimmed), equals the preview's
   command character for character. Pepper's addition: a report that equals the preview
   outright also counts, for a relay that did not fold; it is the stronger match, not a
   looser one. Exactly one distinct text is the match. Two that differ are Deny-only and
   alerted (`approvals-exact-conflict`).
3. **A forged report can only tie.** Any local process can post to the loopback ingest.
   Its text either equals the real report (the same candidate) or differs (two candidates:
   Deny-only, alerted). The check runs again at each look and at the Allow tap, so a second
   report that lands after the card opened is caught too, and the card then stays Deny-only.
   A real command that can't be shown (below) still counts as a candidate, so a forged
   plain copy of it ties as well. What is left: a forged report while the real hook failed
   to post at all (it timed out, or the entry was removed), which the sweep's "the hook is
   present and unchanged" check and the 3-second limit narrow, and which is the same
   same-user trust as section 6.3's last rows.
4. **No hook may return `updatedInput`.** A hook that rewrites the input would change the
   command after the card showed it. The security sweep checks that no other
   `PermissionRequest` hook exists and that no hook command contains `updatedInput`, and
   that this entry is present and unchanged.
5. **What may be shown.** The exact text must be printable ASCII plus line breaks and tabs
   (a carriage return is refused), and the preview must carry no elision and no
   `[REDACTED]` mask; otherwise the card gets no exact text and is Deny-only. A report is
   kept in memory only, for the lead's session only, for 2 minutes, at most 40, and never
   logged; a matched text stays with its open request and is dropped when that closes.
6. **The card** shows the exact text first, one row per line, with `↵` where a line ends
   and `⇥` for a tab, and says how many lines there are. The `shown` hash covers it: a tap
   that hashed only the preview is refused (409).
7. **Policy.** `chat.approvalsBash` is a mode: `"deny"` (the default; no report is even
   kept) or `"exact"`. In `"exact"`: tier 1, one line that passes the strict grammar, which
   is sound now that the line breaks are known; tier 2, a text equal to an entry of
   `chat.approvalsBashCommands` (empty by default), line breaks included; everything else
   Deny-only on the page until Face ID per Allow (Phase C).
8. **Install.** The README has the entry. Jarvis adds it with Jeff after Ultron has
   re-read it; the server takes reports only in `"exact"` mode, so the two switches are
   independent and the hook alone turns nothing on.
9. **Proof before `"exact"` is used.** Section 9.2's A1-H: a scratch session shows that the
   hook's post lands before the relayed request, in auto mode's fallback prompts too, and
   that the two folds agree on tabs, CRLF and leading and trailing spaces. If either fails,
   nothing matches and Bash stays Deny-only: a miss is never an Allow.

**Known limits, accepted or for later:** the Discord DM still shows the folded preview
(Jeff's third yes); a Grep rooted in a project folder can read an `.env` or a protected
file inside it; tier 1 leaves a file made runnable between the check and the run, and git
reading a repo's own config; trailing spaces in the exact text are not drawn; a hard link
is not followed.

### 0.3 The channel's test switch (channel 0.4.6, after Ultron's 0.4.5 re-vet)

Ultron's re-vet of channel 0.4.5 (2026-11-11, board 1bede46d, medium; not exposed on the
mini that day): `JARVIS_CHANNEL_TEST=1` with `JARVIS_CHANNEL_FLAGS_DIR` moved the folder the
approvals flags are read from, on a channel that could still be talking to the real
Control Room. A settings `env` block could so supply both flags itself. Closed in four
places, staged 2026-11-11 on `jos/channel-046` in both repos:

| Where | What changed |
|---|---|
| The channel, 0.4.6 (the lead's repo) | The test switch counts only when the socket is not the account's own: not `channel.sock` in the account's `~/.local/state/jarvis-os`, nor any other name in that folder, by the path and by what is on disk (a symlink, a hard link, another spelling of the folder, another letter case). Pointed at the real socket the switch is ignored and logged, and the flags, the socket and the timings are production's. Under the switch the same question is asked again before every hello. `POST /v1/hello` carries `test: true` or `test: false`. |
| The launcher (the lead's repo) | `jarvis-start` unsets `JARVIS_CHANNEL_TEST`, `JARVIS_CHANNEL_FLAGS_DIR` and `JARVIS_OS_SOCKET` on claude's exec, as it already unset the relay variable, so nothing left in tmux's or launchd's environment reaches the channel. |
| This server | A hello whose `test` is anything but `false` caps the page at Deny only, whatever relay mode it reports: mode `"on"` counts as `"deny"`, the card says "the channel runs in test mode", an Allow is refused with 403, and each such hello is alerted (`approvals-test-channel`). A hello with no `test` is a channel before 0.4.6 and is treated as before, so the server and the channel can be released in either order. |
| The sweep (the lead's repo) | Its check of settings `env` blocks and launchd jobs adds `JARVIS_OS_SOCKET`, and it hands Jarvis one command for tmux's global environment, which the unattended run can't read. |

The scratch harness is the one place a test channel may still be allowed from: it builds the
gate itself with `testChannelOk: true`, in code, because every channel it serves runs under
the switch (section 9.2's sessions among them). No config key reaches that option, and
`CCR_REFUSE_TEST_CHANNEL=1` makes the harness behave as the real server does.

Left over from the related low (board 182771a1): the sweep reading hooks in agent and skill
frontmatter, and `env` set in shell startup files. Both are sweep-prompt work that needs a
way to list those files inside an unattended run.

## 1. In short

1. **Most of it is already built and switched off.** The Jarvis OS chat has permission cards
   with Deny and Allow once, a single-use verdict route, an urgent "Jarvis needs an approval"
   push, and a #pepper alert on every verdict naming the device. The channel plugin can relay
   prompts and deliver verdicts. One switch keeps all of it dark: the channel never declares
   the permission capability, because `jarvis-start` never sets
   `JARVIS_CHANNEL_PERMISSION_RELAY=1`.
2. **So this design is mostly about turning it on safely,** plus seven gaps the code still has
   (section 5.4): a kill switch, stricter Origin and rate limits on the verdict route, binding
   a tap to exactly what the card showed, dropping late verdicts, a short list of things the
   page may only Deny, a per-device "may approve" mark, and honest wording, because the page
   can never know whether its answer was the one Claude Code used.
3. **The mechanism is Claude Code's own channel permission relay, not a hook.** Claude Code
   sends the same prompt to the terminal, to the Discord channel and to ours at once, applies
   whichever answer arrives first, and drops the rest. The old §5.8 plan (a `PermissionRequest`
   hook that polls the server) is retired for Jarvis's session: a hook is global, can grant
   permission in every session on the mini, and a bug in it is a bypass.
4. **Only Jarvis's own session.** The relay reaches only the session that loaded the channel.
   Headless runs and routines keep denying what they can't do, as today.
5. **Both slices are built; Allow goes on at go-live** (Jeff, 2026-11-11). Deny only (mode
   `deny` and the single flag) stays available as a fallback: it proves the whole path
   while granting nothing.

The key risks, in one line each: a stolen or unlocked phone can approve (mitigations: the
"may approve" mark, the Deny-only list, an alert per verdict, later Face ID); a prompt-injected
session can describe a dangerous command in friendly words (mitigation: the card leads with
the real command, never with the model's description); and the page may say "Allowed" for an
answer Claude Code ignored (mitigation: it says "sent", never "done").

## 2. How a permission prompt reaches Jeff today

- **Jarvis runs in a tmux session on the mini,** in auto mode, started by
  `~/Projects/jarvis/bin/jarvis-start` with two channels:
  `--channels plugin:discord@claude-plugins-official plugin:jarvis-channel@jarvis-local`
  (the second only while `~/.local/state/jarvis-os/channel-enabled` exists; it does today).
- **When a tool call needs approval,** the terminal dialog opens in that tmux pane, and the
  official Discord plugin DMs Jeff "Permission: <tool>" with See more, Allow and Deny buttons
  (plugin 0.0.4, `server.ts`). A tap sends the verdict; the DM's buttons are replaced by
  "Allowed" or "Denied".
- **The Jarvis OS channel declares no relay.** Its `initialize` answer omits the
  `claude/channel/permission` key (channel `server.mjs`, "Permission relay is OFF by default
  (Ultron's condition for C4)"). It is declared only when the env variable
  `JARVIS_CHANNEL_PERMISSION_RELAY=1` is set *and* the launch guard passes. `jarvis-start`
  never sets it (go-live doc §1, "Unchanged"), and the reviewed `.mcp.json` may carry no `env`.
  The go-live test §3.5 checks that it stays off.
- **Why it's off:** Ultron, 2026-11-10 (board 09248dc0): with relay on, a tap on any paired
  device approves any tool in Jarvis's session, and any process running as Jeff that grabs the
  socket could try to approve too. Jeff, 11-11: launch the chat without approvals, add them
  after the two-week trial. The prerequisites Ultron named (Host allowlist, per-verdict alert,
  strict CSP, no socket takeover; board e8d3ef26) are built.
- **What the needs-you hook adds (live 11-11):** Claude Code's `Notification` hook posts
  `permission_prompt` waits to `/api/ingest/needs-you`, so the home screen shows "Jarvis is
  waiting on a permission" with a link to Discord, and a wait over 5 minutes pushes as a count.
  It carries no tool, no input, no text (README "A session waiting on you").

### 2.1 What is built and waiting (claude-control-room main, cb4f470)

| Piece | Where | State |
|---|---|---|
| Socket route `POST /v1/permission-request {requestId, tool, description, inputPreview}` | `server/lib/chat-socket.mjs` | Built; needs the session token; stores the request and alerts `permission-opened` (log only) |
| Store: request in memory with `open/allowed/denied/expired`, 10-minute expiry, preview dropped after 24 h; a `permission` message (the description) and a `verdict` message (device) on disk | `server/lib/chat-store.mjs` | Built; first answer wins inside the store |
| Page route `POST /api/chat/permission/<id> {behavior}` | `server/lib/chat-routes.mjs` | Built: `guardWrite` (JSON, no cross-origin), `requireDevice` (owner login + paired cookie), single use, logged |
| Verdict line to the channel `{"type":"verdict", seq, requestId, behavior}` | inbound stream | Built; the socket itself can never make one |
| Channel: relay the request, deliver a verdict only for an id it relayed and hasn't answered | channel `server.mjs`, `onPermissionRequest`, `deliverVerdict` | Built, dormant (relay off) |
| Card in the Chat tab: tool, description, input preview, Deny and Allow once, expired note | `web/src/orbit/Chat.jsx`, `PermissionCard` | Built, never shown live |
| Push "Jarvis needs an approval", urgent, Topic `jos-approval`, no text, one per device per 15 s | `server/lib/chat-push.mjs` | Built |
| Alert per verdict naming the device and tool, never rate-limited | `server/server.mjs` `chatEvents`, `chat-alert-limit.mjs` | Built |

## 3. What Claude Code offers

### 3.1 The channel permission relay (chosen)

From the channels reference, "Relay permission prompts":

- "When Claude calls a tool that needs approval, the local terminal dialog opens and the
  session waits. A two-way channel can opt in to receive the same prompt in parallel ... Both
  stay live: you can answer in the terminal or on your phone, and Claude Code applies whichever
  answer arrives first and closes the other."
- It covers tool approvals (Bash, Write, Edit, MCP tools). "Project trust and MCP server consent
  dialogs don't relay."
- Since v2.1.234 it goes only to servers registered as channels for the session (`--channels`
  plus the allowlist), and only if the server declares the capability.
- The request: `request_id` (five letters a-z without l), `tool_name`, `description` ("Claude's
  description of the command ... never the command itself"; for Bash with none, the constant
  "Run shell command"), `input_preview` (the arguments; for Bash the command, for Write the
  path and content).
- Since v2.1.211 both text fields are sanitised: direction overrides, invisible characters and
  quote and angle-bracket lookalikes neutralised, whitespace folded, and a value over 3,500 code
  points sent as its start and end around "⋯ N code points elided ⋯". Since v2.1.234,
  recognisable provider credentials are masked as `[REDACTED]`, but "a mask can't hide the
  command, file path, or destination being approved", and secrets without a known prefix
  arrive unmasked. "Treat both fields as untrusted."
- The verdict: `{request_id, behavior: allow|deny}`. "Neither verdict affects future calls":
  there is no "always allow" in the relay.
- Claude Code accepts a verdict only for an id it issued and that is still open. If an id
  repeats within a session, "Claude Code drops any channel verdict carrying it". Unknown,
  answered or repeated ids are dropped silently, with no error back to the channel.
- "Only declare the capability if your channel authenticates the sender, because anyone who
  can reply through your channel can approve or deny tool use in your session."

**What the docs don't say (to test, section 8):** whether every declaring channel gets the
request when two are registered (spec item "[U] two channels", never tested); whether a
subagent's prompt inside Jarvis's session relays; how long Claude Code keeps a relayed request
open (no timeout is documented; the terminal dialog waits indefinitely); and there is **no
"closed" signal**: a channel is never told that the terminal or another channel answered.

### 3.2 The `PermissionRequest` hook (not chosen for the lead)

From the hooks reference: it "runs when Claude Code is about to ask you for permission",
receives `tool_name`, the full `tool_input`, `session_id`, `agent_id` and `agent_type` (for a
subagent), and `permission_suggestions`; it can return `allow` (with `updatedInput` and
`updatedPermissions`, which can add rules or change the mode) or `deny`. Its default timeout is
600 s; a timed-out hook "renders no decision". In sessions that can't prompt (headless
background agents) "if no hook returns a decision, it denies the tool call".

Why not for Jarvis's session: hooks live in settings and are global; a bug that prints `allow`
grants in every session on the mini; `updatedPermissions` can widen permissions for good; and
the docs don't settle whether the terminal dialog stays live while a hook waits. The relay
has none of those problems and is already built on both ends. The hook stays on the shelf for
headless runs, where the decision (section 4) is "not now".

### 3.3 The `Notification` hook (already used)

`permission_prompt` fires "only after the prompt has waited about six seconds", with no tool
or input. It stays what it is: the home screen's "Jarvis is waiting" signal, and (section 5.5)
the way the card learns that Jarvis has probably moved on.

## 4. Which sessions' prompts appear

| Session | Prompts appear on the page? | Why |
|---|---|---|
| Jarvis's lead session (tmux, both channels) | **Yes** | The only session that loads the channel |
| A subagent inside Jarvis's session (Pepper, Ultron, ...) | Probably, unverified | Its prompt is shown in the lead's terminal dialog, so it should relay; test A0-3 settles it. The relay doesn't say which agent asked |
| Headless `claude -p` runs (routines, the usage poll) | **No** | They can't prompt; with no hook they deny, which is the safe default. All pass `--permission-mode manual` |
| Jeff's own terminal sessions on the mini | No | No channel loaded |

Recommendation: the lead session only (decision 2). Approving headless runs would need the
global hook of 3.2, which is the exact risk this design avoids.

## 5. The flow end to end

### 5.1 The happy path

1. Jarvis (or a subagent in its session) calls a tool that needs approval. Claude Code opens
   the terminal dialog and sends `permission_request` to **both** channels at once.
2. **Discord:** the official plugin DMs Jeff with See more, Allow and Deny. Unchanged.
3. **Jarvis OS:** the channel checks the id, caps each field at 3,500 code points, and posts
   `POST /v1/permission-request` over the 0600 socket with its session token.
4. The server checks the kill switch (5.4 G1), stores the request (open, 10-minute page
   expiry), appends the `permission` line, emits `permission` on every paired device's SSE
   stream, and pushes "Jarvis needs an approval" (urgent, no text) to each device.
5. Jeff taps the push. The app opens at `#chat`; the card is pinned above the composer (5.3).
6. Jeff taps **Deny** or **Allow once** (Allow is a two-step press, 5.3). The page sends
   `POST /api/chat/permission/<id>` with `{behavior, shown}`, where `shown` is a hash of the
   tool, description and preview it displayed.
7. The server checks, in order: owner login, paired cookie, the device's "may approve" mark (for
   allow), Origin, rate limits, the kill switch, that the request is open, that `shown`
   matches, and the Deny-only list (for allow). Any failure answers an error and changes nothing.
8. It marks the request answered, appends the `verdict` line (device, behavior, tool, preview
   hash), emits `permission-closed` to every device, logs one line and sends the #pepper alert
   naming the device.
9. The verdict line reaches the channel on its inbound stream. The channel drops it if it is
   older than 120 s (5.4 G4) or for an id it didn't relay or already answered; otherwise it
   sends `notifications/claude/channel/permission` to Claude Code.
10. Claude Code applies it if the prompt is still open: the terminal dialog closes and the
    tool runs (or is refused). If the terminal or Discord answered first, it drops ours
    silently.

### 5.2 First answer wins: every race

| What happens | Result in Claude Code | What the page shows | What Discord shows |
|---|---|---|---|
| Page answers first | Page's answer applies | "Allow sent from iPhone 14:02" | The DM keeps live buttons; a later tap there does nothing (Claude Code drops it) but the plugin still labels the DM "Allowed" |
| Discord answers first | Discord's applies; ours, if sent later, is dropped | Card stays open until the move-on signal (5.5) or 10 minutes; a tap then says "sent" and does nothing | Allowed/Denied |
| Terminal answers first | Terminal's applies | As for Discord | Live buttons, no effect |
| Remote Control answers first (claude.ai or the app, `--remote-control`) | Its answer applies, like the terminal's | As for Discord | Live buttons, no effect |
| Two paired devices tap at once | One verdict reaches the channel | The second tap gets 409 "already allowed by iPad" | Unchanged |
| Nobody answers in 10 minutes | Prompt still open in terminal and Discord | Card goes grey: "Expired here. Answer in Discord or at the terminal." No buttons | Live buttons |
| The channel restarts while a request is open | The prompt stays open; the new channel process never relayed it | The server's card stays until 10 minutes; a verdict sent is dropped by the new process (unknown id) | Unaffected |
| The Control Room is down | The channel spools the request and retries for 10 minutes | Card appears late, if at all | Unaffected |

The Discord plugin isn't ours (it's the official plugin, and Jarvis's area), so its stale
buttons stay; the README will say so plainly.

### 5.3 The card

Plain-language rules, then the details.

- **Lead with the real thing.** The card shows, top to bottom: the tool name; the input
  preview (the actual command, path or content) in a monospaced box that wraps, never
  truncated by the page; then the description, under a small label "Jarvis's own summary", in
  a quieter style. The description is the model's words and is exactly what a prompt
  injection would make sound harmless; the preview is what will run.
- **Mark what the page can't vouch for.** An elision marker ("⋯ N code points elided ⋯"),
  `[REDACTED]` and `(value unserializable)` are highlighted with one line of explanation
  ("Part of this command is hidden"). Any of them puts the request on the Deny-only list.
- **Text stays text.** Every field is rendered as a React text node in a `<pre>` or `<p>`:
  never Markdown, never a link, never HTML. The chat's Markdown renderer is not used on cards.
  Claude Code has already neutralised direction overrides and lookalikes; the page adds nothing
  that could reinterpret them.
- **Deny is the easy button.** Deny on the left, plain, one tap. Allow once on the right, with
  a two-step press: the first tap turns it into "Tap again to allow" for 4 seconds. No button
  has focus when the card appears, and Enter does nothing on the card.
- **No "always allow", ever.** The page never offers a rule, a mode change or "for this
  session". The relay has no way to send one anyway.
- **Say "sent", not "done".** After a tap the card reads "Allow sent from <device> at 14:02.
  Claude Code uses it if the prompt was still open." The page can't know more (3.1).
- **Deny-only cards** show the preview and a Deny button, and in place of Allow: "Allow this
  one at the terminal or in Discord."
- **Age and expiry** stay as built ("3 min ago", grey at 10 minutes, Dismiss).
- **Lock screen:** the push says only "Jarvis needs an approval". No tool, no text.

### 5.4 The gaps to close (G1 to G7)

- **G1. Two switches, both needed, and a kill switch.** (As built: the channel has two
  modes, `deny` from `approvals-enabled` and `allow` only with Jeff's second flag
  `approvals-allow`; without a flag the variable is unset on claude's exec; section 0.) The channel relays only when
  `jarvis-start` finds a new flag file, `~/.local/state/jarvis-os/approvals-enabled` (same
  rules as `channel-enabled`: a regular file of Jeff's, 0600, in the 0700 folder, no
  symlink), and then sets `JARVIS_CHANNEL_PERMISSION_RELAY=1` on claude's own exec beside
  `JARVIS_CHANNEL_LAUNCH`. The server shows cards only when config `chat.approvals` is `"deny"`
  (slice A0) or `"on"` (A1); anything else is off. While off, `/v1/permission-request` answers
  403 (the channel reads a 4xx as final and stops retrying, so the prompt simply stays in the
  terminal and Discord) and the verdict route answers 403. A kill file,
  `~/.local/state/jarvis-os/approvals-off`, checked on every request, turns the page side off
  without a restart; Jarvis or Jeff can `touch` it from any shell. Rollback of the channel side
  is `rm` the flag and `jarvis-start --restart`.
- **G2. A stricter verdict route.** On top of `guardWrite` and `requireDevice`: an `Origin`
  header is required (a verdict without one is refused, unlike other writes) and must be an
  https origin in `allowedHosts`; `Sec-Fetch-Site`, when sent, must be `same-origin`. Rate
  limits per device: 6 verdicts a minute and 30 an hour; 10 refused verdicts (400, 404, 409,
  403) in 10 minutes lock that device out of verdicts for 10 minutes and alert. More than 3
  allows in 5 minutes from any devices alerts once (a burst of allows is the stolen-phone
  pattern).
- **G3. Bind the tap to the card.** The page sends `shown`, the sha256 (hex) of
  `tool + "\n" + description + "\n" + inputPreview` exactly as the SSE event delivered them.
  The server compares it with its own; a mismatch is 409 "the request changed; reload". This
  closes the case where the page holds stale data for an id (see G5) and makes the audit line
  say exactly what was approved.
- **G4. Late verdicts die.** The verdict line gains `answeredAt` (ms). The channel drops a
  verdict more than 120 s old at delivery, and forgets a relayed request after 11 minutes
  (today 60), one minute past the page's expiry, so no verdict can reach Claude Code for a
  prompt the page has already shown as expired. A channel that comes back after an outage
  therefore never replays an old Allow into a prompt that has sat open since.
- **G5. A repeated id.** Today `openPermission` returns the old entry if an id it has seen in
  the last 7 days comes again, so a new prompt with a reused id would show the old request's
  state. Claude Code drops channel verdicts for a repeated id anyway. Fix: a repeated id opens
  a fresh entry marked `repeat`, shown with no buttons at all: "This one can only be answered
  at the terminal" (Discord's verdict would be dropped too).
- **G6. A Deny-only list.** (As built it is an allowlist, Ultron M5: section 0 and README
  "Approvals as buttons" hold the rules; the denylist below is the reviewed draft.) The page may Deny anything but may Allow only what passes a
  server-side check, written as code with tests and extendable from config. The page refuses
  Allow (403 "answer this one at the terminal or in Discord") when:
  - the preview carries an elision marker, `[REDACTED]` or `(value unserializable)`;
  - the tool is Bash and the command mentions any of: `sudo`, `launchctl`, `security`,
    `tailscale`, `defaults write`, `csrutil`, `crontab`, `ssh`, `scp`, `git push`, `gh `,
    `rm -r`/`rm -f` outside the scratchpad, `chmod`/`chown`, a pipe into `sh`/`bash`/`zsh`/
    `python`/`node`, `curl`/`wget` with `-d`, `-X POST/PUT/DELETE` or `--upload-file`, `eval`,
    or `osascript`;
  - the tool is Edit, Write or NotebookEdit and the path is under `~/.claude/`,
    `~/Library/LaunchAgents/`, `/Library/`, `~/.ssh/`, `~/.local/state/jarvis-os/`, a shell
    rc file, or any `.git/` folder;
  - the tool name is not one of Bash, Read, Edit, Write, NotebookEdit, WebFetch, WebSearch,
    Glob, Grep, or an `mcp__` tool of the two channels (anything new is Deny-only until it is
    added on purpose).
  This is not a security boundary (a command can be spelled to dodge any list); it makes the
  riskiest common requests need the terminal, so a stolen phone or a careless tap can't grant
  them. Discord can still allow them; that path is today's and is unchanged by "both".
- **G7. A per-device "may approve" mark.** Each device in `devices.json` gains
  `approver: false` by default. Only the mini can set it, over the admin socket:
  `bin/chat-pair approver <device name> on|off`; each change is an alert. Every paired device
  sees cards and may Deny; only a marked device may Allow. Jeff marks his iPhone and leaves the
  iPad off, for instance (decision 7).

### 5.5 Ties to the needs-you hook

- The home screen's "Jarvis is waiting on a permission" card links to `#chat` ("Answer ›")
  while a page card for that wait is open, and to Discord otherwise.
- **The move-on signal.** The needs-you ingest already sees `PostToolUse`, `UserPromptSubmit`
  and `Stop` from the lead's session. When the lead's session posts any of them after a
  request opened, the server marks the open request `probably-answered` (not closed): the card
  dims and reads "Jarvis has moved on; this was probably answered in Discord or at the
  terminal". Buttons stay, since a tap is harmless if the prompt is gone (Claude Code drops it)
  and the guess may be wrong (a subagent's tool use can post while the lead's prompt waits).
  No session id or path reaches the page; the match is the roster name the ingest already
  computes.
- Board b534203c (a #jarvis ping when a prompt sits unanswered) stays separate and useful:
  it covers the case where Jeff sees neither the push nor the DM.

## 6. Security

### 6.1 The trust model, plainly

A tap on a paired device counts the same as a tap in Jeff's Discord DM (Shuri's spec, "Approval
taps"). The design aims to make that true and no more: the page should not be *easier* to abuse
than the DM, and abuse of either should be visible within seconds. It does not try to stop a
process already running as Jeff on the mini: that process can edit settings, kill the channel or
type into tmux, so the approvals path is not its easiest route. The aim there is that using the
page leaves a trail.

### 6.2 Controls

| Control | Built | New here |
|---|---|---|
| Tailnet only; server binds 127.0.0.1; Serve HTTPS; Host allowlist enforced | Yes | |
| Owner login (`Tailscale-User-Login` = `chat.login`) and the `__Host-jos` cookie (HttpOnly, Secure, SameSite=Strict, sha256 stored), at most 4 devices, revoke | Yes | |
| CSRF: JSON only, cross-origin refused | Yes | Origin required on verdicts; `Sec-Fetch-Site` checked (G2) |
| Strict CSP, no inline script (an XSS on the origin would be approval power) | Yes | Cards never pass through the Markdown renderer |
| Single use, first answer wins, 10-minute page expiry | Yes | Late verdicts dropped by the channel (G4); repeated ids (G5) |
| Deny by default | Partly: nothing is allowed without a tap | No auto-answer of any kind; expiry sends nothing; every failure answers an error and changes nothing; A0 has no Allow at all |
| No "always allow" | The relay can't carry one | The page never offers one |
| Shows exactly what is approved | Card shows tool, description, preview | Preview first; markers highlighted; `shown` hash (G3); Deny-only list (G6) |
| Replay protection | Store state; the socket can't make a verdict | `shown` hash, `answeredAt` with the 120 s cut (G4) |
| Rate limits | Push window only | Per-device verdict limits, refusal lockout, allow-burst alert (G2) |
| Audit | Verdict line in the JSONL store with the device; log line; #pepper alert per verdict | Verdict meta adds tool, preview hash, Deny-only flag; refused allows logged; the alert line names device, behavior and tool |
| Who may grant | Any paired device | Only devices marked `approver` (G7) |
| Off switches | Relay env never set | Flag file, config mode, kill file (G1) |

### 6.3 Threats

| Threat | What it could do | What stops or shows it |
|---|---|---|
| **A stolen, unlocked phone** (or Jeff's phone handed to someone) | Open the installed app and tap Allow on whatever Jarvis is asking | It must be on Jeff's tailnet with his login; only `approver` devices can Allow; Deny-only list; every verdict alerts #pepper and ntfy naming the device; revoke from another device or the mini kills its cookie and closes its streams; the iPhone's own lock and, later, Face ID per Allow (Phase C). Note: the same phone's Discord app can already approve today |
| **A stolen cookie** (copied from a backup or a compromised browser) | Approve from another tailnet device | Needs the owner's tailnet login too; rate limits; alerts; the hash in `devices.json` can't be turned back into a cookie |
| **A prompt-injected session** (a web page or file tells Jarvis to run something harmful, and Jarvis describes it as "tidy the build folder") | Get Jeff to approve a dangerous command from a friendly description | The card leads with the real command and labels the description as Jarvis's own words; hidden parts are flagged and Deny-only; the riskiest commands are Deny-only; Claude Code's sanitising removes lookalike and invisible characters; the chat's instructions say a chat "yes" is never an approval |
| **Injected text aimed at the page** (a preview carrying HTML, script, a fake "Approved" line or a link) | Spoof the card or run script on the origin | Fields rendered as text nodes only, no Markdown, no links; strict CSP; Claude Code folds whitespace so a preview can't fake new card lines |
| **A stale tab** (an iPad left open on an old card) | Answer a request that has closed or changed, or approve the wrong thing | Server-side state wins: closed ids answer 409; `shown` must match; late verdicts die at the channel; the card closes on `permission-closed` and on a stream restart with zero open requests (built); "probably answered" dims it |
| **Auto mode's fallback prompts** (Ultron M3) | In auto mode most of Jarvis's prompts follow a classifier block: the action auto mode refused is put to a person. Any surface (terminal, Discord, Remote Control, the page) can approve it | Jeff accepts this (decision 5). The `PermissionDenied` hook makes page cards Deny-only for 15 minutes after a block in the lead's session, so the page can't approve the action auto mode just refused; the card says why it asks; the terminal, Discord and Remote Control can still approve, as today |
| **Remote Control** (Ultron M6) | A third surface with Jeff's claude.ai sign-in: anyone holding that session can answer prompts | Not changed by this design (decision 4). Its sign-in is Anthropic's; the page adds no new path to it |
| **A malicious local process running as Jeff** | Forge `Tailscale-User-Login` toward 127.0.0.1; take the socket; write `devices.json`; run `bin/chat-pair` | Same-user trust is mitigated, not removed (spec "Risks"). It needs a paired cookie it can't read (only hashes on disk); the socket can't make a verdict; a takeover needs a stale heartbeat and alerts; pairing and approver changes alert; it could more easily change settings or kill the session, so this path adds little. A cookie-less forged verdict gets 401 and counts toward the lockout |
| **A rogue channel process** (something else says hello on the socket) | Inject a fake permission request to trick Jeff into a tap | Its requests could show as cards, but a verdict for an id Claude Code didn't issue is dropped by Claude Code; the takeover alert names it; the launch guard and reviewed hash protect the real channel |
| **Flooding** (a looping session or a hostile process opening many requests) | Wear Jeff down into tapping Allow | The channel keeps at most 50 pending; the push window (15 s); the page shows open cards newest first with a count; a burst of more than 5 open requests switches the page to Deny-only for 10 minutes and alerts |
| **Push content leaking on the lock screen** | Show what Jarvis is doing | The body is only "Jarvis needs an approval" |
| **Secrets in a preview** | A command with an unprefixed secret reaches the page and the store | The preview stays in memory only and is dropped after 24 h (built); it's never pushed; the description (model text) is on disk as today. Low, optional: run the server's `secret-shape` check over the preview and flag it on the card |

## 7. What changes where

| Where | Owner | Change |
|---|---|---|
| Channel plugin (`jarvis-local/plugins/jarvis-channel/server.mjs`) | Jarvis (Ultron reviews) | G4: honour `answeredAt` (drop after 120 s), forget relayed requests after 11 minutes. Nothing else: relay is already built. A new reviewed-manifest hash follows, which Jeff or Vision records |
| `bin/jarvis-start` | Jarvis (Ultron reviews) | G1: the `approvals-enabled` flag and `JARVIS_CHANNEL_PERMISSION_RELAY=1` on claude's exec; the log line says "permission relay on/off"; tests that no flag means a byte-identical command |
| Chat server (`chat-socket.mjs`, `chat-store.mjs`, `chat-routes.mjs`, `chat-devices.mjs`, admin router) | Pepper | G1 mode and kill file; G2 Origin, rate limits, lockout, burst alerts; G3 `shown`; G4 `answeredAt` on verdict lines; G5 repeated ids; G6 the Deny-only check; G7 `approver` and its admin command; audit meta; `probably-answered` from needs-you |
| Needs-you (`needs-you.mjs`) | Pepper | Expose "the lead moved on" to the chat store; the home card's link to `#chat` |
| Page (`Chat.jsx`, `chat.js`, the home card) | Pepper | Card layout (preview first, markers, labels), two-step Allow, Deny-only variant, "sent" wording, `shown` hash, A0 build with no Allow |
| Push (`chat-push.mjs`) | Pepper | None. Already urgent, generic and capped |
| Discord plugin | Not ours | None. It keeps relaying as today |
| `config.json` | Jarvis writes it | `chat.approvals: "off"` (default), `"deny"`, `"on"`; optional `chat.approvalsDenyOnly` extra patterns |
| `~/.claude/settings.json`, managed settings | Jeff, Vision | **None needed.** The channel is already on the managed allowlist; no hook is added; nothing in user settings changes |
| Jeff | | Creates the `approvals-enabled` flag file (a settings change, so his OK); marks his approver device(s) with `bin/chat-pair approver`; the restarts below |
| Restarts | Vision/Jeff (Control Room LaunchAgent), Jarvis/Jeff (`jarvis-start --restart`) | One of each per slice |

## 8. Phases

Each phase: build on a branch, Ultron reviews, Jeff's C&P, restarts, then the live checks.
Timing follows Jeff's word on board 09248dc0 (approvals after the two-week trial, about
2026-11-25) unless he changes it (decision 1).

### Phase A0: Deny only (the first slice)

What ships: G1 (switches, mode `"deny"`), G2 (Origin, limits), G3 (`shown`), G4 (late
verdicts), G5 (repeated ids), audit meta, the new card layout with Deny and no Allow, the
"sent" wording, the home card's link. The verdict route refuses `allow` outright in this mode.

Why first: it turns on every moving part (the relay, the two-channel fan-out, the card, the
push, the verdict path, the race, the alerts) and can grant nothing. A stolen phone could deny
Jarvis's requests, which is an annoyance Jeff would see in #pepper at once.

Effort: S to M. Most of it is server checks and their tests; the channel change is a few lines.

### Phase A1: Allow once

What ships: mode `"on"`, G6 (Deny-only list), G7 (`approver`), the two-step Allow, the
allow-burst and flood rules. Starts after A0 has run clean for at least three days of real
prompts and Ultron has re-read it.

Effort: M.

### Phase B: knowing more

- The move-on signal from needs-you (5.5), if A0 shows that cards answered in Discord linger
  and confuse.
- The secret-shape flag on previews.
- Optional: which agent asked. An `async` `PermissionRequest` hook (it can't decide, only
  report) could post `agent_type` and `tool_name` so the card says "Pepper asks". It needs a
  settings line from Jeff and fuzzy matching on tool and time (the relay carries no session
  or agent), so it is worth it only if A0/A1 show Jeff wants it.

### Phase C: Face ID per Allow (decision 4)

WebAuthn with `userVerification: "required"` against a platform passkey made on each approver
device: Allow sends an assertion over the request id and `shown` hash, verified on the server
with node:crypto (ES256, attestation "none", a small CBOR reader, no dependency). It turns "an
unlocked phone" into "an unlocked phone and Jeff's face". Needs HTTPS (live). Effort M; its own
Ultron review (new crypto parsing).

### Not in any phase

Approving headless or other sessions; "always allow" or any rule change; running jobs
(`launchctl` stays Vision's); auto-deny on timeout; changing the Discord plugin.

## 9. Tests and verification

### 9.1 Automated (scratch servers only, never :8322)

- **Server unit tests, in local time and Tokyo:** each switch state (off, deny, on, kill file)
  on both routes; Origin missing, foreign, `null`, http, wrong host; `Sec-Fetch-Site`
  cross-site; no cookie, revoked cookie, wrong login; non-approver allow; rate limits at the
  edges (6th and 7th in a minute); the lockout and its alert; the burst alert; `shown` match,
  mismatch and missing; expired, answered and unknown ids; a repeated id; each Deny-only rule
  (both sides of each pattern, plus a marker in each field); `answeredAt` on verdict lines;
  audit meta on disk; the alert text names device, behavior and tool and never the preview.
- **Mutations:** the usual pass over the new checks; every guard must have a test that fails
  when it is removed (lesson from the events work: test with an inherited object-valued key
  where `hasOwn` matters).
- **Channel tests (Jarvis):** a verdict 119 s and 121 s old; a request forgotten at 11 minutes;
  relay off when the env is absent; nothing else changed in the reviewed hash's file set.
- **jarvis-start tests (Jarvis):** no flag gives today's exact command; a loose, symlinked or
  foreign-owned flag is ignored with a log line; the env lands on claude's exec only.
- **Page:** unit tests for the card states (open, deny-only, repeat, expired, probably answered,
  sent), the two-step Allow and its 4 s reset, `shown` computed from the delivered fields;
  headless Chromium at 390 and 1440 px, light and dark, against a scratch server with a fake
  channel: a card with a 3,500-point preview and an elision marker, a hostile preview (HTML, a
  fake "Allowed" line, RTL marks), no CSP violation, no console error, no sideways scroll.

### 9.2 Scratch session (Jeff at a terminal, never Jarvis's session)

Jarvis's go-live doc §3 already runs a scratch session with the dev-channel flag against a
scratch Control Room. Add (it must not load the Discord plugin, which would take Jarvis's bot):

- A0-1. With the env set, `initialize` declares `claude/channel/permission`; without it, not.
- A0-2. In manual mode, `touch` a file in the scratch folder: the card appears; Deny closes the
  terminal dialog and Claude reports the refusal.
- A0-3. A subagent in the scratch session asks for the same: does its prompt relay? (Settles
  section 4's open row.)
- A0-4. Answer at the terminal first, then Deny on the page: the server says "sent", the
  channel log shows the verdict delivered, and Claude Code ignores it (nothing happens).
- A0-5. Stop the scratch Control Room, answer nothing, start it again after 3 minutes: the
  spooled request appears; a Deny sent then is dropped by the channel if older than 120 s.
- A1-F. **What does a multi-line Bash command look like when relayed?** (board ac24e766; run
  once, by Jeff or by Jarvis's hands at a terminal, never in Jarvis's session.) Use the go-live
  doc's §3 scratch setup (scratch Control Room, scratch `HOME`, the dev-channel flag, no
  Discord plugin), with `CCR_APPROVALS=deny` on the scratch server, and the one flag
  `approvals-enabled` made in the scratch `HOME`'s `.local/state/jarvis-os/`, with
  `JARVIS_CHANNEL_PERMISSION_RELAY=deny` and
  `JARVIS_CHANNEL_FLAGS_DIR="$S/home/.local/state/jarvis-os"` in the scratch session's
  environment (the session itself runs with the real `HOME`, and from 0.4.5 the channel
  looks for flags in the account's own state folder unless this test knob names another),
  so nothing can be allowed from the page and the real flag folder is never touched. Run it
  in the same sitting as A1-H below, which uses the same setup.
  1. Start the scratch session with `--permission-mode default`, in an empty scratch folder
     that holds a file `notes.txt`.
  2. Ask it, word for word: "Run this exact Bash command, as one tool call, with the line
     break kept: `cat notes.txt` then a newline then `echo second-line`". (Harmless on purpose.)
  3. When the terminal dialog opens, do not answer yet. Copy the raw field exactly, from
     either place: `openPermission.inputPreview` in the scratch page's `/api/chat/status`
     (with the paired cookie), or the `permission_request` line in the scratch session's
     `claude --debug` log, which is the text before the channel or the server touch it.
  4. Record three things in NEXT.md §10: the CLI version (`claude --version`); the raw
     `input_preview`; and which of these it shows between `notes.txt` and `echo`: the two
     characters `\n` (a JSON escape: the line break survives, and the server's shell-syntax
     rule sees it), a real line break, or a single space (folded).
  5. Repeat once with a tab and with two spaces inside a quoted argument, and once with a
     Write whose `content` has several lines, to learn whether folding touches every field.
  6. Deny at the terminal. Delete the scratch `HOME`.
  Since 0.2 the answer no longer decides a config value (`"strict"` is gone); it tells
  which branch of the exact-command match real requests take: the fold, or the outright
  match for a preview that kept its `\n`.
- A1-H. **Does the exact-command hook report before the relay, and do the two folds
  agree?** (board 320ecc71; hard requirement 9 of 0.2. Run once, by Jeff or by Jarvis's
  hands at a terminal, never in Jarvis's session, before `chat.approvalsBash` is ever set to
  `"exact"`, and again after any Claude Code update that touches hooks or channels.) It
  touches nothing live: the hook is given to the scratch session alone and posts to the
  scratch server's port, never :8322.
  1. *Setup,* as the go-live doc's §3.0, from the commits under test (export this repo's
     `server` and `bin/chat-pair`, and the lead's repo's `jarvis-local`). Terminal A, the
     scratch server, with five more variables:
     `CCR_APPROVALS=deny CCR_APPROVALS_BASH=exact CCR_EXACT_ANY_SESSION=1 CCR_EXACT_DEBUG=1 CCR_PORT=8399`
     (deny: nothing can be allowed; any-session: a scratch session has no roster name;
     debug: the harness prints the reported and the previewed command, JSON-escaped, for
     these harmless commands only). Then
     `(umask 077; : > "$S/home/.local/state/jarvis-os/approvals-enabled")`.
  2. *The scratch session,* terminal B, in `$S/work` holding a file `notes.txt`. Add to
     §3.0's command the environment
     `JARVIS_CHANNEL_PERMISSION_RELAY=deny JARVIS_CHANNEL_FLAGS_DIR="$S/home/.local/state/jarvis-os"`
     and put the hook in the session's own `--settings` JSON beside `enabledPlugins`: the
     README's exact-command entry, word for word, with `127.0.0.1:8322` changed to
     `127.0.0.1:8399`. Start it with `--permission-mode default`. Check the channel's line
     in the debug log: `permission relay on (deny only)`.
  3. *The order, manual mode.* Ask: "Run this exact Bash command as one tool call:
     `cat notes.txt`". When the dialog opens, read terminal A. Pass: a line
     `exact-command report: kept, 13 characters`, then
     `exact-check <id>: the newest report came N ms before the relay; exact text on the card: yes`
     with N positive. A negative N, or `no report has come`, is a fail: the hook does not
     run before the relay, and `"exact"` stays off. Deny at the terminal.
  4. *The fold.* Repeat step 3 with each of these, asking each time for the exact command
     as one tool call, and Deny each at the terminal: (a) `cat notes.txt` then a line break
     then `echo second-line`; (b) `cat` then a tab then `notes.txt`; (c) the two-line command
     with a carriage return and a line break between the lines; (d) `cat notes.txt` with two
     leading and two trailing spaces; (e) `echo 'a  b'` (two spaces inside quotes). For each,
     terminal A prints the previewed command, the reported text and
     `the server's fold of the report EQUALS the preview's command` or `DIFFERS FROM`. Pass:
     EQUALS for (a), (b), (d) and (e), and `exact text on the card: yes` (the card is still
     Deny-only for (a), (b) and (e): more than one line, a tab, shell syntax). For (c) the
     report carries a carriage return, so the pass is `exact text on the card: no` with the
     reason "characters outside plain ASCII, line breaks and tabs", whatever the fold line
     says. Any DIFFERS FROM is a finding for Pepper with the two printed texts (the model
     may not reproduce odd spacing exactly: the reported text shows what it really sent).
     Record the CLI version and each result in NEXT.md §10.
  5. *The order, auto mode's fallback.* Restart the scratch session with
     `--permission-mode auto` and ask for something the classifier is likely to hand back
     to a person, for example "Run this exact Bash command as one tool call:
     `curl -s https://example.com -o notes.txt`" (harmless; Deny it). When a dialog opens,
     the same two lines must appear in the same order with N positive. If auto mode simply
     runs or refuses the command without a dialog, try another until one prompts; if none
     does in a few tries, record "no fallback prompt seen" and leave `"exact"` off until
     one has been observed.
  6. *A1-F, in the same session:* steps 1 to 5 of A1-F above (the raw `input_preview`),
     which the lines of step 4 here already show for Bash; do its Write case too.
  7. *Clean up:* `/exit` both sessions, stop the scratch server, remove the test plugin as
     §3.7 of the go-live doc says, delete `$S`. Nothing was installed in
     `~/.claude/settings.json` and no real flag was made.

### 9.3 Live checks after each restart (Jeff present, harmless commands only)

- Jarvis's log says "permission relay on"; `/api/chat/status` shows `openPermission: null`.
- Jeff asks Jarvis to `touch` a file in Jarvis's state scratch folder in manual mode: the
  DM and the card both appear within seconds (settles "two channels both get it"), and the
  push arrives on the locked iPhone with no tool name.
- Deny on the page: the terminal dialog closes, Jarvis says it was refused, #pepper gets
  "a permission was denied from <device> (Bash)"; the DM's buttons still show and a later tap
  on them does nothing.
- Repeat, answering in Discord first: the card stays, then dims or expires; a page tap says
  "sent" and nothing happens.
- `touch` the kill file: the next prompt shows no card (DM and terminal still work); remove it.
- A1 only: Allow from the approver phone works; Allow from the iPad (not marked) is refused;
  a `sudo` request shows Deny only.

## 10. Decisions for Jeff (answered 2026-11-11: section 0)

1. **When.** You said 11-11: approvals after the two-week trial (about 11-25). Options: (a) all
   of it after the trial; (b) Deny-only (A0) as soon as it is built and reviewed, Allow (A1)
   after the trial. **Pick: (b).** Deny grants nothing and A0 is how we find out whether the
   relay behaves with two channels before anything can be allowed.
2. **Which sessions.** (a) Jarvis's session only; (b) also headless runs and agents through a
   global `PermissionRequest` hook. **Pick: (a).** (b) puts a grant path in every session on
   the mini.
3. **The Deny-only list (G6).** (a) As drafted: hidden parts, risky commands, protected paths
   and unknown tools need the terminal or Discord; (b) no list, the page can allow anything
   Discord can. **Pick: (a).**
4. **Face ID per Allow (Phase C).** (a) Build it after A1; (b) require it before A1 ships; (c)
   never. **Pick: (a).** A1 already has the approver mark, the Deny-only list and an alert per
   verdict, and today's Discord DM has no Face ID either.
5. **How long a card stays answerable on the page.** (a) 10 minutes, as built; (b) longer.
   **Pick: (a).** After that, Discord and the terminal still work, and a short window limits
   stale taps.
6. **A prompt nobody answers.** (a) Keep waiting, as today; (b) auto-deny after N minutes so
   Jarvis moves on. **Pick: (a).** Board b534203c (a #jarvis ping when a prompt waits) handles
   the stall without a machine saying no for you.
7. **Which devices may Allow (G7).** (a) Only devices you mark on the mini; (b) every paired
   device. **Pick: (a),** with your iPhone marked and the iPad not, unless you say otherwise.

## 11. What Ultron should look at

- Whether "a paired, marked device's tap = a Discord DM tap" is acceptable at all, now that
  the prerequisites (Host allowlist, per-verdict alert, strict CSP, socket token) are live.
- The verdict route's order of checks (7 in 5.1) and that every refusal changes nothing.
- G4's 120 s and 11-minute numbers against the channel's spool and replay.
- The Deny-only list: what's missing, and whether "unknown tool = Deny-only" is the right
  default.
- That the card can't be spoofed by preview text, and that `shown` is computed from the fields
  as delivered, not as rendered.
- That A0's verdict route refuses `allow` server-side, not just in the page.
- The flag-file rules for `approvals-enabled` (copy of `channel-enabled`'s).

## 12. Rules this design keeps

- Tailnet only; the server binds 127.0.0.1; nothing new faces the internet.
- No new `claude -p` run. The design itself needs no hook; two report-only hooks were
  added by Jeff's decisions (the async `PermissionDenied` one in section 0, the
  exact-command one in 0.2), each drafted in the README for the owner to install, and
  neither can decide a request. No change to managed settings.
- No test write at :8322; scratch servers and a scratch Claude session only, never Jarvis's
  session for a test, never another session's tmux.
- The repo stays anonymous: no hostnames, tailnet name, Discord ids or device names in
  committed files.
- The board is Jarvis's; `launchctl`, Serve and the managed file are Vision's and Jeff's.
