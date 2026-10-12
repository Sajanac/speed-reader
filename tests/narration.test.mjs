import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { buildDoc } from '../js/text.js';
import { NativeAudioNarrator, validateAudioManifest } from '../js/narration.js';
import {
  base64Audio, exportNarrationAudio, importAudioPackage, mapCaptionTimings,
  narrationSegments, pcmToWav, prepareNaturalVoice, probeAudioDuration, serializeAudioPackage, validateLocalEndpoint,
} from '../js/natural-voice.js';

const text = 'One two. Three four.';
const doc = buildDoc(text);
const wav = () => new Blob([pcmToWav(new Float32Array(120).fill(0.25))], { type: 'audio/wav' });
const marks = (from, to) => Array.from({ length: to - from }, (_, i) => ({ index: from + i, start: i * 0.5, end: (i + 1) * 0.5 }));
const chunk = (from, to, timing = 'word') => ({ from, to, audio: wav(), duration: (to - from) * 0.5, timing,
  timings: timing === 'word' ? marks(from, to) : [{ index: from, start: 0, end: (to - from) * 0.5 }] });
const manifest = (chunks = [chunk(0, 2), chunk(2, 4)]) => ({ version: 1, text, engine: 'local', voice: 'af_heart', chunks });

class MockAudio extends EventTarget {
  constructor() { super(); this.readyState = 4; this.duration = 1; this._time = 0; this.ended = false; this.paused = true; this.src = ''; this.playCalls = 0; }
  setAttribute() {}
  removeAttribute(name) { if (name === 'src') this.src = ''; }
  get currentTime() { return this._time; }
  set currentTime(value) { this._time = value; this.ended = false; }
  load() { this._time = 0; this.ended = false; this.paused = true; }
  async play() { this.playCalls++; this.paused = false; this.ended = false; this.emit('play'); }
  pause() { const changed = !this.paused; this.paused = true; if (changed) this.emit('pause'); }
  emit(name) { this.dispatchEvent(new Event(name)); }
  clock(value) { this.currentTime = value; this.emit('timeupdate'); }
  finish() { this._time = this.duration; this.ended = true; this.paused = true; this.emit('ended'); }
}

test('recorded narration follows the media clock after jumps and rate changes', async () => {
  const audio = new MockAudio(), heard = [], states = [];
  const narrator = new NativeAudioNarrator({ audio, onWord: (index, span) => heard.push({ index, span }), onState: (state) => states.push(state) });
  narrator.load(doc, text, manifest());
  await narrator.play();
  audio.clock(0.72);
  assert.equal(narrator.index, 1);
  narrator.setRate(1.75);
  assert.equal(audio.playbackRate, 1.75);
  assert.equal(audio.preservesPitch, true);
  assert.equal(audio.currentTime, 0.72);
  audio.finish();
  await Promise.resolve();
  assert.equal(narrator.currentSpan.from, 2);
  audio.clock(0.72);
  assert.equal(narrator.index, 3);
  assert.equal(narrator.currentTime, 1.72);
  assert.deepEqual(heard.at(-1).span, { from: 3, to: 4, timing: 'word' });
  audio.finish();
  assert.equal(narrator.playing, false);
  assert.equal(states.at(-1), false);
  await narrator.play();
  assert.equal(narrator.index, 0);
  assert.equal(audio.currentTime, 0);
  narrator.dispose();
});

test('word seeking and second skipping cross chunks without changing playback intent', async () => {
  const audio = new MockAudio();
  const narrator = new NativeAudioNarrator({ audio });
  narrator.load(doc, text, manifest());
  narrator.seek(3);
  assert.equal(audio.currentTime, 0.5);
  assert.equal(narrator.index, 3);
  assert.equal(narrator.playing, false);
  await narrator.play();
  narrator.skipSeconds(-1.1);
  assert.equal(narrator.currentSpan.from, 0);
  assert.ok(Math.abs(audio.currentTime - 0.4) < 0.00001);
  assert.equal(narrator.playing, true);
  narrator.pause();
  narrator.skip(2);
  assert.equal(narrator.index, 2);
  assert.equal(narrator.playing, false);
  narrator.dispose();
});

