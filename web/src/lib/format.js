// What the Orbit page reads an envelope with. The first dashboard's formatters
// (heat, pace wording, countdowns, token and date formats, the cron order) lived
// here too until that page was removed on 2026-11-18; the mod keeps its own copies
// of those rules in mod/hooks/model.js.

// Before the first poll lands — and for the whole time the server is down — there
// is no envelope at all. A missing envelope is not "fine", it is the strongest
// form of unavailable: we have not heard anything. Every consumer must treat the
// two identically, so the normalisation lives here rather than at each call site.
export const NO_ENVELOPE = Object.freeze({
  data: null, fetchedAt: null, status: 'unavailable', error: 'no response from the server yet'
});

export function envelopeOf(envelope) {
  return envelope && typeof envelope === 'object' && typeof envelope.status === 'string'
    ? envelope
    : NO_ENVELOPE;
}
