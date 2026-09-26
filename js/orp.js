// Optimal Recognition Point (ORP) calculation.

const WORD_CHAR = /[\p{L}\p{N}]/u;

const segmenter =
  typeof Intl !== 'undefined' && Intl.Segmenter
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

// Split a string into user-perceived characters so accented letters and
// emoji are never cut in half.
export function graphemes(str) {
  if (segmenter) return Array.from(segmenter.segment(str), (s) => s.segment);
  return Array.from(str);
}

const isWordChar = (g) => WORD_CHAR.test(g);

// ORP index for a word of `n` letters.
export function orpIndexForLength(n) {
  if (n <= 1) return 0;
  if (n <= 5) return 1;
  if (n <= 9) return 2;
  if (n <= 13) return 3;
  return 4;
}

// Leading/trailing punctuation boundaries of a word, in graphemes.
function coreBounds(chars) {
  let lead = 0;
  while (lead < chars.length && !isWordChar(chars[lead])) lead++;
  let trail = chars.length;
  while (trail > lead && !isWordChar(chars[trail - 1])) trail--;
  return [lead, trail];
}

// Number of characters in the word, ignoring leading and trailing punctuation.
export function coreLength(word) {
  const [lead, trail] = coreBounds(graphemes(word));
  return trail - lead;
}

// Split a word into the text before the ORP letter, the ORP letter itself,
// and the text after it (trailing punctuation included).
// The length used for the ORP table ignores trailing punctuation. Leading
// punctuation (an opening quote or bracket) is skipped so the ORP always
// lands on a letter.
export function splitWord(word) {
  const chars = graphemes(word);
  if (chars.length === 0) return { before: '', pivot: '', after: '' };
  const [lead, trail] = coreBounds(chars);
  const len = trail - lead;
  const idx = len === 0 ? 0 : lead + Math.min(orpIndexForLength(len), len - 1);
  return {
    before: chars.slice(0, idx).join(''),
    pivot: chars[idx],
    after: chars.slice(idx + 1).join(''),
  };
}
