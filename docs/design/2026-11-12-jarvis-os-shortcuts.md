# iPhone Shortcuts into Jarvis OS

Written 2026-11-12 by Pepper for Ultron (the auth, before anything goes live) and then Jeff
(four decisions, section 8, all answered on 2026-11-12). Board item 0ea79dde; Jeff, 11-12: "i def want the iphone
shortcuts". It is the first slice of pillar 5 (ambient input) and came from Shuri's 11-11
agent-OS survey, pick 7.

**Built on branch `jos/shortcuts`, switched off** (config `chat.shortcuts`, default false).
The phone steps are in `docs/jarvis-os-shortcuts-setup.md`. **Ultron read it on 2026-11-12:
go to commit, go to switch on once his two mediums were fixed.** Section 9 lists his
findings and what changed; the sections above it describe the code as it now is.
Merged as fc845fc and switched on 2026-11-12. **The 30-day idle expiry (decision 4, Jeff's
yes on 11-12) is built on `jos/shortcut-idle-expiry`:** section 10.

## 1. What Jeff gets

| Shortcut | How it starts | What reaches Jarvis |
|---|---|---|
| **Send to Jarvis** | The share sheet, on a link or selected text | One chat message from Jeff: his note, plus the link in the text or the shared text as an attached file |
| **Ask Jarvis** | "Hey Siri, Ask Jarvis", or a tap | One chat message from Jeff, his dictated words. The answer is Jarvis's normal chat reply, with the normal "New message" push |
| **Arrive home** | A location automation | One event line from `system`: "Presence: arrived home at 18:02 (from the Shortcut key iPhone)". Data, never Jeff's message |

A fourth, **Jarvis Setup**, runs once to pair the phone.

## 2. The rules this had to meet

1. No long-lived secret in plain text inside a Shortcut.
2. A Shortcut's message arrives as Jeff's on the path the page uses: the same store, the
   same `jos` chat, marked with where it came from.
3. It carries no extra authority, and it can never answer a permission request.
4. "Arrived home" is data, not an instruction.
5. Nothing live is touched: the feature is off until config says otherwise.

## 3. The auth: a Shortcut key

**What it is.** A random 32-byte key (`jsk_…`) that one phone's Shortcuts share. The server
keeps only its sha256, in `server/data/chat/shortcut-keys.json` (0600), apart from the
paired devices. It travels in `Authorization: Bearer`, never as a cookie.

**What it can do.** Two routes: `POST /api/shortcut/send` (one message) and `POST
/api/shortcut/event` (one presence report). Nothing else takes it. It can't read the
thread, open the stream, list or revoke devices, pair anything, or answer a permission:
those routes take the device cookie, and a key is not one (tested route by route, with the
key sent both as a header and as a cookie).

**What else every request needs.** The owner's tailnet login from Serve (the chat's own
second factor), JSON, and no `Origin` or `Sec-Fetch-Site` header: a Shortcut sends neither
and a browser page always sends one, so a web page can never use these routes even with a
key.

**How the phone gets it (one-time pairing).** The key is never shown, typed or copied:

1. On a paired device, Chat › ⋮ › Shortcut keys › **New key** shows a 6-letter code (10
   minutes, single use; a new one replaces it; three wrong tries end it). `bin/chat-pair
   shortcut-code <name>` does the same on the mini.
2. The Setup Shortcut asks for the code and sends it once to `POST /api/shortcut/pair`.
3. The answer carries the key, which the Shortcut saves straight to a file on the phone.
   The other Shortcuts read that file each time they run.

**A key's name** is plain ASCII, 22 characters at most (letters, digits, spaces and `. _
' -`), refused otherwise. The message's device is the name plus " (Shortcut…)", and Jarvis's
rule reads that mark, so no name may push it out of the 40 characters the store keeps or
imitate it.

