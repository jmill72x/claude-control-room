// What ntfy may say (board 704e981b, 2026-11-21). Anyone who knows the ntfy topic can
// publish to it, so the rule for the phone is: an ntfy alert that tells you to run
// something, or has a link or a button, is forged. For that to hold, no ntfy push from
// this server carries any text of the alert's own: not a command, a path, a URL, a
// label from a feed or config, a count, or an instruction. Each push is one of the fixed
// titles below, then fixed words, and nothing else (notify.mjs, publish, is the only
// code that posts to ntfy, and it builds the body from `ntfyNote` alone). The details
// stay where they already are: #pepper, the page, and the service log.
//
// A title is a plain name for what happened, never an instruction: it never starts with
// a verb telling the reader to do something, and holds no path, no link. A title that is
// not in this list (a typo, a new caller that forgot to add one) is sent as NTFY_FALLBACK,
// so the failure mode of a mistake is a vaguer push, never free text.
// test/ntfy-note.test.mjs sweeps every title.
export const NTFY = Object.freeze({
  limit: 'Claude usage limit',
  limitFull: 'Jarvis at a usage limit',
  credits: 'Claude credits',
  board: 'Board nearly full',
  leadDown: 'Jarvis down',
  jobs: 'Job failure',
  services: 'Service down',
  waiting: 'Waiting on you',
  other: 'Needs attention',
  missedRuns: 'Missed runs',
  missedRunPage: 'Missed-run heal needs a look',
  restartCard: 'Server restart waiting',
  restartPage: 'Server restart needs a look',
  ingestOff: 'Ingest socket off',
  ingestLegacy: 'Old ingest route used',
  chat: 'Chat security event',
  ack: 'Alert acknowledged',
  renew: 'Acknowledgement renewed',
  ackPaused: 'Ack notices paused until tomorrow'
});
export const NTFY_FALLBACK = 'Control Room alert';
const KNOWN = new Set(Object.values(NTFY));
export const NTFY_WORDS_AFTER = 'details are in the Control Room.';

// The one title ntfy shows for every push (its Title header). Fixed, like the body.
export const NTFY_HEADER_TITLE = 'Control Room';

// A Set's own match: only the very string, so an object that prints as a title is not one.
export const isNtfyTitle = title => KNOWN.has(title);
export const ntfyNote = title => `${isNtfyTitle(title) ? title : NTFY_FALLBACK}: ${NTFY_WORDS_AFTER}`;
