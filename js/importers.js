// Local imports share normalized text and character-based section locations.
import { htmlToText, normalize } from './text.js';

const vendor = (path) => new URL(`../vendor/${path}`, import.meta.url).href;
const OCR_VERSION = '7.0.0';
const OCR_CDN = 'https://cdn.jsdelivr.net/npm/';
const scripts = new Map();
const baseName = (name) => name.replace(/\.[^.]+$/, '');

function importError(message, code) {
  return Object.assign(new Error(message), { code });
}

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('Import cancelled.', 'AbortError');
}

function abortable(promise, signal, cancel = () => {}) {
  if (signal?.aborted) {
    try { cancel(); } catch {}
    Promise.resolve(promise).catch(() => {});
  }
  checkAbort(signal);
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => {
      try { cancel(); } catch {}
      reject(new DOMException('Import cancelled.', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function progress(options, message) {
  checkAbort(options.signal);
  options.onProgress?.(message);
}

function loadScript(src, signal) {
  if (!scripts.has(src)) {
    scripts.set(src, new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = resolve;
      el.onerror = () => {
        scripts.delete(src);
        el.remove();
        reject(new Error('Could not download the reading tools. Check your connection and try again.'));
      };
      document.head.appendChild(el);
    }));
  }
  return abortable(scripts.get(src), signal);
}

function ensureText(text, what) {
  const result = normalize(text || '').trim();
  if (!result) throw new Error(`No readable text found in ${what}.`);
  return result;
}

// Normalize parts before measuring; offsets are UTF-16 and end exclusive.
export function joinSections(parts) {
  let text = '';
  const sections = [];
  for (const part of parts) {
    const content = normalize(part.text || '').trim();
    if (!content) continue;
    if (text) text += '\n\n';
    const start = text.length;
    text += content;
    const { text: ignored, ...location } = part;
    sections.push({ ...location, title: part.title || `Section ${sections.length + 1}`, start, end: text.length });
  }
  return { text, sections };
}

export function isHtmlText(text) {
  return /^\s*(?:<!doctype\s+html\b|<(?:html|head|body|article|main|div|section|h[1-6]|p|blockquote|ul|ol|table)\b)/i.test(text);
}

export async function importFile(file, options = {}) {
  checkAbort(options.signal);
  const name = file.name || 'Untitled';
  const ext = (name.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
  if (ext === 'epub' || file.type === 'application/epub+zip') return importEpub(file, options);
  if (ext === 'pdf' || file.type === 'application/pdf') return importPdf(file, options);
  const raw = await abortable(file.text(), options.signal);
  if (['html', 'htm', 'xhtml'].includes(ext) || file.type === 'text/html' || isHtmlText(raw)) {
    const article = await articleFromHtml(raw, '', options);
    return { ...article, title: article.title || baseName(name), source: 'file' };
  }
  const title = baseName(name);
  return { title, ...joinSections([{ title, text: ensureText(raw, name) }]), source: 'file' };
}

// Mark headings in a clone before using the existing text extraction. Markers
// disappear during assembly; imported HTML is never rendered or executed.
function htmlSections(root, title) {
  const clone = root.cloneNode(true);
  const nonce = `reader-${Math.random().toString(36).slice(2)}-`;
  const headings = [...clone.querySelectorAll('h1,h2,h3,h4,h5,h6')];
  const titles = headings.map((heading) => normalize(heading.textContent).replace(/\s+/g, ' ').trim());
  headings.forEach((heading, i) => heading.prepend(clone.ownerDocument.createTextNode(`\uE000${nonce}${i}\uE001`)));
  const pieces = htmlToText(clone).split(new RegExp(`\uE000${nonce}(\\d+)\uE001`, 'g'));
  const parts = [{ title, text: pieces[0] }];
  for (let i = 1; i < pieces.length; i += 2) parts.push({ title: titles[Number(pieces[i])] || title, text: pieces[i + 1] });
  return joinSections(parts);
}

export async function articleFromHtml(html, url = '', options = {}) {
  checkAbort(options.signal);
  if (!isHtmlText(html) && !/<\/?[a-z][a-z0-9]*\b[^>]*>/i.test(html)) {
    const title = url || 'Imported text';
    return { title, ...joinSections([{ title, text: ensureText(html, 'this text') }]), source: 'web', url };
  }
  progress(options, 'Extracting the article…');
  await loadScript(vendor('Readability.js'), options.signal);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (url) {
    const base = doc.createElement('base');
    base.href = url;
    doc.head.prepend(base);
  }
  let title = doc.title || doc.querySelector('h1')?.textContent?.trim() || '';
  let root = doc.body;
  let article;
  try {
    article = new window.Readability(doc.cloneNode(true)).parse();
    if (article?.content) {
      title = article.title || title;
      const h1 = doc.querySelector('h1')?.textContent?.replace(/\s+/g, ' ').trim();
      if (h1 && h1.length >= 4 && title.includes(h1)) title = h1;
      const extracted = new DOMParser().parseFromString(article.content, 'text/html').body;
      if (htmlToText(extracted).trim()) root = extracted;
    }
  } catch { /* Unusual pages still have a plain-text fallback. */ }
  title = normalize(title).trim();
  let result = htmlSections(root, title || 'Article');
  ensureText(result.text, 'this page');
  if (title && !result.text.startsWith(title)) {
    const shift = title.length + 2;
    result = {
      text: `${title}\n\n${result.text}`,
      sections: result.sections.map((s, i) => ({ ...s, start: i ? s.start + shift : 0, end: s.end + shift })),
    };
  }
  return {
    title: title || url || 'Web page', ...result, source: 'web', url,
    metadata: { author: article?.byline || '', language: article?.lang || doc.documentElement.lang || '', publishedTime: article?.publishedTime || '', siteName: article?.siteName || '' },
  };
}

async function importEpub(file, options) {
  progress(options, 'Opening the EPUB…');
  await loadScript(vendor('jszip.min.js'), options.signal);
  const zip = await abortable(window.JSZip.loadAsync(file), options.signal);
  const read = async (path) => {
    checkAbort(options.signal);
    const entry = zip.file(path);
    if (!entry) throw new Error(`Missing ${path} in the EPUB.`);
    return abortable(entry.async('string'), options.signal);
  };
  const parseXml = (s) => new DOMParser().parseFromString(s, 'application/xml');
  if (zip.file('META-INF/license.lcpl')) throw importError('This EPUB is protected with DRM. Import a DRM-free copy you can access.', 'DRM_UNSUPPORTED');
  if (zip.file('META-INF/encryption.xml')) {
    const encryption = parseXml(await read('META-INF/encryption.xml'));
    const allowed = new Set(['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC']);
    const encrypted = [...encryption.getElementsByTagNameNS('*', 'EncryptedData')];
    if (encrypted.some((item) => !allowed.has(item.getElementsByTagNameNS('*', 'EncryptionMethod')[0]?.getAttribute('Algorithm')))) {
      throw importError('This EPUB has encrypted content. Import a DRM-free copy you can access.', 'DRM_UNSUPPORTED');
    }
  }
  const container = parseXml(await read('META-INF/container.xml'));
  const opfPath = container.getElementsByTagNameNS('*', 'rootfile')[0]?.getAttribute('full-path');
  if (!opfPath) throw new Error('Invalid EPUB: no package file.');
  const opf = parseXml(await read(opfPath));
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const manifest = new Map();
  for (const item of opf.getElementsByTagNameNS('*', 'item')) {
    manifest.set(item.getAttribute('id'), { href: item.getAttribute('href'), type: item.getAttribute('media-type') || '', props: item.getAttribute('properties') || '' });
  }
  const value = (key) => opf.getElementsByTagNameNS('*', key)[0]?.textContent?.trim() || '';
  const title = value('title') || baseName(file.name);
  const chapters = [];
  for (const ref of opf.getElementsByTagNameNS('*', 'itemref')) {
    if (ref.getAttribute('linear') === 'no') continue;
    const item = manifest.get(ref.getAttribute('idref'));
    if (!item?.href || !/html|xml/.test(item.type) || /\bnav\b/.test(item.props)) continue;
    const href = resolvePath(opfDir, item.href);
    progress(options, `Reading chapter ${chapters.length + 1}…`);
    const markup = await read(href);
    let doc = new DOMParser().parseFromString(markup, 'application/xhtml+xml');
    if (doc.getElementsByTagName('parsererror').length) doc = new DOMParser().parseFromString(markup, 'text/html');
    const body = doc.getElementsByTagNameNS('*', 'body')[0] || doc.documentElement;
    const chapterTitle = body.querySelector('h1,h2,h3')?.textContent?.replace(/\s+/g, ' ').trim()
      || doc.getElementsByTagNameNS('*', 'title')[0]?.textContent?.trim() || `Chapter ${chapters.length + 1}`;
    chapters.push({ title: chapterTitle, href, text: htmlToText(body) });
  }
  const result = joinSections(chapters);
  ensureText(result.text, 'this EPUB');
  return { title, ...result, source: 'epub', metadata: { author: value('creator'), language: value('language') } };
}

function resolvePath(dir, href) {
  const out = [];
  for (const part of (dir + decodeURIComponent(href.split('#')[0])).split('/')) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return out.join('/');
}

// Text items may be fragments of one word, separate words without spaces, or
// interleaved columns. Physical separation determines when to add a space.
export function pdfItemsToLines(items, { page = 1, width = 0, height = 0 } = {}) {
  const rows = [];
  for (const item of items) {
    if (typeof item.str !== 'string' || !item.str.trim() || !item.transform) continue;
    const x = item.transform[4], y = item.transform[5];
    const h = Math.max(1, Math.abs(item.height || item.transform[3] || 10));
    const fragment = { text: item.str, x, y, height: h, width: Math.abs(item.width || 0), dir: item.dir || 'ltr' };
    let row = rows.find((r) => Math.abs(r.y - y) <= Math.max(1, Math.min(r.height, h) * 0.25));
    if (!row) rows.push(row = { y, height: h, fragments: [] });
    row.fragments.push(fragment);
  }
  const lines = [];
  for (const row of rows) {
    const fragments = row.fragments.sort((a, b) => a.x - b.x);
    let run = [];
    const flush = () => {
      if (!run.length) return;
      const rtl = run.filter((f) => f.dir === 'rtl').length > run.length / 2;
      const ordered = rtl ? [...run].reverse() : run;
      let text = '';
      for (let i = 0; i < ordered.length; i++) {
        const current = ordered[i], previous = ordered[i - 1];
        const gap = previous ? (rtl ? previous.x - current.x - current.width : current.x - previous.x - previous.width) : 0;
        if (text && !/\s$/.test(text) && !/^\s|^[,.;:!?)}\]]/.test(current.text) && gap > current.height * 0.12) text += ' ';
        text += current.text;
      }
      text = text.replace(/\s+/g, ' ').trim();
      const x = run[0].x, right = Math.max(...run.map((f) => f.x + f.width));
      if (text && !(height && /^\d{1,4}$/.test(text) && (row.y < height * 0.1 || row.y > height * 0.96))) {
        lines.push({ text, x, y: row.y, width: right - x, height: row.height, page, dir: rtl ? 'rtl' : 'ltr' });
      }
      run = [];
    };
    for (const fragment of fragments) {
      const previous = run[run.length - 1];
      if (previous && fragment.x - previous.x - previous.width > Math.max(24, fragment.height * 2.5)) flush();
      run.push(fragment);
    }
    flush();
  }
  lines.sort((a, b) => b.y - a.y || a.x - b.x);
  if (!width) return lines;
  const mid = width / 2;
  const left = lines.filter((l) => l.x < mid && l.x + l.width < mid + 6);
  const right = lines.filter((l) => l.x >= mid - 6);
  const paired = left.filter((l) => right.some((r) => Math.abs(l.y - r.y) <= Math.max(l.height, r.height))).length;
  if (left.length < 3 || right.length < 3 || paired < 3) return lines;
  const spanning = lines.filter((l) => !left.includes(l) && !right.includes(l));
  const result = [];
  const rtl = lines.filter((l) => l.dir === 'rtl').length > lines.length / 2;
  let top = Infinity;
  for (const span of [...spanning, { y: -Infinity }]) {
    const groups = rtl ? [right, left] : [left, right];
    groups.forEach((group, column) => result.push(...group.filter((l) => l.y <= top && l.y > span.y).map((l) => ({ ...l, column }))));
    if (span.y !== -Infinity) result.push({ ...span, column: -1 });
    top = span.y;
  }
  return result;
}