**Limits.** 4 active keys (a revoked or expired key holds no place). A key that made no
message and no presence report for 30 days stops working (section 10). Per key: 20 messages in 10 minutes and 100 a day; 6 presence
reports a day, the same one at most every 10 minutes. The same message again within 15 s is
answered as the first, so a retry never doubles it. Each is counted in the same step as
its check, so requests sent at the same moment can't all slip through.

**What is reported to #pepper** (ntfy gets the generic line): a code made, a key made, a
key revoked, three wrong codes, five wrong keys or five refused pairing tries in 10
minutes, a key over a limit, a key used from a tailnet address it has not used before
(the address itself only in the service log), and an expired key that is tried (once a
day per key).

**Off switches.** Revoke a key on the page (two taps) or `bin/chat-pair shortcut-revoke
<name>`: dead on the next request. Revoking a paired device revokes the keys whose codes it
made. `touch ~/.local/state/jarvis-os/shortcuts-off` refuses every Shortcut request and
every new code (the page's and `bin/chat-pair`'s) at once, no restart; listing and revoking
still work. Config `chat.shortcuts: false` removes the routes.

### 3.1 Where the key lives on the phone, plainly

iOS gives Shortcuts no Keychain-backed field (stated from what I know of the app; I could
not check Apple's documentation against a phone here). So the choice is where the plain
bytes sit:

- **Inside a Shortcut** (a Text action): visible on screen, copied through the clipboard
  to get there, and it travels with the Shortcut if it is shared, exported or
  screenshotted. This is what rule 1 forbids, and the design avoids it.
- **In a file the Shortcut reads** (built): never on screen or the clipboard, not part of
  any Shortcut. The setup steps put it under **On My iPhone**, so it stays in the phone's
  encrypted storage and out of iCloud Drive. It is still a readable file to anything Jeff
  gives that folder to, and it is in the phone's backup.

A stolen key file lets someone send chat messages as Jeff, and only from a device that is
on the tailnet signed in as Jeff. So the secret that really guards this is still Tailscale's
device key, which is in the Keychain. The key adds: other apps on the phone can't send,
each Shortcut install is named, counted and revocable by itself.

### 3.2 Options considered

| Option | Why not, or why |
|---|---|
| **A. One-time code, key in a file on the phone** | Built. Meets rule 1; one extra action per Shortcut (read the file) |
| B. Paste a key into each Shortcut | Simplest to build. Breaks rule 1: plain text in three Shortcuts, on screen and on the clipboard |
| C. Reuse the page's device pairing (`__Host-jos`) | A Shortcut's requests don't share the home-screen app's cookies. And that cookie reads the chat and, on an approver device, allows permissions: far more than a Shortcut should hold |
| D. A cookie the Shortcuts app keeps for itself | Nothing readable anywhere, which is better than a file. But whether "Get Contents of URL" keeps cookies between runs, and across the share sheet, Siri and automations, is undocumented and I can't test it here. Could be added beside A later without changing a route |
| E. No secret: trust the tailnet login alone | Any app on the phone, and any of Jeff's other tailnet devices, could then send as him |
| F. No credential: open the page with a draft, Jeff taps Send | iOS opens the link in Safari, not the home-screen app, so it lands unpaired; and Siri and the automation can't tap Send |
| G. Pin the key to the phone's tailnet address | A phone reaches Serve over either of two tailnet addresses (IPv4, IPv6), so a pin breaks at random; and what Serve puts in `X-Forwarded-For` is Vision's to confirm. Built as a tripwire instead: first use from a new address is alerted |

**No fixed life**: that would mean re-running Setup on a schedule, and an arrive-home
automation that fails silently the day it lapses. **An idle expiry instead** (Ultron's
suggestion, Jeff's yes on 2026-11-12): a key unused for 30 days stops working, which a key
in daily use never meets. Section 10 has the rule as built.

## 4. A message from a Shortcut

`send` appends with the same store call as the page's route: `from: jeff`, `kind: chat`,
`state: queued`. The channel's line for it has the same fields as a page message (tested
side by side, and once through the real channel socket). What differs:

- **`device`** is the key's name and how it came: `iPhone (Shortcut, Siri)`, `iPhone
  (Shortcut, share)` or `iPhone (Shortcut)`. The channel already shows `device` to Jarvis.
  The thread shows "via Siri Shortcut" or "via share sheet" under the bubble.
- **No reply target, no uploads, no other field.** The body may hold `text`, `shared`,
  `via` and `clientId` only; anything else is a 400.

### 4.1 What Jeff says and what he shares are kept apart

Sharing makes it routine to forward someone else's words, and a forwarded paragraph that
says "ignore your instructions" must not arrive as Jeff's own message. So:

- **`text`** (his note, or what he dictated) is the message.
- **`shared`**, when it is exactly one `http(s)` link of at most 300 characters to a
  public host name, goes into the message text as `URL` rebuilt it, under the fixed line
  "Shared link, outside content:". A longer link, or one to an IP address, `localhost` or a
  private-network name, is treated as shared text.
- **Any other `shared` text** becomes a `text/plain` attachment, `shared-text.txt`. The
  channel already tells Jarvis an attachment is outside content
  (`attachments_are_data="1"`), so this uses a boundary that exists and needs no channel
  change. With no note, the message text is the fixed line "Shared from the share sheet:
  the text is attached."

The cost: Jarvis makes one `fetch_attachment` call to read a shared paragraph, and the
thread shows it as a file chip, not inline. (The page now shows any non-image file as a
download chip; before this, a text file from Jarvis would have drawn as a broken picture.)

## 5. Arrive home

The Shortcut sends `{"event": "arrived-home"}` and nothing else; any other field is
refused. The words are the server's template, the key's name appears only when it is a
plain name, and the line is stored `from: system`, `kind: event`, through the events module
(`presence`, a new source). So it reaches Jarvis as the channel's `jos-events` tag
(`event_is_data="1"`), with the event caps, the 2-hour staleness rule and the events kill
switch applied. It is never held for quiet hours: an arrival told the next morning is
wrong. The same report within 10 minutes is dropped (a geofence flaps).

**What Jarvis does with it is his instruction file's, not the server's.** The server only
delivers data. Jeff's answer (section 8): one short brief only if something is waiting on
him, at most once an evening, never between 22:00 and 07:00. The channel's standing rule
holds beside it: an event alone justifies no write.

One channel follow-up (Jarvis's repo): the released channel's list of event names has no
`arrived-home`, so its tag reads `event="unknown"` with `source="presence"`; the text is
whole either way.

## 6. For Ultron: choices to defend

1. **A key's authority.** Sending as Jeff is instructing Jarvis in auto mode. That is what
   the page's composer does too; the key is narrower than a paired device in every other
   way. The gate on what Jarvis then does is still the permission prompt, which no key can
   answer.
2. **Any paired device may make a code**, as any paired device may approve a pairing. Not
   limited to approver devices.
3. **The code is pre-approved**: whoever enters it within 10 minutes gets the key. It is
   shown only on a paired device's page. The earlier design (the Shortcut asks, the page
   approves, the Shortcut collects) needed the app switched mid-run and two more
   requests; I built it first and replaced it.
4. **Shared text as an attachment**, a short public link inline under a fixed line
   (section 4.1). 300 characters of a URL can still carry a few words.
5. **The address tripwire is not a lock** (section 3.2, G).
6. **Presence shares the events' 30-a-day total**, capped at 6 a day per key so it can't
   crowd out a job failure.
7. **`say`** rides on every answer so a Shortcut needs no logic; it says only "online" or
   "offline" about Jarvis, nothing from the chat.
8. **No secret-shape check** on a Shortcut's text, as on the page's: Jeff may send what he
   likes; only Jarvis's replies are checked.

## 7. Not verified

- **Everything on a real iPhone.** That "Get Contents of URL" sends no `Origin` or
  `Sec-Fetch-Site` (if it sends one, every call is refused with a clear line, and the fix
  is one condition); that a file variable in a header yields its text; where Save File
  writes; how Siri speaks the prompts; whether the automation runs with the phone locked.
- **Serve's `X-Forwarded-For`** as a single tailnet address: only the tripwire uses it,
  and anything else is treated as unknown.
- **`server.mjs` wiring** beyond its source test (it can't run in a test).
- **Safari/WebKit** for the new section: checked in headless Chromium only.

## 8. Decisions for Jeff (all decided 2026-11-12)

1. **The auth**: A as built (my pick), or B if the file step is too fiddly on the phone.
   **Decided: A, the pairing code.**
2. **What Jarvis does when you arrive home**: (a) note it and say nothing; (b) send one
   short brief only if something is waiting on you, at most once an evening, never
   between 22:00 and 07:00 (my pick); (c) always send a brief. **Decided: (b).**
3. **Ask Jarvis from the lock screen**: Siri can run a Shortcut on a locked phone, so
   anyone holding it could speak a message as you. My pick: turn off "Allow Running When
   Locked" for Ask Jarvis (Face ID first). The setup steps say where. **Decided: off, on
   both Ask Jarvis and Send to Jarvis.**
4. **Key expiry**: none (as first built), or Ultron's suggestion, a key unused for 30 days
   stops working and Setup is run again. My pick: the 30-day idle expiry; a key in use
   never meets it, and a forgotten one cleans itself up. **Decided 2026-11-12: Jeff said
   yes to the 30-day idle expiry. Built: section 10.**

## 9. Ultron's review (2026-11-12) and what changed

Verdict: go to commit; go to switch on with conditions. Fixed the same day on the branch:

| Finding | Fix |
|---|---|
| **M2** (gated switch-on). The limits raced: the count was checked, then added only after an await, on a copy of the list. 150 of 150 sends and 40 of 40 presence reports sent together got through | The count is added in the same step as its check, before anything awaits, on one list per key. A send that then fails gives its count, its retry mark and its file back. Identical sends in flight together are one message. Tested with 150 sends and 40 reports handed to the router at once: 20 pass, one event |
| **M3** (gated switch-on). A shared link went inline unmarked, up to 2,048 characters | A fixed line, "Shared link, outside content:", sits over every inline link. Only a link of at most 300 characters to a public host name goes inline; longer ones, IP literals and `localhost` are attached like other shared text |
| **L4**. A name of emoji could push "(Shortcut" out of the device label | Names are plain ASCII, 22 at most, refused otherwise, never cut. A name from a hand-edited file that is not plain is sent as "unnamed key" |
| **L5**. Shared text that began like a PDF was stored as one | The shared-text attachment is stored without sniffing its bytes: always `text/plain` |
| **L6**. Over-limit refusals and pairing probes were logged line by line and never alerted | Two rate-limited alert kinds: a key over a limit (once per key and limit in 10 minutes) and five refused pairing tries in 10 minutes. The refused-pairing log line is written once per 10 minutes |
| **L7**. A key did not know which device made it | The maker's device id and name are stored; the page shows the name. Revoking a device revokes the keys it made and drops its waiting code |
| **L9**. A corrupt keys file was read as empty and written over | It is renamed aside and logged; a file with some bad entries is copied aside; one that can't be read keeps Shortcut keys off |
| **L10**. `bin/chat-pair shortcut-code` ignored the kill file | It is refused while the kill file exists |

Key expiry was Jeff's decision 4 and was not part of that pass: section 10.

## 10. Idle expiry (2026-11-12, board 2fb1fea8)

Built on `jos/shortcut-idle-expiry` after Jeff's yes. **Ultron read it on 2026-11-12: GO,
0 medium, 4 low.** His L1 (an expired key could not be revoked) and L4 (a wording) are in,
as described below; L2 and L3 are on the board for later.

**The rule.** A key stops working 30 days after its last use, or 30 days after it was
made when it has never been used. Pairing again (a new code, Jarvis Setup) is the only
way back; Setup writes the new key over the old file, so the other Shortcuts need no
change.

**What a use is.** A message the key made, or a presence report the server took
(arrive-home included, also when the events kill switch kept it from Jarvis). Nothing
else: not a request that was refused (a bad body, over a limit, switched off), not a
repeat answered as the first (the same words within 15 s, a `clientId` sent again, a
flapping geofence), and not the key merely being read. So a phone in daily use never
meets the limit, and nobody can keep a key alive without a message, an event or a
counted report. Before this change every request that carried the key counted as a use; `uses`
and "last used" on the page now mean messages and reports made.

**How it is kept.** Nothing new is stored. Each key already had `lastUsedAt` (written at
most once a minute) and `createdAt`; whether it has expired is worked out from those on
every request and every listing (`keyExpiresAt`, `keyExpired` in
`server/lib/shortcut-keys.mjs`). A key from before this change, or one never used, has no
last use and counts from when it was made. A row with no readable time at all has
expired. 30 days is a constant (`KEY_IDLE_DAYS`), not a config key: every other limit
here is a constant, and config only switches the feature on or off.

**An expired key can't send or report, holds none of the 4 places, and keeps its row.**
The page and `bin/chat-pair shortcuts` show it as expired; a key that works shows when it
expires if unused.

**An expired key can still be revoked** (Ultron's L1; as first staged it could not, and a
device revoke skipped it). Expiry is worked out from the clock and a revoke is written
down, so only a revoke holds if the clock is set back, the commit is reverted or an older
build runs. A revoke by id takes the row whether it works or has expired. A revoke by
name takes the working key of that name when there is one, so a phone paired again as
"iPhone" still resolves to its new key, and an expired one only when no working key has
the name (two expired keys of one name need the id). Revoking a device takes every
unrevoked key it made, expired ones too. The page keeps Revoke on an expired row.

**What the phone hears.** A 401 like an unpaired Shortcut's, with its own `say`: "This
Shortcut is not paired with Jarvis OS any more: its key expired after 30 days without
use. Make a new code in Jarvis OS and run the Jarvis Setup Shortcut." Only a request
carrying the real key gets that answer; any other key gets the plain "not paired".

**What Jeff hears.** The arrive-home automation shows nothing on the phone, so an
expired key that is tried is reported to #pepper (ntfy gets the generic line): once per
key per day, however often it is tried. It is not counted with the wrong keys.

**Choices to defend.**

1. **Worked out, not stored.** There is no `expiredAt` to forget to check and no write
   on a read. The cost: the rule trusts this machine's clock and this build. A clock set
   back by weeks, a revert or an older build would let an expired key that was not
   revoked work again, and a clock set forward kills keys only until it is put right.
   Anyone who can set the mini's clock already holds more than a key; for a lost phone,
   revoke the key, which is on file.
2. **Only a made message or report is a use.** Stricter than "any request with the
   key", so a refused request never extends a key's life. A Shortcut that is broken in a
   way the server refuses for 30 days expires and needs Setup again.
3. **A last use dated in the future** (the clock was set back after it) counts as fresh,
   and the next use writes over it.
4. **The 30 days are not in the file or the config.** Changing them is a code change
   and a restart, and it applies to every key at once.
5. **Telling a key's holder that it expired** is not a leak: the answer needs the key.
6. **The daily report is kept in memory**, so a restart allows one more that day.

**Verified.** Tests for: expired, fresh to the last millisecond, refreshed by a message
and by an arrive-home report, what does not refresh, keys with no last use on file, a use
kept across a restart, a place freed by expiry, and an expired key revoked by id, by
name and with its device (and staying dead with the clock set back). NEXT.md §10 has the counts and the
mutation run. **Not verified:** anything on a real iPhone (how Siri speaks the longer
line); `server.mjs` is unchanged.
