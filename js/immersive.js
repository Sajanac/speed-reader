// A selectable read-along view. Only the active paragraph contains marks;
// entire books do not need an element for every word.
import { normalize, endsSentence } from './text.js?v=20261016';

export const HIGHLIGHT_COLORS = Object.freeze({
  lavender: { label: 'Lavender', rgb: '197, 180, 244' },
  mint: { label: 'Mint', rgb: '166, 219, 194' },
  peach: { label: 'Peach', rgb: '246, 193, 158' },
  blush: { label: 'Blush', rgb: '237, 179, 193' },
  sky: { label: 'Soft blue', rgb: '163, 206, 237' },
  butter: { label: 'Butter', rgb: '239, 221, 150' },
  cream: { label: 'Cream', rgb: '228, 219, 199' },
  sand: { label: 'Sand', rgb: '213, 196, 167' },
  taupe: { label: 'Taupe', rgb: '186, 169, 156' },
  slate: { label: 'Muted slate', rgb: '164, 183, 193' },
  gray: { label: 'Warm gray', rgb: '187, 183, 177' },
});

export const DEFAULT_IMMERSIVE_PREFS = Object.freeze({
  highlightColor: 'lavender',
  highlightStyle: 'half',
  highlightOpacity: 0.7,
  fontSize: 21,
  lineHeight: 1.85,
  sentenceHighlight: true,
  follow: true,
});

const STYLES = new Set(['full', 'half', 'underline', 'pill']);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const numeric = (value, fallback, min, max) => Number.isFinite(Number(value))
  ? clamp(Number(value), min, max) : fallback;

export function sanitizeImmersivePrefs(prefs = {}) {
  return {
    highlightColor: Object.hasOwn(HIGHLIGHT_COLORS, prefs.highlightColor) ? prefs.highlightColor : DEFAULT_IMMERSIVE_PREFS.highlightColor,
    highlightStyle: STYLES.has(prefs.highlightStyle) ? prefs.highlightStyle : DEFAULT_IMMERSIVE_PREFS.highlightStyle,
    highlightOpacity: numeric(prefs.highlightOpacity, DEFAULT_IMMERSIVE_PREFS.highlightOpacity, 0.15, 1),
    fontSize: numeric(prefs.fontSize, DEFAULT_IMMERSIVE_PREFS.fontSize, 16, 34),
    lineHeight: numeric(prefs.lineHeight, DEFAULT_IMMERSIVE_PREFS.lineHeight, 1.35, 2.5),
    sentenceHighlight: prefs.sentenceHighlight === undefined ? DEFAULT_IMMERSIVE_PREFS.sentenceHighlight : Boolean(prefs.sentenceHighlight),
    follow: prefs.follow === undefined ? DEFAULT_IMMERSIVE_PREFS.follow : Boolean(prefs.follow),
  };
}

// Preserve the original normalized offsets, including adjacent dash tokens.
// Very long paragraphs are split at sentence boundaries where possible, which
// keeps replacing the active text inexpensive even with a malformed import.
export function buildParagraphs(doc, text, maxWords = 360) {
  const words = doc?.words || [];
  const paragraphs = [];
  let from = 0;
  const limit = Math.max(1, Math.floor(maxWords));
  for (let i = 0; i < words.length; i++) {
    const count = i - from + 1;
    const naturalEnd = words[i].p || i === words.length - 1;
    const chunkEnd = count >= limit || (count >= limit * 0.7 && endsSentence(words[i].t));
    if (!naturalEnd && !chunkEnd) continue;
    const start = words[from].s;
    const end = Math.min(text.length, words[i].s + words[i].t.length);
    paragraphs.push({ start, end, startWord: from, endWord: i + 1, continuation: !naturalEnd });
    from = i + 1;
  }
  return paragraphs;
}

// An exclusive word range includes every token touched by the text selection.
// Selecting only the whitespace between words yields no passage.
export function offsetsToWordRange(words, start, end) {
  if (!words?.length || !Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end) [start, end] = [end, start];
  if (start === end) return null;
  let lo = 0, hi = words.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (words[mid].s + words[mid].t.length <= start) lo = mid + 1;
    else hi = mid;
  }
  const first = lo;
  lo = first;
  hi = words.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (words[mid].s < end) lo = mid + 1;
    else hi = mid;
  }
  return first < lo ? { start: first, end: lo } : null;
}

export function wordAtOffset(words, offset) {
  if (!words?.length || !Number.isFinite(offset)) return -1;
  let lo = 0, hi = words.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (words[mid].s <= offset) lo = mid;
    else hi = mid - 1;
  }
  // At a gap, favour the next word; a caret after the final word stays there.
  if (offset >= words[lo].s + words[lo].t.length && lo < words.length - 1) return lo + 1;
  return lo;
}

