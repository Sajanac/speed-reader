import { Player } from './engine.js?v=20261016';
import { NativeAudioNarrator } from './narration.js?v=20261016';

// One position shared by timed reading, device speech, and prepared audio.
export class ReadingPlayback {
  constructor({ onWord, onState, onError, onProgress = () => {} }) {
    this._index = 0;
    this._speech = false;
    this.engine = 'device';
    this.manifest = null;
    this.loading = false;
    const word = (source, index, span) => {
      if (this.loading || this.active !== source) return;
      this._index = index;
      onWord(index, span);
    };
    this.timer = new Player({ onWord: (i) => word(this.timer, i), onState, onError });
    this.audio = new NativeAudioNarrator({ onWord: (i, span) => word(this.audio, i, span), onState,
      onError: (error) => onError(error.message || String(error)), onProgress });
    this.onWord = onWord;
    this.onError = onError;
  }
  get usesAudio() { return this._speech && this.engine !== 'device' && !!this.manifest; }
  get active() { return this.usesAudio ? this.audio : this.timer; }
  get playing() { return this.active.playing; }
  get index() { return this._index; }
  get speech() { return this._speech; }
  set speech(value) { this.setSpeech(value); }
  get speaker() { return this.timer.speaker; }
  get voice() { return this.timer.voice; }
  set voice(value) { this.timer.voice = value; }
  get wpm() { return this.timer.wpm; }
  set wpm(value) { this.timer.wpm = value; }
  get rate() { return this.timer.rate; }
  get range() { return this.active.range; }
  unload() {
    this.pause();
    this.audio.reset();
    this.manifest = null;
    this.doc = null;
    this.text = '';
    this.timer.doc = null;
    this.timer.index = this._index = 0;
  }
  load(doc, text, index = 0) {
    this.pause();
    this.loading = true;
    this.doc = doc;
    this.text = text;
    this.manifest = null;
    this.audio.reset();
    this.timer.load(doc, index);
    this.loading = false;
    this._index = this.timer.index;
    this.onWord(this._index);
  }
  attachAudio(manifest) {
    const index = this.index;
    this.pause();
    this.loading = true;
    try {
      this.audio.load(this.doc, this.text, manifest);
      this.audio.setRate(this.rate);
      this.manifest = manifest;
    } catch (error) {
      this.manifest = null;
      this.audio.reset();
      this.timer.seek(index);
      throw error;
    } finally { this.loading = false; }
    this.seek(Math.max(manifest.chunks[0].from, Math.min(manifest.chunks.at(-1).to - 1, index)));
  }
  setEngine(engine) {
    const index = this.index;
    this.pause();
    this.engine = engine;
    this.timer.setSpeech(this._speech && engine === 'device');
    this.seek(index);
  }
  setSpeech(on) {
    if (this._speech === !!on) return;
    const index = this.index;
    this.pause();
    this._speech = !!on;
    this.timer.setSpeech(this._speech && this.engine === 'device');
    if (this.doc) this.seek(index);
  }
  setRate(rate) { this.timer.setRate(rate); this.audio.setRate(rate); }
  setWpm(wpm) { this.timer.setWpm(wpm); }
  setVoice(voice) { this.timer.setVoice(voice); }
  play() {
    if (this._speech && this.engine !== 'device' && !this.manifest) {
      this.onError('Prepare narration first, or choose a device voice.');
      return;
    }
    return this.active.play();
  }
  pause() { this.timer.pause(); this.audio.pause(); }
  toggle() { return this.playing ? this.pause() : this.play(); }
  seek(index, options) {
    if (!this.doc) return;
    // A prepared chapter does not trap navigation inside that chapter.
    if (this.usesAudio && (index < this.manifest.chunks[0].from || index >= this.manifest.chunks.at(-1).to)) this.removeAudio();
    this.active.seek(index, options);
  }
  skip(delta) { this.seek(this.index + delta); }
  skipSeconds(delta) { if (this.usesAudio) this.audio.skipSeconds(delta); else this.skip(Math.round(delta * 3 * this.rate)); }
  setRange(start, end) { this.pause(); this.active.setRange(start, end); }
  cancelRange() { this.timer.cancelRange(); this.audio.cancelRange(); }
  removeAudio() {
    const index = this.index;
    this.pause();
    this.manifest = null;
    this.audio.reset();
    this.timer.seek(index);
  }
}
