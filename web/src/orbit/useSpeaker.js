import { useEffect, useSyncExternalStore } from 'react';
import { createSpeaker } from '../lib/orbit/speech.js';

// Read aloud (src/lib/orbit/speech.js): one speaker for the page, over the browser's
// speechSynthesis. `supported` is false where the browser has none, and the page then
// shows no speaker button at all.
let speaker = null;
export function getSpeaker() {
  if (speaker === null) {
    const w = typeof window === 'undefined' ? null : window;
    speaker = createSpeaker({ synth: w?.speechSynthesis ?? null, Utterance: w?.SpeechSynthesisUtterance ?? null });
  }
  return speaker;
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