export function pdfLinesToText(lines) {
  const gaps = lines.slice(1).map((line, i) => {
    const previous = lines[i];
    return line.page === previous.page && line.column === previous.column ? previous.y - line.y : 0;
  }).filter((gap) => gap > 0).sort((a, b) => a - b);
  const typical = gaps.length ? gaps[Math.floor((gaps.length - 1) / 2)] : 0;
  let out = '';
  lines.forEach((line, i) => {
    if (!i) { out = line.text; return; }
    const previous = lines[i - 1];
    const gap = previous.y - line.y;
    const sameFlow = line.page === previous.page && line.column === previous.column;
    const newPara = !sameFlow || (typical && gap > typical * 1.5) || gap < 0;
    if (newPara) out += '\n\n' + line.text;
    else if (/[A-Za-z]-$/.test(out) && /^[a-z]/.test(line.text)) out = out.slice(0, -1) + line.text;
    else out += ' ' + line.text;
  });
  return out;
}

export function normalizeOcrText(text) {
  return normalize(text).replace(/([A-Za-z])-\n([a-z])/g, '$1$2')
    .split(/\n\s*\n/).map((part) => part.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n\n');
}

async function importPdf(file, options) {
  progress(options, 'Opening the PDF…');
  const pdfjs = await abortable(import(vendor('pdfjs/pdf.min.js')), options.signal);
  pdfjs.GlobalWorkerOptions.workerSrc = vendor('pdfjs/pdf.worker.min.js');
  const task = pdfjs.getDocument({ data: new Uint8Array(await abortable(file.arrayBuffer(), options.signal)), cMapUrl: vendor('pdfjs/cmaps/'), cMapPacked: true, isEvalSupported: false });
  let ocrWorker;
  let ocrPage = 0;
  const terminateOcr = () => { if (ocrWorker) void ocrWorker.terminate().catch(() => {}); };
  const pages = [], skippedPages = [], ocrPages = [];
  try {
    const pdf = await abortable(task.promise, options.signal, () => void task.destroy());
    const getOcrWorker = async () => {
      if (ocrWorker) return ocrWorker;
      progress(options, 'Downloading free OCR tools and the English model (first use)…');
      await loadScript(`${OCR_CDN}tesseract.js@${OCR_VERSION}/dist/tesseract.min.js`, options.signal);
      const creating = window.Tesseract.createWorker('eng', 1, {
        workerPath: `${OCR_CDN}tesseract.js@${OCR_VERSION}/dist/worker.min.js`,
        corePath: `${OCR_CDN}tesseract.js-core@${OCR_VERSION}`,
        langPath: `${OCR_CDN}@tesseract.js-data/eng@1.0.0/4.0.0_best_int`,
        logger: (event) => {
          if (options.signal?.aborted) return;
          options.onProgress?.(`OCR page ${ocrPage} of ${pdf.numPages}: ${event.status}${Number.isFinite(event.progress) ? ` · ${Math.round(event.progress * 100)}%` : ''}`);
        },
      });
      creating.then((worker) => { if (options.signal?.aborted) void worker.terminate().catch(() => {}); }, () => {});
      ocrWorker = await abortable(creating, options.signal);
      await abortable(ocrWorker.setParameters({ tessedit_pageseg_mode: '3' }), options.signal, terminateOcr);
      return ocrWorker;
    };
    for (let p = 1; p <= pdf.numPages; p++) {
      progress(options, `Reading PDF page ${p} of ${pdf.numPages}…`);
      const page = await abortable(pdf.getPage(p), options.signal);
      try {
        const content = await abortable(page.getTextContent(), options.signal);
        const view = page.view;
        const lines = pdfItemsToLines(content.items, { page: p, width: view[2] - view[0], height: view[3] - view[1] });
        let text = pdfLinesToText(lines);
        if (!text.trim() && options.ocr) {
          ocrPage = p;
          const worker = await getOcrWorker();
          progress(options, `Scanning PDF page ${p} of ${pdf.numPages} on this device…`);
          const natural = page.getViewport({ scale: 1 });
          const scale = Math.min(2.5, 2800 / Math.max(natural.width, natural.height));
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          try {
            const render = page.render({ canvasContext: canvas.getContext('2d'), viewport, background: 'white' });
            await abortable(render.promise, options.signal, () => render.cancel());
            const result = await abortable(worker.recognize(canvas), options.signal, terminateOcr);
            text = normalizeOcrText(result.data.text || '');
            if (text.trim()) ocrPages.push(p);
          } finally { canvas.width = canvas.height = 0; }
        }
        if (text.trim()) pages.push({ title: `Page ${p}`, page: p, text });
        else skippedPages.push(p);
      } finally { page.cleanup(); }
    }
    const info = (await abortable(pdf.getMetadata().catch(() => null), options.signal))?.info;
    const title = info?.Title?.trim() || baseName(file.name);
    const result = joinSections(pages);
    if (!result.text) {
      if (!options.ocr) throw importError('This PDF has no readable text layer. Enable “Scan PDF with OCR” and import it again.', 'OCR_REQUIRED');
      throw new Error('OCR found no readable text in this PDF. Try a clearer scan or another file.');
    }
    const warnings = skippedPages.length ? [`Pages ${skippedPages.join(', ')} had no readable text and were skipped.${options.ocr ? '' : ' Enable OCR to scan image-only pages.'}`] : [];
    return { title, ...result, source: 'pdf', metadata: { author: info?.Author || '', pageCount: pdf.numPages, ocrPages, skippedPages }, warnings };
  } catch (error) {
    checkAbort(options.signal);
    if (error.name === 'PasswordException') throw importError('This PDF requires a password. Open an unlocked copy to read it here.', 'PDF_PASSWORD_REQUIRED');
    throw error;
  } finally {
    if (ocrWorker) await ocrWorker.terminate().catch(() => {});
    await task.destroy();
  }
}