test('selected word ranges stop at their last timestamp and replay the selection', async () => {
  const audio = new MockAudio(); audio.duration = 2;
  const narrator = new NativeAudioNarrator({ audio });
  narrator.load(doc, text, manifest([chunk(0, 4)]));
  narrator.setRange(1, 3);
  assert.equal(audio.currentTime, 0.5);
  await narrator.play();
  audio.clock(1.49);
  assert.equal(narrator.index, 2);
  audio.clock(1.5);
  assert.equal(narrator.playing, false);
  await narrator.play();
  assert.equal(narrator.index, 1);
  assert.equal(audio.currentTime, 0.5);
  narrator.skipSeconds(30);
  assert.equal(narrator.index, 2);
  assert.ok(audio.currentTime >= 1 && audio.currentTime < 1.5, 'seconds seeking stops inside the selected range');
  narrator.skipSeconds(-30);
  assert.equal(audio.currentTime, 0.5);
  narrator.cancelRange();
  narrator.seek(0);
  assert.equal(narrator.index, 0);
  narrator.dispose();
});

test('sentence highlights report a span and reject a partial sentence range', async () => {
  const audio = new MockAudio(), spans = [];
  const part = chunk(0, 2, 'sentence');
  delete part.duration;
  part.timings[0].end = 1; // Missing API captions use this placeholder; metadata is authoritative.
  audio.duration = 4;
  const narrator = new NativeAudioNarrator({ audio, onWord: (_index, span) => spans.push(span) });
  narrator.load(doc, text, manifest([part, chunk(2, 4, 'sentence')]));
  assert.throws(() => narrator.setRange(1, 2), /Prepare this selected passage/);
  narrator.setRange(0, 2);
  await narrator.play();
  audio.clock(2);
  assert.equal(narrator.playing, true, 'placeholder timestamp must not cut off a sentence');
  assert.deepEqual(spans.at(-1), { from: 0, to: 2, timing: 'sentence' });
  audio.finish();
  assert.equal(narrator.playing, false);
  await narrator.play();
  assert.equal(audio.currentTime, 0);
  narrator.dispose();
});

test('reset retains listeners for the next document and stale play errors are ignored', async () => {
  const audio = new MockAudio(), errors = [];
  let rejectPlay;
  audio.play = () => new Promise((_resolve, reject) => { rejectPlay = reject; });
  const narrator = new NativeAudioNarrator({ audio, onError: (message) => errors.push(message) });
  narrator.load(doc, text, manifest());
  const pending = narrator.play();
  narrator.reset();
  assert.equal(narrator.manifest, null);
  assert.equal(audio.src, '');
  narrator.load(doc, text, manifest());
  rejectPlay(new Error('old failure'));
  await pending;
  assert.deepEqual(errors, []);
  audio.clock(0.6);
  assert.equal(narrator.index, 1);
  narrator.dispose();
  audio.emit('error');
  assert.deepEqual(errors, []);
});

test('metadata applies deferred seeking and native controls report pause state', async () => {
  const audio = new MockAudio(), states = [];
  audio.readyState = 0;
  const narrator = new NativeAudioNarrator({ audio, onState: (state) => states.push(state) });
  const prepared = manifest();
  prepared.chunks[0].durationEstimated = true;
  narrator.load(doc, text, prepared);
  assert.equal(narrator.duration, 2);
  narrator.seek(1);
  assert.equal(audio.currentTime, 0);
  audio.readyState = 4;
  audio.duration = 1.2;
  audio.emit('loadedmetadata');
  assert.equal(audio.currentTime, 0.5);
  assert.equal(narrator.manifest.chunks[0].duration, 1.2);
  assert.equal(narrator.manifest.chunks[0].durationEstimated, false);
  assert.equal(narrator.duration, 2.2, 'decoded metadata invalidates the cached duration offsets');
  await narrator.play();
  audio.pause();
  assert.equal(narrator.playing, false);
  assert.equal(states.at(-1), false);
  narrator.dispose();
});

test('manifest validation rejects gaps, missing word coverage, and invalid timing', () => {
  const valid = manifest();
  assert.equal(validateAudioManifest(valid), valid);
  const gap = manifest(); gap.chunks[1].from = 3;
  assert.throws(() => validateAudioManifest(gap), /do not match/);
  const partial = manifest(); partial.chunks[0].timings.pop();
  assert.throws(() => validateAudioManifest(partial), /complete passage/);
  const backward = manifest(); backward.chunks[0].timings[1].start = -1;
  assert.throws(() => validateAudioManifest(backward), /invalid or unordered/);
  const untrusted = manifest(); untrusted.chunks[0].audio = 'javascript:alert(1)';
  assert.throws(() => validateAudioManifest(untrusted), /unsupported audio/);
});

