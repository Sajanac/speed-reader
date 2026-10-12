// Recorded narration uses the audio clock, including after a background tab resumes.
import { buildDoc, normalize } from './text.js';

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

export function validateAudioManifest(manifest, doc = buildDoc(manifest?.text || '')) {
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.chunks) || !manifest.chunks.length) {
    throw new Error('This audio package has no supported narration.');
  }
  let previous = manifest.chunks[0].from;
  for (const chunk of manifest.chunks) {
    if (!Number.isInteger(chunk.from) || !Number.isInteger(chunk.to) || chunk.from !== previous ||
        chunk.from < 0 || chunk.to <= chunk.from || chunk.to > doc.words.length) {
      throw new Error('Narration chunks do not match the document.');
    }
    if (!(chunk.audio instanceof Blob) && (typeof chunk.audio !== 'string' || !/^(?:data:audio\/[\w.+-]+;base64,|blob:|https?:\/\/|\/)/.test(chunk.audio))) {
      throw new Error('Narration contains an unsupported audio source.');
    }
    if (chunk.duration != null && (!Number.isFinite(chunk.duration) || chunk.duration <= 0)) {
      throw new Error('Narration has an invalid duration.');
    }
    if (!['word', 'sentence'].includes(chunk.timing)) throw new Error('Narration timing type is missing.');
    if (!Array.isArray(chunk.timings) || !chunk.timings.length) throw new Error('Narration has no timing information.');
    let lastStart = -1, lastIndex = chunk.from - 1;
    for (const mark of chunk.timings) {
      if (!Number.isInteger(mark.index) || mark.index < chunk.from || mark.index >= chunk.to || mark.index < lastIndex ||
          !Number.isFinite(mark.start) || !Number.isFinite(mark.end) || mark.start < 0 || mark.end <= mark.start || mark.start < lastStart) {
        throw new Error('Narration has invalid or unordered timing information.');
      }
      lastStart = mark.start;
      lastIndex = mark.index;
    }
    if (chunk.timing === 'word' && (chunk.timings.length !== chunk.to - chunk.from || chunk.timings.some((mark, i) => mark.index !== chunk.from + i))) {
      throw new Error('Narration word timings do not cover the complete passage.');
    }
    if (chunk.timing === 'sentence' && (chunk.timings.length !== 1 || chunk.timings[0].index !== chunk.from)) {
      throw new Error('Narration sentence timing does not match the passage.');
    }
    previous = chunk.to;
  }
  return manifest;
}

export class NativeAudioNarrator {
  constructor({ onWord = () => {}, onState = () => {}, onError = () => {}, onProgress = () => {}, audio } = {}) {
    this.onWord = onWord;
    this.onState = onState;
    this.onError = onError;
    this.onProgress = onProgress;
    this.audio = audio || new Audio();
    this.audio.preload = 'auto';
    this.audio.setAttribute?.('playsinline', '');
    this.rate = 1;
    this.index = 0;
    this.playing = false;
    this.manifest = null;
    this.range = null;
    this._chunk = -1;
    this._ownedURL = null;
    this._pendingTime = 0;
    this._lastMark = '';
    this._frame = 0;
    this._generation = 0;
    this._rangeDone = false;
    this._offsets = null;
    this._listeners = {
      loadedmetadata: () => {
        if (!this.manifest) return;
        const chunk = this.manifest.chunks[this._chunk];
        if (Number.isFinite(this.audio.duration) && this.audio.duration > 0) {
          chunk.duration = this.audio.duration;
          chunk.durationEstimated = false;
          this._offsets = null;
        }
        this._applyTime();
        this._tick();
      },
      timeupdate: () => this._tick(),
      seeking: () => this._tick(),
      ended: () => this._ended(),
      error: () => this._fail(new Error('The narration audio could not be played. Try preparing it again.')),
      pause: () => {
        // Native headphones/lock-screen controls can pause the element directly.
        if (this.playing && !this.audio.ended) this.pause();
      },
      play: () => {
        if (!this.playing && this.manifest) {
          this.playing = true;
          this.onState(true);
          this._schedule();
        }
      },
    };
    for (const [name, listener] of Object.entries(this._listeners)) this.audio.addEventListener(name, listener);
  }