export class ImmersiveReader {
  constructor({ container, onSeek = () => {}, onSelection = () => {}, onManualScroll = () => {} }) {
    if (!container) throw new TypeError('ImmersiveReader requires a container.');
    this.container = container;
    this.document = container.ownerDocument;
    this.onSeek = onSeek;
    this.onSelection = onSelection;
    this.onManualScroll = onManualScroll;
    this.prefs = { ...DEFAULT_IMMERSIVE_PREFS };
    this.doc = null;
    this.index = -1;
    this._activeParagraph = -1;
    this._activeParagraphs = new Set();
    this._span = null;
    this._selecting = false;
    this._followSuspended = false;
    this._selectionKey = '';
    this._textStarts = new WeakMap();
    this._paragraphElements = [];
    this.container.classList.add('immersive-reader');
    this.container.setAttribute('aria-label', 'Immersive reading text');
    this.container.tabIndex = 0;
    this.content = this.document.createElement('article');
    this.content.className = 'immersive-content';
    this.container.replaceChildren(this.content);

    this._handlers = {
      click: (event) => this._click(event),
      pointerdown: () => { this._selecting = true; },
      pointerup: () => {
        if (!this._selecting) return;
        this._selecting = false;
        this._drawActive();
        this._notifySelection();
      },
      manual: () => this._suspendFollow(),
      keydown: (event) => {
        if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) this._suspendFollow();
      },
      selectionchange: () => this._notifySelection(),
    };
    container.addEventListener('click', this._handlers.click);
    container.addEventListener('pointerdown', this._handlers.pointerdown);
    container.addEventListener('wheel', this._handlers.manual, { passive: true });
    container.addEventListener('touchmove', this._handlers.manual, { passive: true });
    container.addEventListener('keydown', this._handlers.keydown);
    this.document.addEventListener('pointerup', this._handlers.pointerup);
    this.document.addEventListener('pointercancel', this._handlers.pointerup);
    this.document.addEventListener('selectionchange', this._handlers.selectionchange);
    this.setPrefs(this.prefs);
  }

  load(doc, text) {
    this.clear();
    this.doc = doc;
    this.text = normalize(text ?? '');
    this.paragraphs = buildParagraphs(doc, this.text);
    const words = doc?.words || [];
    this._wordParagraph = new Int32Array(words.length);
    this._sentenceStart = new Int32Array(words.length);
    this._sentenceEnd = new Int32Array(words.length);
    let sentenceFrom = 0;
    for (let i = 0; i < words.length; i++) {
      if (!endsSentence(words[i].t) && !words[i].p && i !== words.length - 1) continue;
      this._sentenceStart.fill(sentenceFrom, sentenceFrom, i + 1);
      this._sentenceEnd.fill(i + 1, sentenceFrom, i + 1);
      sentenceFrom = i + 1;
    }
    const fragment = this.document.createDocumentFragment();
    let previous = 0;
    this.paragraphs.forEach((paragraph, i) => {
      if (paragraph.start > previous) fragment.append(this._textNode(previous, paragraph.start));
      const element = this.document.createElement('p');
      element.className = `immersive-paragraph${paragraph.continuation ? ' immersive-continuation' : ''}`;
      element.dataset.paragraph = String(i);
      element.append(this._textNode(paragraph.start, paragraph.end));
      this._paragraphElements.push(element);
      this._wordParagraph.fill(i, paragraph.startWord, paragraph.endWord);
      fragment.append(element);
      previous = paragraph.end;
    });
    if (previous < this.text.length) fragment.append(this._textNode(previous, this.text.length));
    this.content.replaceChildren(fragment);
    this.container.scrollTop = 0;
    if (words.length) this.setWord(0, { follow: false });
  }

  setWord(index, { follow = true, span = null } = {}) {
    if (!this.doc?.words.length) return;
    const next = clamp(Math.round(index), 0, this.doc.words.length - 1);
    if (!Number.isFinite(next)) return;
    const nextSpan = span?.timing === 'sentence' && Number.isInteger(span.from) && Number.isInteger(span.to)
      && span.from >= 0 && span.to > span.from && span.to <= this.doc.words.length
      ? { from: span.from, to: span.to, timing: 'sentence' } : null;
    const changed = this.index !== next || this._span?.from !== nextSpan?.from || this._span?.to !== nextSpan?.to;
    this.index = next;
    this._span = nextSpan;
    if (changed && !this._selecting) this._drawActive();
    if (follow && !this._selecting) this._followWord();
  }

  setPrefs(prefs) {
    const previousFollow = this.prefs.follow;
    this.prefs = sanitizeImmersivePrefs({ ...this.prefs, ...prefs });
    const style = this.container.style;
    style.setProperty('--highlight-rgb', HIGHLIGHT_COLORS[this.prefs.highlightColor].rgb);
    style.setProperty('--highlight-opacity', String(this.prefs.highlightOpacity));
    style.setProperty('--immersive-size', `${this.prefs.fontSize}px`);
    style.setProperty('--immersive-line-height', String(this.prefs.lineHeight));
    this.container.dataset.highlightStyle = this.prefs.highlightStyle;
    this.container.dataset.highlightColor = this.prefs.highlightColor;
    if (this.prefs.follow && !previousFollow) this._followSuspended = false;
    this._updateFollowState();
    if (!this._selecting) this._drawActive();
  }

  get followSuspended() { return this._followSuspended; }

  setFollow(on) {
    this.prefs.follow = Boolean(on);
    if (on) this._followSuspended = false;
    this._updateFollowState();
    if (on) this._followWord();
  }

  resumeFollow() { this.setFollow(true); }

  getSelectionRange() {
    const offsets = this._selectionOffsets();
    return offsets ? offsetsToWordRange(this.doc?.words, offsets.start, offsets.end) : null;
  }

  clear() {
    this.doc = null;
    this.text = '';
    this.index = -1;
    this._activeParagraph = -1;
    this._activeParagraphs = new Set();
    this._span = null;
    this._followSuspended = false;
    this._selecting = false;
    this._selectionKey = '';
    this._paragraphElements = [];
    this._textStarts = new WeakMap();
    this.paragraphs = [];
    this.content.replaceChildren();
    this._updateFollowState();
    this.onSelection(null);
  }

  unload() { this.clear(); }

  destroy() {
    const container = this.container;
    container.removeEventListener('click', this._handlers.click);
    container.removeEventListener('pointerdown', this._handlers.pointerdown);
    container.removeEventListener('wheel', this._handlers.manual);
    container.removeEventListener('touchmove', this._handlers.manual);
    container.removeEventListener('keydown', this._handlers.keydown);
    this.document.removeEventListener('pointerup', this._handlers.pointerup);
    this.document.removeEventListener('pointercancel', this._handlers.pointerup);
    this.document.removeEventListener('selectionchange', this._handlers.selectionchange);
    this.clear();
  }

  _textNode(start, end) {
    const node = this.document.createTextNode(this.text.slice(start, end));
    this._textStarts.set(node, start);
    return node;
  }

  _drawActive() {
    if (this.index < 0 || !this.doc?.words.length) return;
    const selection = this._selectionOffsets();
    const paragraphIndex = this._wordParagraph[this.index];
    const fromParagraph = this._span ? this._wordParagraph[this._span.from] : paragraphIndex;
    const toParagraph = this._span ? this._wordParagraph[this._span.to - 1] : paragraphIndex;
    const active = new Set();
    for (let i = fromParagraph; i <= toParagraph; i++) active.add(i);
    for (const i of this._activeParagraphs) {
      if (active.has(i)) continue;
      const old = this.paragraphs[i];
      this._paragraphElements[i].classList.remove('is-current');
      this._paragraphElements[i].replaceChildren(this._textNode(old.start, old.end));
    }
    for (const i of active) {
      const paragraph = this.paragraphs[i];
      if (!paragraph) continue;
      const element = this._paragraphElements[i];
      element.classList.add('is-current');
      const first = this._span ? Math.max(paragraph.startWord, this._span.from) : this.index;
      const last = this._span ? Math.min(paragraph.endWord, this._span.to) - 1 : this.index;
      const wordStart = this.doc.words[first].s;
      const wordEnd = this.doc.words[last].s + this.doc.words[last].t.length;
      const sentenceFirst = this._span ? first : Math.max(paragraph.startWord, this._sentenceStart[this.index]);
      const sentenceLast = this._span ? last : Math.min(paragraph.endWord, this._sentenceEnd[this.index]) - 1;
      const sentenceStart = this.prefs.sentenceHighlight ? this.doc.words[sentenceFirst].s : wordStart;
      const sentenceEnd = this.prefs.sentenceHighlight
        ? this.doc.words[sentenceLast].s + this.doc.words[sentenceLast].t.length : wordEnd;
      const fragment = this.document.createDocumentFragment();
      if (sentenceStart > paragraph.start) fragment.append(this._textNode(paragraph.start, sentenceStart));
      const sentence = this.document.createElement('span');
      sentence.className = this.prefs.sentenceHighlight ? 'immersive-sentence' : '';
      if (wordStart > sentenceStart) sentence.append(this._textNode(sentenceStart, wordStart));
      const mark = this.document.createElement('mark');
      mark.className = `immersive-word${this._span ? ' immersive-span' : ''}`;
      mark.dataset.word = String(this.index);
      mark.dataset.timing = this._span ? 'sentence' : 'word';
      mark.append(this._textNode(wordStart, wordEnd));
      sentence.append(mark);
      if (wordEnd < sentenceEnd) sentence.append(this._textNode(wordEnd, sentenceEnd));
      fragment.append(sentence);
      if (sentenceEnd < paragraph.end) fragment.append(this._textNode(sentenceEnd, paragraph.end));
      element.replaceChildren(fragment);
      if (i === paragraphIndex) this._currentMark = mark;
    }
    this._activeParagraph = paragraphIndex;
    this._activeParagraphs = active;
    if (selection) this._restoreSelection(selection);
  }

  _offsetAt(node, offset) {
    if (!node || !this.content.contains(node)) return null;
    if (node.nodeType === 3 && this._textStarts.has(node)) return this._textStarts.get(node) + offset;
    const paragraph = node.nodeType === 1 ? node.closest?.('[data-paragraph]') : node.parentElement?.closest('[data-paragraph]');
    const root = paragraph || this.content;
    const prefix = this.document.createRange();
    prefix.setStart(root, 0);
    prefix.setEnd(node, offset);
    return (paragraph ? this.paragraphs[Number(paragraph.dataset.paragraph)].start : 0) + prefix.toString().length;
  }

  _selectionOffsets() {
    const selection = this.document.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return null;
    const anchor = this._offsetAt(selection.anchorNode, selection.anchorOffset);
    const focus = this._offsetAt(selection.focusNode, selection.focusOffset);
    if (anchor === null || focus === null) return null;
    return { start: Math.min(anchor, focus), end: Math.max(anchor, focus), backward: anchor > focus };
  }

  _boundaryAt(offset) {
    let lo = 0, hi = this.paragraphs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (this.paragraphs[mid].start <= offset) lo = mid;
      else hi = mid - 1;
    }
    const paragraph = this.paragraphs[lo];
    const root = paragraph && offset >= paragraph.start && offset <= paragraph.end
      ? this._paragraphElements[lo] : this.content;
    const walker = this.document.createTreeWalker(root, 4); // SHOW_TEXT
    let node;
    while ((node = walker.nextNode())) {
      const start = this._textStarts.get(node);
      if (offset >= start && offset <= start + node.length) return { node, offset: offset - start };
    }
    return null;
  }

  _restoreSelection(offsets) {
    const start = this._boundaryAt(offsets.start);
    const end = this._boundaryAt(offsets.end);
    if (!start || !end) return;
    const selection = this.document.getSelection();
    if (selection.setBaseAndExtent) {
      const [anchor, focus] = offsets.backward ? [end, start] : [start, end];
      selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
    } else {
      const range = this.document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }

  _notifySelection() {
    const range = this.getSelectionRange();
    const key = range ? `${range.start}:${range.end}` : '';
    if (key === this._selectionKey) return;
    this._selectionKey = key;
    this.onSelection(range);
  }

  _click(event) {
    if (!this.doc?.words.length || this.getSelectionRange()) return;
    const target = event.target.closest?.('.immersive-word');
    if (target && target.dataset.timing !== 'sentence') { this.onSeek(Number(target.dataset.word)); return; }
    let caret;
    if (this.document.caretPositionFromPoint) {
      const point = this.document.caretPositionFromPoint(event.clientX, event.clientY);
      if (point) caret = { node: point.offsetNode, offset: point.offset };
    } else if (this.document.caretRangeFromPoint) {
      const range = this.document.caretRangeFromPoint(event.clientX, event.clientY);
      if (range) caret = { node: range.startContainer, offset: range.startOffset };
    }
    if (!caret) return;
    const offset = this._offsetAt(caret.node, caret.offset);
    if (offset !== null) this.onSeek(wordAtOffset(this.doc.words, offset));
  }

  _suspendFollow() {
    if (!this.prefs.follow || this._followSuspended) return;
    this._followSuspended = true;
    this._updateFollowState();
    this.onManualScroll();
  }

  _updateFollowState() {
    this.container.dataset.follow = !this.prefs.follow ? 'off' : this._followSuspended ? 'paused' : 'on';
  }

  _followWord() {
    if (!this.prefs.follow || this._followSuspended || !this._currentMark || this.container.hidden) return;
    const viewport = this.container.getBoundingClientRect();
    if (!viewport.height) return;
    const word = this._currentMark.getBoundingClientRect();
    const top = viewport.top + viewport.height * 0.23;
    const bottom = viewport.top + viewport.height * 0.76;
    if (word.top >= top && word.bottom <= bottom) return;
    const reduced = this.document.defaultView.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    this.container.scrollTo({
      top: this.container.scrollTop + word.top - viewport.top - viewport.height * 0.4,
      behavior: reduced ? 'instant' : 'smooth',
    });
  }
}
