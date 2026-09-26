// Playback engine. Silent mode shows words on a timer driven by WPM and the
// dwell-time factors; read-aloud mode lets the voice drive word timing.

import { Speaker, SPEECH_BASE_WPM } from './speech.js';

export const MIN_WPM = 100;
export const MAX_WPM = 1000;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class Player {
  constructor({ onWord = () => {}, onState = () => {}, onError = () => {}, speaker = new Speaker() } = {}) {
    this.onWord = onWord;
    this.onState = onState;
    this.onError = onError;
    this.speaker = speaker;
    this.doc = null;
    this.index = 0;
    this.wpm = 300;
    this.speech = false;
    this.voice = null;
    this._playing = false;
    this._timer = 0;
    this._restart = 0;
    this._due = 0;

    speaker.onWord = (i) => {
      if (!this._playing || i < 0 || i >= this.length) return;
      this.index = i;
      this.onWord(i);
    };
    speaker.onEnd = () => {
      if (!this._playing) return;
      this.index = this.length - 1;
      this.pause();
    };
    speaker.onError = (err) => {
      this.pause();
      this.onError(err);
    };
  }

  get length() {
    return this.doc ? this.doc.words.length : 0;
  }

  get playing() {
    return this._playing;
  }

  // Speech rate for the current WPM (1.0 is the voice's normal speed).
  get rate() {
    return clamp(this.wpm / SPEECH_BASE_WPM, 0.1, 10);
  }

  load(doc, index = 0) {
    this.pause();
    this.doc = doc;
    this.index = clamp(index | 0, 0, Math.max(0, this.length - 1));
    this.onWord(this.index);
  }

  play() {
    if (!this.length || this._playing) return;
    if (this.index >= this.length - 1) this.index = 0;
    this._playing = true;
    this.onState(true);
    this._start();
  }

  pause() {
    if (!this._playing) return;
    this._playing = false;
    this._stop();
    this.onState(false);
  }

  toggle() {
    if (this._playing) this.pause();
    else this.play();
  }

  seek(i, { debounceSpeech = false } = {}) {
    if (!this.length) return;
    this.index = clamp(Math.round(i), 0, this.length - 1);
    this.onWord(this.index);
    if (!this._playing) return;
    if (this.speech && debounceSpeech) {
      this._stop();
      this._restart = setTimeout(() => this._playing && this._start(), 300);
    } else {
      this._stop();
      this._start();
    }
  }

  skip(delta) {
    this.seek(this.index + delta);
  }

  setWpm(wpm) {
    this.wpm = clamp(Math.round(wpm), MIN_WPM, MAX_WPM);
    // A speech utterance's rate is fixed once it starts, so restart from the
    // current word. Silent mode picks the new speed up on the next word.
    if (this._playing && this.speech) {
      clearTimeout(this._restart);
      this._restart = setTimeout(() => {
        if (!this._playing) return;
        this._stop();
        this._start();
      }, 300);
    }
  }

  setSpeech(on) {
    if (this.speech === on) return;
    if (this._playing) this._stop();
    this.speech = on;
    if (this._playing) this._start();
  }

  setVoice(voice) {
    this.voice = voice;
    if (this._playing && this.speech) {
      this._stop();
      this._start();
    }
  }

  _start() {
    if (this.speech) {
      this.onWord(this.index);
      this.speaker.start(this.doc.words, this.index, { rate: this.rate, voice: this.voice });
    } else {
      this.onWord(this.index);
      this._due = performance.now();
      this._schedule();
    }
  }

  _stop() {
    clearTimeout(this._timer);
    clearTimeout(this._restart);
    this.speaker.stop();
  }

  _schedule() {
    const now = performance.now();
    // If timers were throttled (background tab), don't burst to catch up.
    if (this._due < now - 250) this._due = now;
    this._due += (60000 / this.wpm) * this.doc.factors[this.index];
    this._timer = setTimeout(() => {
      if (!this._playing) return;
      if (this.index >= this.length - 1) {
        this.pause();
        return;
      }
      this.index++;
      this.onWord(this.index);
      this._schedule();
    }, Math.max(0, this._due - performance.now()));
  }
}