test('caption mapping handles contractions and repeated words and refuses changed spoken text', () => {
  const words = buildDoc("Can't go go.").words;
  const mapped = mapCaptionTimings(words, 0, 3, [
    { word: 'can', start_time: 0.1, end_time: 0.2 },
    { word: 't', start_time: 0.2, end_time: 0.3 },
    { word: 'go', start_time: 0.3, end_time: 0.5 },
    { word: 'go', start_time: 0.5, end_time: 0.8 },
  ]);
  assert.deepEqual(mapped, [{ index: 0, start: 0.1, end: 0.3 }, { index: 1, start: 0.3, end: 0.5 }, { index: 2, start: 0.5, end: 0.8 }]);
  assert.equal(mapCaptionTimings(buildDoc('2 cats').words, 0, 2, [{ word: 'two', start: 0, end: 1 }, { word: 'cats', start: 1, end: 2 }]), null);
  assert.equal(mapCaptionTimings(words, 0, 3, [{ word: "can't", start: 1, end: 0 }]), null);
  assert.equal(mapCaptionTimings(words, 0, 3, [{ word: "can't go go", start: 0, end: 1 }]), null);
  assert.equal(mapCaptionTimings(words, 0, 3, [{ word: "can't", start: 0, end: 1 }]), null);
});

test('segments preserve selected token indices and exact text including dash compounds', () => {
  const value = 'Start. A—B stays. Last sentence.';
  const readingDoc = buildDoc(value);
  const parts = narrationSegments(readingDoc, value, { from: 1, to: 4 });
  assert.deepEqual(parts.map(({ from, to, text }) => ({ from, to, text })), [{ from: 1, to: 4, text: 'A—B stays.' }]);
  assert.throws(() => narrationSegments(buildDoc('x'.repeat(231)), 'x'.repeat(231), { maxChars: 230 }), /too long/);
  assert.throws(() => narrationSegments(doc, text, { from: 2, to: 2 }), /nonempty/);
});

test('local endpoint validation permits loopback or authenticated HTTPS', () => {
  assert.equal(validateLocalEndpoint('/local-voice', '', 'http://127.0.0.1:8000'), 'http://127.0.0.1:8000/local-voice');
  assert.equal(validateLocalEndpoint('http://localhost:8880/'), 'http://localhost:8880');
  assert.equal(validateLocalEndpoint('http://[::1]:8880'), 'http://[::1]:8880');
  assert.equal(validateLocalEndpoint('https://voice.example/api', 'personal-secret', 'https://reader.example'), 'https://voice.example/api');
  assert.throws(() => validateLocalEndpoint('http://192.168.1.3:8880'), /authenticated HTTPS/);
  assert.throws(() => validateLocalEndpoint('https://voice.example', '', 'https://reader.example'), /access token/);
  assert.throws(() => validateLocalEndpoint('https://user:secret@voice.example', 'x'), /without credentials/);
  assert.throws(() => validateLocalEndpoint('http://localhost:8880/?url=anything'), /query/);
});

test('local preparation maps captions to selected indices and explicitly falls back for missing timings', async () => {
  const encoded = Buffer.from(await wav().arrayBuffer()).toString('base64');
  const requests = [];
  const prepared = await prepareNaturalVoice({ doc, text, engine: 'local', from: 2, to: 4, endpoint: 'http://127.0.0.1:8880',
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ audio: encoded, audio_format: 'audio/wav', timestamps: [
        { word: 'Three', start_time: 0, end_time: 0.5 }, { word: 'four.', start_time: 0.5, end_time: 1 },
      ] }) };
    } });
  assert.equal(prepared.text, text);
  assert.deepEqual(prepared.chunks[0].timings, marks(2, 4));
  assert.equal(prepared.chunks[0].from, 2);
  assert.equal(prepared.chunks[0].duration, 1);
  assert.equal(prepared.chunks[0].durationEstimated, true);
  assert.equal(requests[0].url, 'http://127.0.0.1:8880/dev/captioned_speech');
  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.input, 'Three four.');
  assert.equal(body.normalization_options.normalize, false);
  assert.equal(body.stream, false);
  assert.equal(body.return_timestamps, true);
  const fallback = await prepareNaturalVoice({ doc, text, engine: 'local', from: 0, to: 2, endpoint: 'http://localhost:8880',
    fetch: async () => ({ ok: true, json: async () => ({ audio: encoded, audio_format: 'audio/wav' }) }),
    audioFactory: () => {
      const audio = new MockAudio(); audio.duration = 2.7;
      audio.load = () => queueMicrotask(() => audio.emit('loadedmetadata'));
      return audio;
    } });
  assert.equal(fallback.chunks[0].timing, 'sentence');
  assert.match(fallback.chunks[0].timingNote, /did not return word timings/);
  assert.equal(fallback.chunks[0].duration, 2.7);
  assert.equal(fallback.chunks[0].durationEstimated, false);
});

