import { useEffect, useSyncExternalStore } from 'react';
import { createSpeaker, createVoiceStore, NO_VOICES } from '../lib/orbit/speech.js';

// Read aloud (src/lib/orbit/speech.js): one speaker for the page. It plays the Mac's
// own voice as audio where the server offers it (useMiniVoice hands over what the chat
// status says), and otherwise speaks through the browser's speechSynthesis, in an
// on-device voice only. The page shows no speaker button where neither is there
// (useCanSpeak). Which voice is this device's choice, kept in its localStorage (Chat
// settings, useVoices).
let speaker = null;
export function getSpeaker() {
  if (speaker === null) {
    const w = typeof window === 'undefined' ? null : window;
    // The voice's language: the page's first, then the browser's.
    const langs = w ? [w.document?.documentElement?.lang, ...(w.navigator?.languages ?? []), w.navigator?.language] : [];
    // Reading window.localStorage can itself throw (blocked site data): the store takes that.
    const store = createVoiceStore(() => w?.localStorage);
    // One <audio> element for the Mac's voice, made at the first tap that needs it.
    const makeAudio = w && typeof w.Audio === 'function' ? () => new w.Audio() : null;
    speaker = createSpeaker({ synth: w?.speechSynthesis ?? null, Utterance: w?.SpeechSynthesisUtterance ?? null, langs, store, makeAudio });
  }
  return speaker;
}

// Whether an on-device voice is there to speak in; turns true when a voice list that
// was empty at first load fills in.
export function useCanSpeak() {
  const sp = getSpeaker();
  return useSyncExternalStore(sp.subscribe, sp.canSpeak, () => false);
}

// What the voice picker shows: the on-device voices, this device's choice and the
// voice Automatic uses; re-renders when the browser's list or the choice changes.
export function useVoices() {
  const sp = getSpeaker();
  return useSyncExternalStore(sp.subscribe, sp.voices, () => NO_VOICES);
}

// The id of the message speaking now, or null; re-renders on every change.
export function useSpeaking() {
  const sp = getSpeaker();
  return useSyncExternalStore(sp.subscribe, sp.current, () => null);
}

// The id of the message whose audio from the Mac was asked for and has not started.
export function useSpeechLoading() {
  const sp = getSpeaker();
  return useSyncExternalStore(sp.subscribe, sp.loading, () => null);
}

// What the chat status says of the Mac's voice (`speech`: the voice it reads in, or
// null while the server offers none), handed to the speaker whenever it changes. Every
// status carries it, so a voice downloaded on the Mac, or the server's off switch,
// shows here within one status.
export function useMiniVoice(speech) {
  const key = JSON.stringify(speech ?? null);
  useEffect(() => {
    getSpeaker().setRemote(JSON.parse(key));
  }, [key]);
}

// Speech stops when the thread goes (another tab, the pairing screen) and whenever the
// page is hidden or left: nothing keeps talking from a page nobody is looking at.
export function useStopSpeechWhenAway() {
  useEffect(() => {
    const sp = getSpeaker();
    const onVisibility = () => { if (document.visibilityState !== 'visible') sp.stop(); };
    const onHide = () => sp.stop();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onHide);
      sp.stop();
    };
  }, []);
}
