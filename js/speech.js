// Text-to-speech using the browser's Web Speech API. In Safari this uses the
// system (Apple) voices installed on the device.

import { speechChunk, offsetToIndex } from './text.js';
import { graphemes } from './orp.js';

// Rough speaking speed of a voice at rate 1.0. Used to map WPM to a speech
// rate and to estimate word timing when the browser sends no word events.
export const SPEECH_BASE_WPM = 180;

// Novelty voices shipped with macOS/iOS that are not useful for reading.
const NOVELTY = new Set([
  'Albert', 'Bad News', 'Bahh', 'Bells', 'Boing', 'Bubbles', 'Cellos', 'Deranged', 'Good News',
  'Hysterical', 'Jester', 'Organ', 'Pipe Organ', 'Superstar', 'Trinoids', 'Whisper', 'Wobble', 'Zarvox',
]);

// iOS Safari starts pages in the "ambient" audio category, which the
// ring/silent switch mutes, speech included. Ask for "playback" (like a media
// app) once at startup; changing it mid-session can stop audio entirely.
export function claimPlaybackAudio() {
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
  } catch {
    // Not supported; unlockAudio() covers older iOS.
  }
}

let unlocked = false;

// Fallback for Safari without navigator.audioSession (before iOS 16.4):
// playing a moment of silence from a tap moves the page off "ambient".
export function unlockAudio() {
  if (unlocked || typeof Audio === 'undefined' || typeof navigator === 'undefined' || navigator.audioSession) return;
  unlocked = true;
  try {
    const n = 800;
    const buf = new ArrayBuffer(44 + n);
    const v = new DataView(buf);
    const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF');
    v.setUint32(4, 36 + n, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); // PCM
    v.setUint16(22, 1, true); // mono
    v.setUint32(24, 8000, true);
    v.setUint32(28, 8000, true);
    v.setUint16(32, 1, true);
    v.setUint16(34, 8, true);
    str(36, 'data');
    v.setUint32(40, n, true);
    for (let i = 0; i < n; i++) v.setUint8(44 + i, 128); // 8-bit silence
    const a = new Audio(URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })));
    a.setAttribute('playsinline', '');
    a.play().catch(() => {});
  } catch {
    // Best effort only.
  }
}

export const speechSupported = () =>
  typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;

const quality = (v) => (/premium/i.test(v.name) ? 2 : /enhanced/i.test(v.name) ? 1 : 0);

// Voices sorted with the user's language first, then higher quality first.
export function listVoices() {
  if (!speechSupported()) return [];
  const lang = (navigator.language || 'en').toLowerCase().split('-')[0];
  return speechSynthesis
    .getVoices()
    .filter((v) => !NOVELTY.has(v.name.replace(/\s*\(.*\)$/, '')))
    .sort((a, b) => {
      const la = a.lang.toLowerCase().startsWith(lang) ? 0 : 1;
      const lb = b.lang.toLowerCase().startsWith(lang) ? 0 : 1;
      return (
        la - lb || quality(b) - quality(a) || Number(b.default) - Number(a.default) || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name)
      );
    });
}

export function pickVoice(voiceURI) {
  const voices = listVoices();
  // Default: the best-quality voice in the user's language (see sort above).
  return voices.find((v) => v.voiceURI === voiceURI) || voices[0] || null;
}

export function voiceLabel(v) {
  return `${v.name} (${v.lang})`;
}

export class Speaker {
  constructor() {
    this.onWord = () => {};
    this.onEnd = () => {};
    this.onError = () => {};
    this._gen = 0;
    this._utt = null;
    this._est = 0;
    this.boundarySeen = false; // true once the browser has sent a word event
    this._marks = [];
  }

  // Speak words from `index` onward. Must be called from a user gesture the
  // first time on iOS.
  start(words, index, { rate, voice }) {
    this.stop();
    unlockAudio();
    // iOS can leave the synthesiser paused after an interruption.
    if (speechSynthesis.paused) speechSynthesis.resume();
    this._words = words;
    this._rate = rate;
    this._voice = voice;
    this._marks = [];
    this._speakFrom(this._gen, index);
  }

  stop() {
    this._gen++;
    clearTimeout(this._est);
    this._utt = null;
    if (speechSupported() && (speechSynthesis.speaking || speechSynthesis.pending)) speechSynthesis.cancel();
  }

  // Words per minute measured from recent word events, or 0 if unknown.
  get measuredWpm() {
    const m = this._marks;
    if (m.length < 8) return 0;
    const words = m[m.length - 1].i - m[0].i;
    const ms = m[m.length - 1].t - m[0].t;
    return ms > 0 && words > 0 ? Math.round((words * 60000) / ms) : 0;
  }

  _mark(i) {
    this._marks.push({ i, t: performance.now() });
    if (this._marks.length > 30) this._marks.shift();
    this.onWord(i);
  }

  _speakFrom(gen, index) {
    const words = this._words;
    if (index >= words.length) {
      this.onEnd();
      return;
    }
    const { text, offsets, end } = speechChunk(words, index);
    const u = new SpeechSynthesisUtterance(text);
    u.rate = this._rate;
    if (this._voice) {
      u.voice = this._voice;
      u.lang = this._voice.lang;
    }
    let boundaryHere = false;
    u.onstart = () => {
      if (gen !== this._gen) return;
      this._mark(index);
      if (!this.boundarySeen) this._estimate(gen, index, end);
    };
    u.onboundary = (e) => {
      if (gen !== this._gen || (e.name && e.name !== 'word')) return;
      boundaryHere = true;
      this.boundarySeen = true;
      clearTimeout(this._est);
      this._mark(index + offsetToIndex(offsets, e.charIndex));
    };
    u.onend = () => {
      if (gen !== this._gen) return;
      clearTimeout(this._est);
      if (!boundaryHere) this.onWord(end - 1);
      this._speakFrom(gen, end);
    };
    u.onerror = (e) => {
      if (gen !== this._gen) return;
      clearTimeout(this._est);
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      this.onError(e.error || 'speech error');
    };
    this._utt = u; // keep a reference so the utterance isn't garbage collected
    speechSynthesis.speak(u);
  }

  // Fallback when the browser sends no word events: advance words on a timer
  // using an estimated speaking speed, weighted by word length.
  _estimate(gen, from, end) {
    const msPerChar = 60000 / (SPEECH_BASE_WPM * this._rate * 6);
    let i = from;
    const step = () => {
      if (gen !== this._gen || this.boundarySeen) return;
      const delay = (graphemes(this._words[i].t).length + 1) * msPerChar;
      this._est = setTimeout(() => {
        if (gen !== this._gen || this.boundarySeen || i + 1 >= end) return;
        i++;
        this.onWord(i);
        step();
      }, delay);
    };
    step();
  }
}