  get length() { return this.doc?.words.length || 0; }
  get timing() { return this.manifest?.chunks[this._chunk]?.timing || null; }
  get currentSpan() {
    const chunk = this.manifest?.chunks[this._chunk];
    return chunk ? { from: chunk.from, to: chunk.to, timing: chunk.timing } : null;
  }
  _durationOffsets() {
    if (!this.manifest) return null;
    if (!this._offsets) {
      this._offsets = new Float64Array(this.manifest.chunks.length + 1);
      this.manifest.chunks.forEach((chunk, i) => { this._offsets[i + 1] = this._offsets[i] + (chunk.duration || 0); });
    }
    return this._offsets;
  }
  get duration() { return this._durationOffsets()?.at(-1) || 0; }
  get currentTime() {
    return (this._durationOffsets()?.[this._chunk] || 0) + (this.audio.currentTime || 0);
  }

  load(doc, text, manifest) {
    this.pause();
    this._generation++;
    validateAudioManifest(manifest, doc);
    if (normalize(manifest.text) !== normalize(text)) throw new Error('This narration belongs to different text.');
    this.doc = doc;
    this.text = text;
    this.manifest = manifest;
    this._offsets = null;
    this.range = null;
    this._rangeDone = false;
    this._chunk = -1;
    this.index = manifest.chunks[0].from;
    this._selectChunk(0, 0);
    this._emit(this.index, manifest.chunks[0]);
  }

  async play() {
    if (!this.manifest || this.playing) return;
    if (this.audio.ended || this._rangeDone) this.seek(this.range?.start ?? this.manifest.chunks[0].from);
    const generation = this._generation;
    this.playing = true;
    this.onState(true);
    this._applyTime();
    try {
      await this.audio.play();
      if (generation !== this._generation) return;
      this._schedule();
    } catch (error) {
      if (generation === this._generation) this._fail(error);
    }
  }

  pause() {
    this._generation++;
    const wasPlaying = this.playing;
    this.playing = false;
    this.audio.pause();
    if (this._frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._frame);
    this._frame = 0;
    if (wasPlaying) this.onState(false);
  }

  toggle() { return this.playing ? this.pause() : this.play(); }

  seek(index) {
    if (!this.manifest) return;
    const first = this.range?.start ?? this.manifest.chunks[0].from;
    const last = (this.range?.end ?? this.manifest.chunks.at(-1).to) - 1;
    const wanted = clamp(Math.round(Number(index) || 0), first, last);
    const part = this.manifest.chunks.findIndex((chunk) => wanted >= chunk.from && wanted < chunk.to);
    const chunk = this.manifest.chunks[part];
    const mark = chunk.timings.find((entry) => entry.index >= wanted) || chunk.timings.at(-1);
    const resume = this.playing;
    this.pause();
    this._rangeDone = false;
    this.index = chunk.timing === 'sentence' ? chunk.from : mark.index;
    this._selectChunk(part, chunk.timing === 'sentence' ? 0 : mark.start);
    this._emit(this.index, chunk);
    if (resume) void this.play();
  }

  skip(delta) { this.seek(this.index + delta); }
  skipSeconds(delta) {
    if (!this.manifest || !Number.isFinite(delta)) return;
    let target = Math.max(0, this.currentTime + delta);
    const bounds = this._rangeClockBounds();
    if (bounds) target = clamp(target, bounds.start, Math.max(bounds.start, bounds.end - 0.001));
    let part = 0;
    while (part < this.manifest.chunks.length - 1 && target >= (this.manifest.chunks[part].duration || Infinity)) {
      target -= this.manifest.chunks[part].duration;
      part++;
    }
    const chunk = this.manifest.chunks[part];
    if (this.range) {
      const candidate = chunk.timings.filter((mark) => mark.start <= target).at(-1) || chunk.timings[0];
      if (candidate.index < this.range.start) { this.seek(this.range.start); return; }
      if (candidate.index >= this.range.end) { this.seek(this.range.end - 1); return; }
    }
    const resume = this.playing;
    this.pause();
    this._rangeDone = false;
    this._selectChunk(part, Math.min(target, chunk.duration || target));
    this._tick();
    if (resume) void this.play();
  }

  setRate(rate) {
    this.rate = clamp(Number(rate) || 1, 0.5, 3);
    this.audio.playbackRate = this.rate;
    this.audio.preservesPitch = true;
  }

  setRange(start, end) {
    if (!this.manifest || !Number.isInteger(start) || !Number.isInteger(end) || start >= end ||
        start < this.manifest.chunks[0].from || end > this.manifest.chunks.at(-1).to) throw new Error('Choose a valid passage in the prepared audio.');
    for (const chunk of this.manifest.chunks) {
      if (chunk.timing === 'sentence' && ((start > chunk.from && start < chunk.to) || (end > chunk.from && end < chunk.to))) {
        throw new Error('Prepare this selected passage to read exactly these words with the browser voice.');
      }
    }
    this.range = { start, end };
    this.seek(start);
  }
  cancelRange() { this.range = null; this._rangeDone = false; }

