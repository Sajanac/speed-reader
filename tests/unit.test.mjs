import test from 'node:test';
import assert from 'node:assert/strict';
import { orpIndexForLength, splitWord, coreLength } from '../js/orp.js';
import { tokenize, delayFactor, buildDoc, durationMs, speechChunk, offsetToIndex, TIMING } from '../js/text.js';
import { bookmarkletHref } from '../js/bookmarklet.js';

test('ORP index table', () => {
  const expect = { 0: 0, 1: 0, 2: 1, 5: 1, 6: 2, 9: 2, 10: 3, 13: 3, 14: 4, 30: 4 };
  for (const [n, idx] of Object.entries(expect)) assert.equal(orpIndexForLength(Number(n)), idx, `len ${n}`);
});

test('splitWord places pivot per table and keeps trailing punctuation', () => {
  assert.deepEqual(splitWord('a'), { before: '', pivot: 'a', after: '' });
  assert.deepEqual(splitWord('the'), { before: 't', pivot: 'h', after: 'e' });
  assert.deepEqual(splitWord('reading'), { before: 're', pivot: 'a', after: 'ding' });
  assert.deepEqual(splitWord('understand'), { before: 'und', pivot: 'e', after: 'rstand' });
  assert.deepEqual(splitWord('incomprehensibility'), { before: 'inco', pivot: 'm', after: 'prehensibility' });
  // Trailing punctuation doesn't change the index: "hello" (5) -> 1.
  assert.deepEqual(splitWord('hello!!!'), { before: 'h', pivot: 'e', after: 'llo!!!' });
  // "world." is 5 letters -> index 1, not 6 chars -> index 2.
  assert.deepEqual(splitWord('world.'), { before: 'w', pivot: 'o', after: 'rld.' });
  // Leading quote is skipped so the pivot lands on a letter.
  assert.deepEqual(splitWord('"Hello,'), { before: '"H', pivot: 'e', after: 'llo,' });
  assert.deepEqual(splitWord('café'), { before: 'c', pivot: 'a', after: 'fé' });
  assert.deepEqual(splitWord('...'), { before: '', pivot: '.', after: '..' });
});

test('coreLength ignores surrounding punctuation', () => {
  assert.equal(coreLength('(word),'), 4);
  assert.equal(coreLength("don't"), 5);
});

test('tokenize marks paragraph ends and splits em dashes', () => {
  const w = tokenize('One two.\n\nThree—four five\nsix');
  assert.deepEqual(w.map((x) => x.t), ['One', 'two.', 'Three—', 'four', 'five', 'six']);
  assert.deepEqual(w.map((x) => x.p), [false, true, false, false, false, true]);
});

test('delay factors', () => {
  const f = (t, p = false) => delayFactor({ t, p });
  assert.equal(f('word'), 1);
  assert.equal(f('end.'), TIMING.sentence);
  assert.equal(f('what?"'), TIMING.sentence);
  assert.equal(f('wow!'), TIMING.sentence);
  assert.equal(f('pause,'), TIMING.clause);
  assert.equal(f('list;'), TIMING.clause);
  assert.equal(f('note:'), TIMING.clause);
  assert.equal(f('extraordinary'), TIMING.longWord);
  assert.equal(f('tenletters'), 1); // exactly 10 is not "more than 10"
  assert.equal(f('extraordinary.'), TIMING.sentence * TIMING.longWord);
  assert.equal(f('last', true), TIMING.paragraph);
});

test('duration uses baseInterval = 60000 / WPM', () => {
  const doc = buildDoc('a b c. d');
  // factors 1,1,2,2.5(last word is paragraph end)
  assert.equal(durationMs(doc, 0, 3, 600), (1 + 1 + 2) * 100);
});

test('speech chunks and offset mapping', () => {
  const words = tokenize('Hi there you all. Next sentence here.');
  const c = speechChunk(words, 0);
  assert.equal(c.text, 'Hi there you all.');
  assert.deepEqual(c.offsets, [0, 3, 9, 13]);
  assert.equal(c.end, 4);
  assert.equal(offsetToIndex(c.offsets, 0), 0);
  assert.equal(offsetToIndex(c.offsets, 10), 2);
  assert.equal(offsetToIndex(c.offsets, 99), 3);
});

test('bookmarklet compiles', () => {
  const href = bookmarkletHref('https://example.github.io/speed-reader/');
  assert.ok(href.startsWith('javascript:'));
  const code = decodeURIComponent(href.slice('javascript:'.length));
  assert.doesNotThrow(() => new Function(code));
});
