// The one line that brings Jarvis back (the run sheet's top section, the lead's
// docs/jarvis-is-down.md), in its own module with no imports, so every alert can carry
// it: the chat's "Jarvis is offline" push (lib/chat-push.mjs), a local "jarvis-down"
// alert's push (lib/local-alerts.mjs), the lead's session down for five minutes
// (lib/push-alerts.mjs: in #pepper; ntfy gets no way back at all, only lib/ntfy-note.mjs's
// fixed words), and the page's Restart card (web/src/lib/orbit/recover.js holds
// the same words; test/jarvis-recover.test.mjs keeps them equal). The button that runs
// it from the page is lib/jarvis-recover.mjs.
export const RECOVER_COMMAND = 'cd ~/Projects && ~/Projects/.worktrees/jarvis-release/bin/jarvis-recover';
// What an alert adds: how to bring him back, from the page or from a terminal.
export const RECOVER_LINE = `To bring him back: Restart Jarvis in the Control Room (Face ID), or paste in a terminal on the mini, outside the jarvis tmux session: ${RECOVER_COMMAND}`;
// Every line the server sends ends with the command, with nothing after it, so a paste
// of the line's end runs exactly it (Ultron's M1 on jos/card-lows, 2026-11-28: a note after
// `--if-down` made zsh fail with "unknown file attribute: i", and recover never ran). A
// test checks each one (test/card-lows.test.mjs). The lead-down alert's `--if-down` line
// (board 63ff44b0) comes with the run sheet's item (board a79cfab5) once the jarvis
// release carries 10981bf; the released jarvis-recover (7923d85) ignores arguments.
// ntfy never gets either of these, or any way back (Ultron's L1, 2026-11-20, then board
// 704e981b, 2026-11-21): anyone who knows the topic can publish to it, so a forged
// "Jarvis is down, paste this" or "tap here" would look exactly like the real one. Its
// push is "Jarvis down: details are in the Control Room." Web Push (signed with this
// server's own key), #pepper and the page carry the command.
