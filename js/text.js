// Text normalisation, tokenising, timing factors, and HTML-to-text extraction.

import { coreLength } from './orp.js';

// Dwell-time multipliers applied to the base interval (60000 / WPM).
export const TIMING = {
  sentence: 2, // word ends with . ! ? (or …)
  clause: 1.5, // word ends with , ; :
  paragraph: 2.5, // last word of a paragraph
  longWord: 1.3, // applied on top of the above for long words
  longWordThreshold: 10, // "long" means more than this many letters
};

const CLOSERS = `["'”’)\\]»›]*`;
const SENTENCE_END = new RegExp(`[.!?…]${CLOSERS}$`);
const CLAUSE_END = new RegExp(`[,;:]${CLOSERS}$`);

export const endsSentence = (w) => SENTENCE_END.test(w);
export const endsClause = (w) => CLAUSE_END.test(w);

export function normalize(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[   　]/g, ' ')
    .replace(/[­​‌‍⁠﻿]/g, '')
    .replace(/[ \t\f\v]+\n/g, '\n');
}

const isDash = (c) => c === '—' || c === '–';

// Break "word—word" into "word—" and "word" so long dash-joined runs don't
// show as a single token.
function splitDashes(tok, start, out) {
  let from = 0;
  for (let i = 0; i < tok.length - 1; i++) {
    if (isDash(tok[i]) && !isDash(tok[i + 1]) && i > from) {
      out.push({ t: tok.slice(from, i + 1), s: start + from, p: false });
      from = i + 1;
    }
  }
  out.push({ t: tok.slice(from), s: start + from, p: false });
}

// Returns [{ t: text, s: start offset, p: true if last word of a paragraph }].
export function tokenize(text) {
  const norm = normalize(text);
  const words = [];
  const re = /\S+/g;
  const ws = /\s*/y;
  let m;
  while ((m = re.exec(norm))) {
    splitDashes(m[0], m.index, words);
    ws.lastIndex = re.lastIndex;
    const gap = ws.exec(norm)[0];
    words[words.length - 1].p = /\n\s*\n/.test(gap) || re.lastIndex + gap.length >= norm.length;
  }
  return words;
}

export function delayFactor(word) {
  let f = 1;
  if (endsSentence(word.t)) f = TIMING.sentence;
  else if (endsClause(word.t)) f = TIMING.clause;
  if (word.p) f = Math.max(f, TIMING.paragraph);
  if (coreLength(word.t) > TIMING.longWordThreshold) f *= TIMING.longWord;
  return f;
}

// Build the reading model: words plus prefix sums of the timing factors so
// remaining time can be computed in O(1).
export function buildDoc(text) {
  const words = tokenize(text);
  const factors = new Float32Array(words.length);
  const prefix = new Float64Array(words.length + 1);
  for (let i = 0; i < words.length; i++) {
    factors[i] = delayFactor(words[i]);
    prefix[i + 1] = prefix[i] + factors[i];
  }
  return { words, factors, prefix };
}

// Milliseconds to read words [from, to) at the given WPM.
export function durationMs(doc, from, to, wpm) {
  return (doc.prefix[to] - doc.prefix[from]) * (60000 / wpm);
}

// Index of the first word of the sentence containing word i.
export function sentenceStart(words, i) {
  let k = i;
  while (k > 0 && !endsSentence(words[k - 1].t) && !words[k - 1].p) k--;
  return k;
}

// Index one past the last word of the sentence containing word i.
export function sentenceEnd(words, i) {
  let k = i;
  while (k < words.length - 1 && !endsSentence(words[k].t) && !words[k].p) k++;
  return k + 1;
}

// Group words from `start` into a chunk for one speech utterance: up to the
// end of a sentence or paragraph (at least `min` words, at most `max`).
// Returns the chunk text and each word's character offset within it.
export function speechChunk(words, start, min = 4, max = 45) {
  const offsets = [];
  let text = '';
  let i = start;
  for (; i < words.length && i - start < max; i++) {
    if (text) text += ' ';
    offsets.push(text.length);
    text += words[i].t;
    const n = i - start + 1;
    if (words[i].p || (n >= min && endsSentence(words[i].t))) {
      i++;
      break;
    }
  }
  return { text, offsets, end: i };
}

// Index of the last offset that is <= pos.
export function offsetToIndex(offsets, pos) {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'caption', 'dd', 'details', 'div', 'dl', 'dt',
  'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li',
  'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'td', 'th', 'tr', 'ul',
]);
const SKIP = new Set([
  'script', 'style', 'noscript', 'template', 'svg', 'math', 'iframe', 'object', 'embed',
  'canvas', 'video', 'audio', 'button', 'input', 'select', 'textarea', 'head', 'title',
]);

// Extract readable text from a DOM subtree, keeping paragraph breaks as
// blank lines. Works for HTML and XHTML (ePub) documents.
export function htmlToText(root) {
  const parts = [];
  const walk = (node) => {
    for (let n = node.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) {
        parts.push(n.nodeValue.replace(/\s+/g, ' '));
      } else if (n.nodeType === 1) {
        const tag = (n.localName || '').toLowerCase();
        if (SKIP.has(tag) || n.hasAttribute('hidden') || n.getAttribute('aria-hidden') === 'true') continue;
        const block = BLOCK.has(tag);
        if (block) parts.push('\n\n');
        walk(n);
        if (block) parts.push('\n\n');
      }
    }
  };
  if (root) walk(root);
  return parts
    .join('')
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
}
