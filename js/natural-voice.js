// No hosted TTS account is used. Downloadable browser inference is opt-in;
// the local adapter calls the user's own Kokoro-FastAPI service.
import { buildDoc, normalize, endsSentence } from './text.js?v=20261016';
import { validateAudioManifest } from './narration.js?v=20261016';

export const BROWSER_RUNTIME = 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js';
export const BROWSER_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
export const NATURAL_VOICES = [
  { id: 'af_heart', name: 'Heart · American English' },
  { id: 'af_bella', name: 'Bella · American English' },
  { id: 'af_nicole', name: 'Nicole · American English' },
  { id: 'am_michael', name: 'Michael · American English' },
  { id: 'bm_george', name: 'George · British English' },
  { id: 'bf_emma', name: 'Emma · British English' },
];

const aborted = (signal) => { if (signal?.aborted) throw new DOMException('Voice preparation canceled.', 'AbortError'); };
const key = (value) => String(value).normalize('NFKC').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]/gu, '');

export function narrationSegments(doc, text, { from = 0, to = doc.words.length, maxChars = 700 } = {}) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from || to > doc.words.length) throw new Error('Choose a nonempty passage to prepare.');
  const out = [];
  let start = from;
  while (start < to) {
    let end = start;
    while (end < to) {
      const candidate = doc.words[end];
      if (end > start && candidate.s + candidate.t.length - doc.words[start].s > maxChars) break;
      end++;
      if (candidate.p || endsSentence(candidate.t)) break;
    }
    const first = doc.words[start], last = doc.words[end - 1];
    if (last.s + last.t.length - first.s > maxChars) throw new Error('A word is too long for the voice model. Split the text before preparing audio.');
    out.push({ from: start, to: end, text: text.slice(first.s, last.s + last.t.length), offset: first.s });
    start = end;
  }
  return out;
}

// Strictly map the spoken tokens back to displayed words. A mismatch falls
// back to the whole sentence rather than inventing word timing.
export function mapCaptionTimings(words, from, to, captions) {
  if (!Array.isArray(captions) || !captions.length) return null;
  const source = words.slice(from, to).map((word) => key(word.t));
  const combined = source.join('');
  if (!combined) return null;
  const ends = [];
  let offset = 0;
  for (const part of source) { offset += part.length; ends.push(offset); }
  let cursor = 0, lastStart = -1;
  const marks = [];
  for (const caption of captions) {
    const token = key(caption.word ?? caption.text ?? '');
    if (!token) continue;
    const start = Number(caption.start_time ?? caption.start), end = Number(caption.end_time ?? caption.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || start < lastStart || !combined.startsWith(token, cursor)) return null;
    const first = ends.findIndex((value) => value > cursor);
    const finish = cursor + token.length;
    // A timing token spanning multiple display words cannot promise their
    // individual boundaries. Preserve sentence highlighting in that case.
    if (first < 0 || finish > ends[first]) return null;
    const index = from + first;
    const previous = marks.at(-1);
    if (previous?.index === index) previous.end = end;
    else marks.push({ index, start, end });
    cursor = finish;
    lastStart = start;
  }
  if (cursor !== combined.length || !marks.length) return null;
  // Pure punctuation words can share the preceding spoken token's boundary.
  for (let i = from; i < to; i++) {
    if (!source[i - from] && !marks.some((mark) => mark.index === i)) {
      const previous = marks.filter((mark) => mark.index < i).at(-1) || marks[0];
      marks.push({ index: i, start: previous.start, end: previous.end });
    }
  }
  marks.sort((a, b) => a.index - b.index);
  return marks;
}

