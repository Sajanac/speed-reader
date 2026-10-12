import test from 'node:test';
import assert from 'node:assert/strict';
import { importFile, articleFromHtml, isHtmlText, joinSections, pdfItemsToLines, pdfLinesToText, normalizeOcrText } from '../js/importers.js';

const item = (str, x, y, width, dir = 'ltr') => ({ str, transform: [12, 0, 0, 12, x, y], width, height: 12, dir });

test('section locations map to final normalized text, including Unicode', () => {
  const doc = joinSections([
    { title: 'Opening', text: ' \uFEFFHi\u00A0there\u00AD!\r\n😀 ', href: 'chapter-one.xhtml' },
    { title: 'Empty', text: '\n ' },
    { title: 'Next', text: ' Next\r\npage. ', page: 2 },
  ]);
  assert.equal(doc.text, 'Hi there!\n😀\n\nNext\npage.');
  assert.equal(doc.sections.length, 2);
  assert.equal(doc.sections[0].href, 'chapter-one.xhtml');
  assert.equal(doc.sections[1].page, 2);
  assert.equal(doc.text.slice(doc.sections[0].start, doc.sections[0].end), 'Hi there!\n😀');
  assert.equal(doc.text.slice(doc.sections[1].start, doc.sections[1].end), 'Next\npage.');
  assert.equal(doc.sections[1].start, doc.sections[0].end + 2);
});

test('PDF geometry joins word fragments, adds missing spaces, keeps punctuation attached', () => {
  const lines = pdfItemsToLines([
    item('text', 76, 500, 24), item('Read', 30, 500, 24), item('ing', 54, 500, 18), item(',', 101, 500, 3),
  ]);
  assert.deepEqual(lines.map((line) => line.text), ['Reading text,']);
});

test('PDF geometry orders supported two-column pages down each column', () => {
  const items = [item('Full width heading', 40, 740, 500)];
  for (let i = 0; i < 3; i++) items.push(item(`Right ${i + 1}`, 330, 700 - i * 16, 160), item(`Left ${i + 1}`, 40, 700 - i * 16, 160));
  const lines = pdfItemsToLines(items, { page: 3, width: 600, height: 800 });
  assert.deepEqual(lines.map((line) => line.text), ['Full width heading', 'Left 1', 'Left 2', 'Left 3', 'Right 1', 'Right 2', 'Right 3']);
  assert.deepEqual(lines.map((line) => line.column), [-1, 0, 0, 0, 1, 1, 1]);
  assert.ok(lines.every((line) => line.page === 3));
  assert.match(pdfLinesToText(lines), /Left 3\n\nRight 1/);
});

test('short side-by-side content does not trigger column reordering', () => {
  const lines = pdfItemsToLines([item('One', 40, 700, 100), item('Two', 330, 700, 100), item('Three', 40, 680, 100), item('Four', 330, 680, 100)], { width: 600, height: 800 });
  assert.deepEqual(lines.map((line) => line.text), ['One', 'Two', 'Three', 'Four']);
  assert.ok(lines.every((line) => line.column === undefined));
});

test('PDF margin page numbers are removed while body numerals remain', () => {
  const lines = pdfItemsToLines([item('42', 40, 400, 12), item('7', 300, 20, 6)], { height: 800 });
  assert.deepEqual(lines.map((line) => line.text), ['42']);
});

test('PDF paragraphs and page breaks retain separate source flows', () => {
  const lines = [
    { text: 'A para-', y: 700, page: 1 }, { text: 'graph continues.', y: 684, page: 1 },
    { text: 'Another paragraph.', y: 644, page: 1 }, { text: 'Next page.', y: 700, page: 2 },
  ];
  assert.equal(pdfLinesToText(lines), 'A paragraph continues.\n\nAnother paragraph.\n\nNext page.');
});

test('OCR normalization joins wrapped lines without losing paragraphs', () => {
  assert.equal(normalizeOcrText('A para-\r\ngraph\ncontinues.\n\nSecond paragraph.'), 'A paragraph continues.\n\nSecond paragraph.');
});

test('HTML sniffing recognizes complete documents/fragments without treating angle numbers as markup', () => {
  assert.equal(isHtmlText('  <!DOCTYPE HTML><html>'), true);
  assert.equal(isHtmlText('<h2>Heading</h2><p>Text</p>'), true);
  assert.equal(isHtmlText('The value is < 10.\n\nMore text.'), false);
});

test('plain text import returns a section and preserves its public contract', async () => {
  const result = await importFile({ name: 'notes.txt', type: 'text/plain', text: async () => ' First\r\n\r\nSecond. ' });
  assert.equal(result.title, 'notes');
  assert.equal(result.source, 'file');
  assert.equal(result.text, 'First\n\nSecond.');
  assert.deepEqual(result.sections, [{ title: 'notes', start: 0, end: result.text.length }]);
});

test('plain article-text fallback preserves paragraph breaks without browser APIs', async () => {
  const result = await articleFromHtml('First.\n\nSecond.');
  assert.equal(result.text, 'First.\n\nSecond.');
  assert.equal(result.sections[0].end, result.text.length);
});

test('an import can be cancelled while its file is still being read', async () => {
  const controller = new AbortController();
  const result = importFile({ name: 'notes.txt', text: () => new Promise(() => {}) }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(result, { name: 'AbortError' });
});

test('empty text imports report the missing content', async () => {
  await assert.rejects(importFile({ name: 'empty.txt', text: async () => ' \n ' }), /No readable text/);
});
