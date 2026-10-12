import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDoc, normalize } from '../js/text.js';
import { buildParagraphs, offsetsToWordRange, wordAtOffset, sanitizeImmersivePrefs } from '../js/immersive.js';

test('paragraph mapping retains normalized source offsets, dash tokens, and gaps', () => {
  const text = normalize('  Intro—joined words.\r\n\r\nA\u00a0second paragraph.\n\nThe end.\n');
  const doc = buildDoc(text);
  const paragraphs = buildParagraphs(doc, text);
  assert.equal(paragraphs.length, 3);
  let restored = '';
  let end = 0;
  for (const paragraph of paragraphs) {
    restored += text.slice(end, paragraph.start) + text.slice(paragraph.start, paragraph.end);
    assert.equal(text.slice(paragraph.start, paragraph.end).includes('\n\n'), false);
    for (let i = paragraph.startWord; i < paragraph.endWord; i++) {
      const word = doc.words[i];
      assert.equal(text.slice(word.s, word.s + word.t.length), word.t);
    }
    end = paragraph.end;
  }
  restored += text.slice(end);
  assert.equal(restored, text);
  assert.equal(doc.words[1].s, doc.words[0].s + doc.words[0].t.length);
});

test('partial selections include touched words and preserve exclusive end indices', () => {
  const text = 'one—two  three\n\nfour five';
  const { words } = buildDoc(text);
  assert.deepEqual(offsetsToWordRange(words, 1, 6), { start: 0, end: 2 });
  assert.deepEqual(offsetsToWordRange(words, 7, 9), null); // only whitespace
  assert.deepEqual(offsetsToWordRange(words, 10, 11), { start: 2, end: 3 });
  assert.deepEqual(offsetsToWordRange(words, 9, 15), { start: 2, end: 3 });
  assert.deepEqual(offsetsToWordRange(words, 15, 9), { start: 2, end: 3 });
  assert.equal(offsetsToWordRange(words, 3, 3), null);
  assert.equal(offsetsToWordRange(words, text.length, text.length + 1), null);
});

test('click mapping handles exact dash boundaries, whitespace, and the document end', () => {
  const { words } = buildDoc('one—two  three');
  assert.equal(wordAtOffset(words, 0), 0);
  assert.equal(wordAtOffset(words, 4), 1);
  assert.equal(wordAtOffset(words, 8), 2);
  assert.equal(wordAtOffset(words, 100), 2);
  assert.equal(wordAtOffset([], 0), -1);
});

test('very long imported paragraphs are bounded without dropping words or source text', () => {
  const text = Array.from({ length: 40000 }, (_, i) => `w${i}`).join(' ');
  const doc = buildDoc(text);
  const paragraphs = buildParagraphs(doc, text);
  assert.equal(paragraphs[0].startWord, 0);
  assert.equal(paragraphs.at(-1).endWord, doc.words.length);
  assert.ok(paragraphs.length < 120);
  paragraphs.forEach((paragraph, i) => {
    assert.ok(paragraph.endWord - paragraph.startWord <= 360);
    if (i) assert.equal(paragraph.startWord, paragraphs[i - 1].endWord);
  });
});

test('appearance preferences accept the palette and constrain invalid imported settings', () => {
  assert.equal(sanitizeImmersivePrefs({ highlightColor: 'sand', highlightStyle: 'underline' }).highlightColor, 'sand');
  const prefs = sanitizeImmersivePrefs({ highlightColor: 'url(evil)', highlightStyle: 'invalid', highlightOpacity: 5, fontSize: -30, lineHeight: 'bad' });
  assert.equal(prefs.highlightColor, 'lavender');
  assert.equal(prefs.highlightStyle, 'half');
  assert.equal(prefs.highlightOpacity, 1);
  assert.equal(prefs.fontSize, 16);
  assert.equal(prefs.lineHeight, 1.85);
});
