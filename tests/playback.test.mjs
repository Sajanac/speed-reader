import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadingPlayback } from '../js/playback.js';
import { buildDoc } from '../js/text.js';

class MockAudio extends EventTarget {
  constructor() { super(); this.readyState = 4; this.duration = 1; this.currentTime = 0; this.paused = true; this.ended = false; }
  setAttribute() {}
  removeAttribute() {}
  load() { this.currentTime = 0; this.paused = true; }
  pause() { this.paused = true; }
  async play() { this.paused = false; }
}

const text = 'One two three four five.';
const doc = buildDoc(text);
const manifest = (from = 0, to = 5) => ({ version: 1, text, engine: 'browser', voice: 'af_heart',
  chunks: [{ from, to, audio: new Blob([new Uint8Array(44)], { type: 'audio/wav' }), duration: to - from,
    timing: 'word', timings: Array.from({ length: to - from }, (_, index) => ({ index: from + index, start: index, end: index + 1 })) }] });

function playback(t) {
  const previous = globalThis.Audio;
  globalThis.Audio = MockAudio;
  const observed = [], errors = [];
  const player = new ReadingPlayback({ onWord: (index) => observed.push(index), onState() {}, onError: (error) => errors.push(error) });
  player.load(doc, text);
  player.setEngine('browser');
  player.setSpeech(true);
  t.after(() => { player.pause(); player.audio.dispose(); if (previous) globalThis.Audio = previous; else delete globalThis.Audio; });
  return { player, observed, errors };
}

test('attaching partial narration enters its passage without discarding prepared audio', (t) => {
  const { player } = playback(t);
  const partial = manifest(1, 3);
  player.attachAudio(partial);
  assert.equal(player.manifest, partial);
  assert.equal(player.usesAudio, true);
  assert.equal(player.index, 1);
  player.seek(2);
  assert.equal(player.index, 2);
  assert.equal(player.manifest, partial);
});

test('navigation outside a completed selection releases partial narration and reaches the requested word', (t) => {
  const { player, errors } = playback(t);
  player.attachAudio(manifest(1, 3));
  player.setRange(1, 3);
  player.cancelRange();
  player.seek(4);
  assert.equal(player.index, 4);
  assert.equal(player.range, null);
  assert.equal(player.manifest, null);
  assert.equal(player.usesAudio, false);
  player.play();
  assert.match(errors.at(-1), /Prepare narration first/);
});

test('failed audio attachment releases loading state and subsequent seeking and preparation recover', (t) => {
  const { player, observed } = playback(t);
  player.attachAudio(manifest());
  player.seek(2);
  assert.throws(() => player.attachAudio({ ...manifest(), text: 'Different text.' }), /different text/);
  assert.equal(player.loading, false);
  assert.equal(player.manifest, null);
  player.seek(4);
  assert.equal(player.index, 4);
  assert.equal(observed.at(-1), 4);
  const replacement = manifest();
  player.attachAudio(replacement);
  assert.equal(player.manifest, replacement);
  player.seek(1);
  assert.equal(player.index, 1);
  assert.equal(observed.at(-1), 1);
});

test('switching documents clears narration and selection limits while retaining the requested resume point', (t) => {
  const { player, observed } = playback(t);
  player.attachAudio(manifest());
  player.setRange(1, 3);
  const nextText = 'A different article.';
  player.load(buildDoc(nextText), nextText, 2);
  assert.equal(player.manifest, null);
  assert.equal(player.audio.manifest, null);
  assert.equal(player.range, null);
  assert.equal(player.index, 2);
  assert.equal(observed.at(-1), 2);
});