test('audio duration probing decodes metadata and rejects undecodable clips and cancellation', async () => {
  const good = await probeAudioDuration(wav(), { audioFactory: () => {
    const audio = new MockAudio(); audio.duration = 3.5;
    audio.load = () => queueMicrotask(() => audio.emit('loadedmetadata'));
    return audio;
  } });
  assert.equal(good, 3.5);
  await assert.rejects(probeAudioDuration(wav(), { audioFactory: () => {
    const audio = new MockAudio();
    audio.load = () => queueMicrotask(() => audio.emit('error'));
    return audio;
  } }), /cannot decode/);
  const controller = new AbortController();
  const pending = probeAudioDuration(wav(), { signal: controller.signal, audioFactory: () => new MockAudio() });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('canceling local preparation aborts the actual fetch and invalid audio is rejected', async () => {
  const controller = new AbortController();
  const task = prepareNaturalVoice({ doc, text, engine: 'local', signal: controller.signal, endpoint: 'http://localhost:8880',
    fetch: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Canceled', 'AbortError')), { once: true });
      controller.abort();
    }) });
  await assert.rejects(task, { name: 'AbortError' });
  assert.throws(() => base64Audio('not base64!'), /invalid audio/);
  assert.throws(() => base64Audio('YQ=='), /empty audio/);
});

test('browser preparation waits for a worker and keeps sentence timing honest', async () => {
  const previous = globalThis.Worker;
  const instances = [];
  class VoiceWorker {
    constructor() { instances.push(this); }
    postMessage(data) {
      queueMicrotask(() => this.onmessage({ data: { id: data.id, result: data.action === 'load' ? true : [{ text: data.text, phonemes: 'test', wav: pcmToWav(new Float32Array(240)), duration: 0.01 }] } }));
    }
    terminate() { this.terminated = true; }
  }
  globalThis.Worker = VoiceWorker;
  try {
    const prepared = await prepareNaturalVoice({ doc, text, engine: 'browser', from: 2, to: 4 });
    assert.equal(prepared.chunks[0].from, 2);
    assert.equal(prepared.chunks[0].to, 4);
    assert.equal(prepared.chunks[0].timing, 'sentence');
    assert.equal(prepared.chunks[0].audio.type, 'audio/wav');
    assert.equal(instances[0].terminated, true);
    VoiceWorker.prototype.postMessage = function (data) {
      queueMicrotask(() => this.onmessage({ data: { id: data.id, result: data.action === 'load' ? true : [{ text: 'four.', phonemes: 'test', wav: pcmToWav(new Float32Array(240)), duration: 0.01 }] } }));
    };
    await assert.rejects(prepareNaturalVoice({ doc, text, engine: 'browser', from: 2, to: 4 }), /safely read/);
  } finally { if (previous === undefined) delete globalThis.Worker; else globalThis.Worker = previous; }
});

test('transfer packages round trip text, audio and timings and reject remote audio', async () => {
  const original = manifest();
  const file = await serializeAudioPackage(original, { title: 'Personal article' });
  const restored = await importAudioPackage(file);
  assert.equal(restored.text, text);
  assert.equal(restored.doc.words.length, doc.words.length);
  assert.equal(restored.metadata.title, 'Personal article');
  assert.deepEqual(new Uint8Array(await restored.manifest.chunks[0].audio.arrayBuffer()), new Uint8Array(await original.chunks[0].audio.arrayBuffer()));
  assert.deepEqual(restored.manifest.chunks[1].timings, original.chunks[1].timings);
  const payload = JSON.parse(await file.text());
  payload.manifest.chunks[0].audio = 'https://evil.example/audio.mp3';
  await assert.rejects(importAudioPackage(payload), /include its audio/);
  const invalid = JSON.parse(await file.text());
  invalid.manifest.chunks[0].timings[0].index = 99;
  await assert.rejects(importAudioPackage(invalid), /invalid or unordered/);
});

