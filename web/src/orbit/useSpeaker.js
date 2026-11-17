import { useEffect, useSyncExternalStore } from 'react';
import { createSpeaker } from '../lib/orbit/speech.js';

// Read aloud (src/lib/orbit/speech.js): one speaker for the page, over the browser's
// speechSynthesis, in an on-device voice only. The page shows no speaker button where
// the browser has no speechSynthesis or lists no on-device voice (useCanSpeak).
let speaker = null;
export function getSpeaker() {
  if (speaker === null) {
    const w = typeof window === 'undefined' ? null : window;
    // The voice's language: the page's first, then the browser's.
    const langs = w ? [w.document?.documentElement?.lang, ...(w.navigator?.languages ?? []), w.navigator?.language] : [];
    speaker = createSpeaker({ synth: w?.speechSynthesis ?? null, Utterance: w?.SpeechSynthesisUtterance ?? null, langs });
  }
  return speaker;
}

// Whether an on-device voice is there to speak in; turns true when a voice list that
// was empty at first load fills in.
export function useCanSpeak() {
  const sp = getSpeaker();
  return useSyncExternalStore(sp.subscribe, sp.canSpeak, () => false);
}

// The id of the message speaking now, or null; re-renders on every change.
export function useSpeaking() {
  const sp = getSpeaker();
  return useSyncExternalStore(sp.subscribe, sp.current, () => null);
}

// Speech stops when the thread goes (another tab, the pairing screen) and whenever the
// page is hidden or left: nothing keeps talking from a page nobody is looking at.
export function useStopSpeechWhenAway() {
  useEffect(() => {
    const sp = getSpeaker();
    if (!sp.supported) return undefined;
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