export function validateLocalEndpoint(endpoint = '/local-voice', token = '', origin = globalThis.location?.origin) {
  const base = origin || 'http://localhost';
  let url;
  try { url = new URL(endpoint, base); } catch { throw new Error('Enter a valid local voice endpoint.'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('Use a voice endpoint without credentials, query parameters, or a fragment.');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const sameOrigin = url.origin === base;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Use the loopback voice helper or an authenticated HTTPS voice service.');
  }
  if (!sameOrigin && !loopback && !token.trim()) throw new Error('An external HTTPS voice service requires an access token.');
  return url.href.replace(/\/$/, '');
}

export function base64Audio(value, type = 'audio/mpeg') {
  if (typeof value !== 'string' || !value.length || value.length > 30_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('The voice service returned invalid audio.');
  let decoded;
  try { decoded = atob(value); } catch { throw new Error('The voice service returned invalid audio.'); }
  if (decoded.length < 44) throw new Error('The voice service returned an empty audio clip.');
  return new Blob([Uint8Array.from(decoded, (char) => char.charCodeAt(0))], { type: /^audio\/[\w.+-]+$/.test(type) ? type : 'audio/mpeg' });
}

export async function probeAudioDuration(blob, { signal, audioFactory = () => new Audio() } = {}) {
  aborted(signal);
  const audio = audioFactory(), url = URL.createObjectURL(blob);
  audio.preload = 'metadata';
  try {
    return await new Promise((resolve, reject) => {
      let timeout;
      const cleanup = () => {
        clearTimeout(timeout);
        audio.removeEventListener('loadedmetadata', loaded);
        audio.removeEventListener('error', failed);
        signal?.removeEventListener('abort', canceled);
      };
      const finish = (callback, value) => { cleanup(); callback(value); };
      const loaded = () => Number.isFinite(audio.duration) && audio.duration > 0
        ? finish(resolve, audio.duration)
        : finish(reject, new Error('The voice returned audio without a usable duration.'));
      const failed = () => finish(reject, new Error('The voice returned an audio clip that this browser cannot decode.'));
      const canceled = () => finish(reject, new DOMException('Voice preparation canceled.', 'AbortError'));
      audio.addEventListener('loadedmetadata', loaded);
      audio.addEventListener('error', failed);
      signal?.addEventListener('abort', canceled, { once: true });
      timeout = setTimeout(() => finish(reject, new Error('The browser could not read the narration duration. Try a shorter passage.')), 30_000);
      audio.src = url;
      audio.load?.();
    });
  } finally {
    URL.revokeObjectURL(url);
    audio.removeAttribute?.('src');
    audio.load?.();
  }
}

async function localSegment(segment, words, options) {
  const endpoint = validateLocalEndpoint(options.endpoint, options.token || '');
  const controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(cancel, 180_000);
  try {
    aborted(options.signal);
    const response = await (options.fetch || fetch)(`${endpoint}/dev/captioned_speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) },
      body: JSON.stringify({ model: 'kokoro', input: segment.text, voice: options.voice, speed: 1, response_format: 'mp3', stream: false, return_timestamps: true, normalization_options: { normalize: false } }),
      signal: controller.signal,
      credentials: 'same-origin',
    });
    if (!response.ok) throw new Error(`Local voice could not prepare audio (HTTP ${response.status}). Check that Kokoro-FastAPI is running.`);
    const payload = await response.json();
    aborted(options.signal);
    const audio = base64Audio(payload.audio, payload.audio_format);
    const marks = mapCaptionTimings(words, segment.from, segment.to, payload.timestamps);
    const usableEnd = Array.isArray(payload.timestamps) ? payload.timestamps.reduce((max, mark) => {
      const end = Number(mark.end_time ?? mark.end);
      return Number.isFinite(end) && end > max ? end : max;
    }, 0) : 0;
    const duration = usableEnd || await probeAudioDuration(audio, { signal: controller.signal, audioFactory: options.audioFactory });
    // Caption end time estimates the clip duration until its actual media
    // metadata is loaded. Missing captions require a real duration probe.
    return { audio, from: segment.from, to: segment.to, text: segment.text,
      duration, durationEstimated: !!usableEnd,
      timings: marks || [{ index: segment.from, start: 0, end: duration }],
      timing: marks ? 'word' : 'sentence',
      timingNote: marks ? null : 'The service did not return word timings that match this passage. Highlighting follows the sentence.',
    };
  } catch (error) {
    if (controller.signal.aborted && !options.signal?.aborted) throw new Error('The local voice took too long. Try a shorter passage or check the service.');
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', cancel);
  }
}

function browserWorker(onProgress, signal) {
  if (typeof Worker === 'undefined') throw new Error('This browser cannot run the local voice worker. Use the local API or a device voice.');
  const worker = new Worker(new URL('./natural-voice.js?v=20261016', import.meta.url), { type: 'module' });
  let id = 0;
  const pending = new Map();
  const cancel = () => {
    worker.terminate();
    for (const task of pending.values()) task.reject(new DOMException('Voice preparation canceled.', 'AbortError'));
    pending.clear();
  };
  signal?.addEventListener('abort', cancel, { once: true });
  worker.onmessage = ({ data }) => {
    if (data.progress) { onProgress(data.progress); return; }
    const task = pending.get(data.id);
    if (!task) return;
    pending.delete(data.id);
    if (data.error) task.reject(new Error(data.error)); else task.resolve(data.result);
  };
  worker.onerror = () => {
    for (const task of pending.values()) task.reject(new Error('The browser voice could not load. Check your connection and try the local API or a device voice.'));
    pending.clear();
  };
  return {
    request(data) {
      aborted(signal);
      return new Promise((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); worker.postMessage({ ...data, id: next }); });
    },
    dispose() { signal?.removeEventListener('abort', cancel); worker.terminate(); },
  };
}

export async function prepareNaturalVoice(options) {
  const { doc, text: originalText, engine = 'browser', voice = 'af_heart', signal, onProgress = () => {} } = options;
  if (!['browser', 'local'].includes(engine)) throw new Error('Choose a supported natural voice engine.');
  if (!NATURAL_VOICES.some((entry) => entry.id === voice)) throw new Error('Choose one of the available English natural voices.');
  aborted(signal);
  const text = normalize(originalText);
  const readingDoc = doc || buildDoc(text);
  const segments = narrationSegments(readingDoc, text, { from: options.from ?? 0, to: options.to ?? readingDoc.words.length, maxChars: engine === 'browser' ? 230 : 700 });
  let worker;
  const chunks = [];
  try {
    if (engine === 'browser') {
      worker = browserWorker(onProgress, signal);
      await worker.request({ action: 'load' });
    }
    for (let i = 0; i < segments.length; i++) {
      aborted(signal);
      const segment = segments[i];
      onProgress({ phase: 'generating', completed: i, total: segments.length, progress: i / segments.length * 100 });
      if (engine === 'local') chunks.push(await localSegment(segment, readingDoc.words, { ...options, voice }));
      else {
        const results = await worker.request({ action: 'generate', text: segment.text, voice });
        let cursor = 0, covered = segment.from;
        for (const result of results) {
          const offset = segment.text.indexOf(result.text, cursor);
          if (offset < 0 || key(segment.text.slice(cursor, offset)) || result.phonemes.length > 510) throw new Error('The voice could not safely read this passage. Use the local API or shorten the text.');
          const absoluteEnd = segment.offset + offset + result.text.length;
          let to = covered;
          while (to < segment.to && readingDoc.words[to].s < absoluteEnd) to++;
          if (to <= covered) throw new Error('The voice returned audio that does not match the passage.');
          chunks.push({ from: covered, to, text: result.text, audio: new Blob([result.wav], { type: 'audio/wav' }), duration: result.duration,
            timing: 'sentence', timings: [{ index: covered, start: 0, end: result.duration }],
            timingNote: 'Browser Kokoro supplies sentence audio, so highlighting follows the spoken sentence.' });
          covered = to;
          cursor = offset + result.text.length;
        }
        if (covered !== segment.to || key(segment.text.slice(cursor))) throw new Error('The voice returned an incomplete passage. Try the local voice API.');
      }
    }
    aborted(signal);
    const manifest = { version: 1, text, engine, voice, createdAt: new Date().toISOString(), chunks };
    validateAudioManifest(manifest, readingDoc);
    onProgress({ phase: 'ready', completed: segments.length, total: segments.length, progress: 100 });
    return manifest;
  } finally { worker?.dispose(); }
}

export function pcmToWav(samples, sampleRate = 24000) {
  if (!samples.length || !Number.isFinite(sampleRate) || sampleRate < 8000) throw new Error('The voice generated no usable audio.');
  const bytes = new ArrayBuffer(44 + samples.length * 2), view = new DataView(bytes);
  const write = (offset, string) => [...string].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  write(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, 'data'); view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767)), true));
  return bytes;
}

async function audioDataURL(source) {
  if (typeof source === 'string' && source.startsWith('data:audio/')) return source;
  if (!(source instanceof Blob)) throw new Error('Only downloaded audio can be included in a transfer package.');
  const bytes = new Uint8Array(await source.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 16384) binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  return `data:${source.type || 'audio/mpeg'};base64,${btoa(binary)}`;
}

export async function serializeAudioPackage(manifest, metadata = {}) {
  validateAudioManifest(manifest);
  const chunks = [];
  for (const chunk of manifest.chunks) chunks.push({ ...chunk, audio: await audioDataURL(chunk.audio) });
  return new Blob([JSON.stringify({ type: 'reader-audio-package', version: 1, metadata, manifest: { ...manifest, chunks } })], { type: 'application/json' });
}

export async function exportNarrationAudio(manifest) {
  validateAudioManifest(manifest);
  const audio = manifest.chunks.map((chunk) => chunk.audio);
  if (audio.some((source) => !(source instanceof Blob))) throw new Error('Download or import the audio before exporting it.');
  const waves = audio.every((source) => source.type === 'audio/wav');
  const mp3s = audio.every((source) => ['audio/mpeg', 'audio/mp3'].includes(source.type));
  if (!waves && !mp3s) throw new Error('This narration mixes audio formats. Export a transfer package instead.');
  const bytes = await Promise.all(audio.map(async (source) => new Uint8Array(await source.arrayBuffer())));
  if (mp3s) {
    // Independent MP3 chunks can be played sequentially in one file. Drop
    // repeated ID3 tags; some players' duration/seek estimates can still vary.
    const parts = bytes.map((part) => {
      let start = 0, end = part.length;
      if (part[0] === 73 && part[1] === 68 && part[2] === 51 && part.length >= 10) {
        const size = ((part[6] & 127) << 21) | ((part[7] & 127) << 14) | ((part[8] & 127) << 7) | (part[9] & 127);
        start = Math.min(part.length, size + 10 + ((part[5] & 16) ? 10 : 0));
      }
      if (end - start >= 128 && part[end - 128] === 84 && part[end - 127] === 65 && part[end - 126] === 71) end -= 128;
      return part.subarray(start, end);
    });
    return new Blob(parts, { type: 'audio/mpeg' });
  }
  const header = bytes[0].slice(0, 44);
  if (header.length !== 44) throw new Error('Invalid browser narration WAV.');
  const base = new DataView(header.buffer);
  let total = 0;
  for (const part of bytes) {
    const view = new DataView(part.buffer, part.byteOffset, part.byteLength);
    if (part.length < 44 || String.fromCharCode(...part.slice(0, 4)) !== 'RIFF' || String.fromCharCode(...part.slice(36, 40)) !== 'data' ||
        view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1 || view.getUint16(34, true) !== 16 || view.getUint32(24, true) !== base.getUint32(24, true)) {
      throw new Error('WAV chunks have incompatible formats. Export a transfer package instead.');
    }
    total += part.length - 44;
  }
  if (total > 0xffffffff - 36) throw new Error('This audiobook is too large for a WAV file. Export chapters separately.');
  base.setUint32(4, total + 36, true);
  base.setUint32(40, total, true);
  return new Blob([header, ...bytes.map((part) => part.subarray(44))], { type: 'audio/wav' });
}

export async function importAudioPackage(input) {
  let raw;
  if (input instanceof Blob) {
    if (input.size > 150_000_000) throw new Error('This audio package is too large. Export one chapter at a time.');
    raw = await input.text();
  } else if (typeof input === 'string') {
    if (input.length > 150_000_000) throw new Error('This audio package is too large. Export one chapter at a time.');
    raw = input;
  }
  else raw = input;
  const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (payload?.type !== 'reader-audio-package' || payload.version !== 1 || typeof payload.manifest?.text !== 'string') throw new Error('Choose a reader audio package.');
  if (payload.manifest.text.length > 2_000_000 || payload.manifest.chunks?.length > 20000) throw new Error('This audio package exceeds the supported document size.');
  // Imported packages contain their own audio; they never fetch a supplied URL.
  for (const chunk of payload.manifest.chunks || []) {
    if (typeof chunk.audio !== 'string' || !/^data:audio\/[\w.+-]+;base64,/.test(chunk.audio)) throw new Error('The package must include its audio files.');
    const comma = chunk.audio.indexOf(',');
    chunk.audio = base64Audio(chunk.audio.slice(comma + 1), chunk.audio.slice(5, chunk.audio.indexOf(';')));
  }
  const doc = buildDoc(payload.manifest.text);
  validateAudioManifest(payload.manifest, doc);
  return { manifest: payload.manifest, metadata: payload.metadata || {}, doc, text: payload.manifest.text };
}

// The same module is a dedicated inference worker; the UI never downloads
// this runtime or its model until the user selects Prepare browser voice.
if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
  let model, TextStream;
  self.onmessage = async ({ data }) => {
    try {
      if (data.action === 'load') {
        const { KokoroTTS, env, TextSplitterStream } = await import(BROWSER_RUNTIME);
        TextStream = TextSplitterStream;
        env.wasmPaths = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1/dist/';
        model = await KokoroTTS.from_pretrained(BROWSER_MODEL, { dtype: 'q8', device: 'wasm', progress_callback: (progress) => self.postMessage({ progress: { phase: 'model', ...progress } }) });
        self.postMessage({ id: data.id, result: true });
      } else if (data.action === 'generate') {
        if (!model) throw new Error('Load the natural voice before generating audio.');
        const result = [];
        // Explicitly close finite input. Kokoro 1.2.1's string overload leaves
        // its splitter open, so a final sentence otherwise waits indefinitely.
        const stream = new TextStream();
        stream.push(data.text);
        stream.close();
        for await (const part of model.stream(stream, { voice: data.voice, speed: 1 })) {
          if (part.phonemes.length > 510) throw new Error('The passage exceeds the voice model limit.');
          const samples = part.audio.audio;
          const rate = part.audio.sampling_rate || 24000;
          result.push({ text: part.text, phonemes: part.phonemes, wav: pcmToWav(samples, rate), duration: samples.length / rate });
        }
        self.postMessage({ id: data.id, result }, result.map((part) => part.wav));
      }
    } catch (error) { self.postMessage({ id: data.id, error: error.message || String(error) }); }
  };
}