  _rangeClockBounds() {
    if (!this.range) return null;
    let offset = 0, start, end;
    for (const chunk of this.manifest.chunks) {
      if (this.range.start >= chunk.from && this.range.start < chunk.to) {
        const mark = chunk.timings.find((entry) => entry.index === this.range.start);
        start = offset + (chunk.timing === 'word' ? mark.start : 0);
      }
      if (this.range.end > chunk.from && this.range.end <= chunk.to) {
        const mark = chunk.timings.find((entry) => entry.index === this.range.end - 1);
        const last = chunk.timing === 'word' ? mark.end : chunk.duration;
        if (!Number.isFinite(last)) return null;
        end = offset + last;
        break;
      }
      if (!Number.isFinite(chunk.duration)) return null;
      offset += chunk.duration;
    }
    return Number.isFinite(start) && Number.isFinite(end) ? { start, end } : null;
  }

  _selectChunk(part, seconds) {
    this._pendingTime = seconds;
    this._lastMark = '';
    if (part !== this._chunk) {
      if (this._ownedURL) URL.revokeObjectURL(this._ownedURL);
      this._ownedURL = null;
      this._chunk = part;
      const audio = this.manifest.chunks[part].audio;
      this.audio.src = audio instanceof Blob ? (this._ownedURL = URL.createObjectURL(audio)) : audio;
      this.audio.load?.();
    }
    this.audio.playbackRate = this.rate;
    this._applyTime();
  }
  _applyTime() {
    if (this._pendingTime == null || this.audio.readyState === 0) return;
    try {
      this.audio.currentTime = this._pendingTime;
      this._pendingTime = null;
    } catch { /* Apply again when metadata is loaded. */ }
  }
  _emit(index, chunk) {
    this.index = index;
    this.onWord(index, { from: chunk.timing === 'word' ? index : chunk.from, to: chunk.timing === 'word' ? index + 1 : chunk.to, timing: chunk.timing });
  }
  _tick() {
    const chunk = this.manifest?.chunks[this._chunk];
    if (!chunk || this._pendingTime != null) return;
    const now = this.audio.currentTime || 0;
    let mark = chunk.timings[0];
    for (const entry of chunk.timings) {
      if (entry.start > now) break;
      mark = entry;
    }
    if (this.range && this.playing) {
      const lastMark = chunk.timings.filter((entry) => entry.index < this.range.end).at(-1);
      const sentenceEnd = Number.isFinite(this.audio.duration) && this.audio.duration > 0 ? this.audio.duration : chunk.duration;
      const rangeEnd = chunk.timing === 'sentence' ? sentenceEnd : lastMark?.end;
      if (mark.index >= this.range.end || (chunk.to >= this.range.end && rangeEnd && now >= rangeEnd)) {
        this._rangeDone = true;
        this.pause();
        return;
      }
    }
    const key = `${this._chunk}:${mark.index}`;
    if (this._lastMark !== key) {
      this._lastMark = key;
      this._emit(mark.index, chunk);
    }
    this.onProgress({ currentTime: this.currentTime, duration: this.duration, chunk: this._chunk, index: this.index });
  }
  _schedule() {
    if (this._frame || !this.playing || typeof requestAnimationFrame !== 'function') return;
    this._frame = requestAnimationFrame(() => {
      this._frame = 0;
      this._tick();
      this._schedule();
    });
  }
  _ended() {
    if (!this.manifest || !this.playing) return;
    const next = this._chunk + 1;
    const chunk = this.manifest.chunks[next];
    if (chunk && (!this.range || chunk.from < this.range.end)) {
      // Keep playback intent while changing the media source.
      this.playing = false;
      this._selectChunk(next, 0);
      void this.play();
    } else {
      this._rangeDone = true;
      this._emit(Math.min(this.range?.end ?? this.manifest.chunks.at(-1).to, this.manifest.chunks.at(-1).to) - 1, this.manifest.chunks[this._chunk]);
      this.pause();
    }
  }
  _fail(error) { this.pause(); this.onError(error instanceof Error ? error.message : String(error)); }
  reset() {
    this.pause();
    if (this._ownedURL) URL.revokeObjectURL(this._ownedURL);
    this._ownedURL = null;
    this.manifest = null;
    this._offsets = null;
    this.doc = null;
    this.text = '';
    this.range = null;
    this._rangeDone = false;
    this._chunk = -1;
    this._pendingTime = null;
    this.audio.removeAttribute?.('src');
    this.audio.load?.();
  }
  unload() { this.reset(); }
  dispose() {
    this.reset();
    for (const [name, listener] of Object.entries(this._listeners)) this.audio.removeEventListener(name, listener);
  }
}