test('WAV export merges sample data with one valid header', async () => {
  const original = manifest();
  const merged = await exportNarrationAudio(original);
  const bytes = new Uint8Array(await merged.arrayBuffer()), header = new DataView(bytes.buffer);
  assert.equal(merged.type, 'audio/wav');
  assert.equal(bytes.length, 44 + 240 * 2);
  assert.equal(header.getUint32(4, true), bytes.length - 8);
  assert.equal(header.getUint32(40, true), bytes.length - 44);
  assert.equal(header.getUint32(24, true), 24000);
  assert.deepEqual(bytes.slice(44, 44 + 240), new Uint8Array(await original.chunks[0].audio.arrayBuffer()).slice(44));
  original.chunks[1].audio = new Blob([pcmToWav(new Float32Array(120), 22050)], { type: 'audio/wav' });
  await assert.rejects(exportNarrationAudio(original), /incompatible formats/);
});

test('MP3 export strips repeated ID3 tags and refuses mixed formats', async () => {
  const id3 = new Uint8Array([73, 68, 51, 4, 0, 0, 0, 0, 0, 0]);
  const frame = new Uint8Array(100).fill(255);
  const original = manifest();
  for (const part of original.chunks) part.audio = new Blob([id3, frame], { type: 'audio/mpeg' });
  const merged = await exportNarrationAudio(original);
  assert.equal(merged.type, 'audio/mpeg');
  assert.equal(merged.size, 200);
  original.chunks[1].audio = wav();
  await assert.rejects(exportNarrationAudio(original), /mixes audio formats/);
});

test('loopback helper serves only reader assets and forwards only its fixed speech route', async () => {
  const script = `
import importlib.util, json
from email.message import Message
from io import BytesIO
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location('reader_helper', 'tools/local-voice/serve.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
def handler(path, origin=None, host='127.0.0.1:8000'):
    out = object.__new__(module.ReaderHandler)
    out.path = path
    out.server = SimpleNamespace(server_port=8000,voice_port=8880)
    out.headers = Message()
    out.headers['Host'] = host
    out.headers['Content-Type'] = 'application/json'
    if origin: out.headers['Origin'] = origin
    body = json.dumps({'input':'Hello.','voice':'af_heart','url':'http://evil.example','response_format':'wav','speed':99}).encode()
    out.headers['Content-Length'] = str(len(body))
    out.rfile = BytesIO(body)
    out.results = []
    out._json = lambda status, payload: out.results.append((status,payload))
    out.send_error = lambda status: out.results.append((status,{}))
    return out
for path in ['/', '/js/narration.js']:
    assert handler(path)._safe_static()
for path in ['/.git/config','/package.json','/js/','/js/%2e%2e/.git/config']:
    item = handler(path)
    assert not item._safe_static()
    assert item.results[0][0] == 404
item = handler('/',host='attacker.example:8000')
assert not item._safe_static()
assert item.results[0][0] == 403
item = handler('/local-voice/dev/captioned_speech',origin='https://attacker.example')
item.do_POST()
assert item.results[0][0] == 403
item = handler('/local-voice/debug')
item.do_POST()
assert item.results[0][0] == 404
class Response:
    def __enter__(self): return self
    def __exit__(self,*args): pass
    def read(self,maximum):
        return json.dumps({'audio':'A'*64,'audio_format':'audio/mpeg','timestamps':[],'private_debug':'never exposed'}).encode()
class Opener:
    def open(self,req,timeout):
        assert req.full_url == 'http://127.0.0.1:8880/dev/captioned_speech'
        assert json.loads(req.data) == {'model':'kokoro','input':'Hello.','voice':'af_heart','speed':1.0,'response_format':'mp3','stream':False,'return_timestamps':True,'normalization_options':{'normalize':False}}
        return Response()
module.request.build_opener = lambda *args: Opener()
item = handler('/local-voice/dev/captioned_speech',origin='http://127.0.0.1:8000')
item.do_POST()
assert item.results[0][0] == 200
assert sorted(item.results[0][1].keys()) == ['audio','audio_format','timestamps']
print('ok')
`;
  const child = spawn('python3', ['-u', '-c', script], { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stderr.on('data', (value) => { errors += value; });
  child.stdout.on('data', (value) => { output += value; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, errors);
  assert.equal(output.trim(), 'ok');
});
