// Turn files and web pages into plain text with paragraph breaks.

import { htmlToText, normalize } from './text.js';

const vendor = (path) => new URL(`../vendor/${path}`, import.meta.url).href;

const scripts = new Map();
function loadScript(src) {
  if (!scripts.has(src)) {
    scripts.set(
      src,
      new Promise((resolve, reject) => {
        const el = document.createElement('script');
        el.src = src;
        el.onload = resolve;
        el.onerror = () => {
          scripts.delete(src);
          reject(new Error(`Could not load ${src}`));
        };
        document.head.appendChild(el);
      }),
    );
  }
  return scripts.get(src);
}

const baseName = (name) => name.replace(/\.[^.]+$/, '');

function ensureText(text, what) {
  if (!text || !text.trim()) throw new Error(`No readable text found in ${what}.`);
  return normalize(text).trim();
}

export async function importFile(file) {
  const name = file.name || 'Untitled';
  const ext = (name.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
  if (ext === 'epub' || file.type === 'application/epub+zip') return importEpub(file);
  if (ext === 'pdf' || file.type === 'application/pdf') return importPdf(file);
  if (ext === 'html' || ext === 'htm' || ext === 'xhtml' || file.type === 'text/html') {
    const article = await articleFromHtml(await file.text(), '');
    return { ...article, title: article.title || baseName(name), source: 'file' };
  }
  const text = ensureText(await file.text(), name);
  return { title: baseName(name), text, source: 'file' };
}

// Reader-mode extraction using Mozilla Readability (the same approach as
// Safari Reader). `html` is only parsed, never inserted into the page.
export async function articleFromHtml(html, url) {
  await loadScript(vendor('Readability.js'));
  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (url) {
    const base = doc.createElement('base');
    base.href = url;
    doc.head.prepend(base);
  }
  const pageTitle = doc.title;
  let title = pageTitle;
  let text = '';
  try {
    const article = new window.Readability(doc.cloneNode(true)).parse();
    if (article?.content) {
      title = article.title || pageTitle;
      // Prefer the page's headline over "Headline | Site Name".
      const h1 = doc.querySelector('h1')?.textContent.replace(/\s+/g, ' ').trim();
      if (h1 && h1.length >= 4 && title.includes(h1)) title = h1;
      text = htmlToText(new DOMParser().parseFromString(article.content, 'text/html').body);
    }
  } catch {
    // fall back to the whole page below
  }
  if (!text.trim()) text = htmlToText(doc.body);
  text = ensureText(text, 'this page');
  if (title && !text.startsWith(title.trim())) text = `${title.trim()}\n\n${text}`;
  return { title: title || url || 'Web page', text, source: 'web', url };
}

async function importEpub(file) {
  await loadScript(vendor('jszip.min.js'));
  const zip = await window.JSZip.loadAsync(file);
  const read = async (path) => {
    const entry = zip.file(path);
    if (!entry) throw new Error(`Missing ${path} in ePub.`);
    return entry.async('string');
  };
  const parseXml = (s) => new DOMParser().parseFromString(s, 'application/xml');

  const container = parseXml(await read('META-INF/container.xml'));
  const opfPath = container.getElementsByTagNameNS('*', 'rootfile')[0]?.getAttribute('full-path');
  if (!opfPath) throw new Error('Invalid ePub: no package file.');
  const opf = parseXml(await read(opfPath));
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

  const manifest = new Map();
  for (const item of opf.getElementsByTagNameNS('*', 'item')) {
    manifest.set(item.getAttribute('id'), {
      href: item.getAttribute('href'),
      type: item.getAttribute('media-type') || '',
      props: item.getAttribute('properties') || '',
    });
  }
  const title = opf.getElementsByTagNameNS('*', 'title')[0]?.textContent?.trim() || baseName(file.name);

  const chapters = [];
  for (const ref of opf.getElementsByTagNameNS('*', 'itemref')) {
    if (ref.getAttribute('linear') === 'no') continue;
    const item = manifest.get(ref.getAttribute('idref'));
    if (!item || !/html|xml/.test(item.type) || /\bnav\b/.test(item.props)) continue;
    const path = resolvePath(opfDir, item.href);
    let markup;
    try {
      markup = await read(path);
    } catch {
      continue;
    }
    let doc = new DOMParser().parseFromString(markup, 'application/xhtml+xml');
    if (doc.getElementsByTagName('parsererror').length) doc = new DOMParser().parseFromString(markup, 'text/html');
    const body = doc.getElementsByTagNameNS('*', 'body')[0] || doc.documentElement;
    const text = htmlToText(body);
    if (text) chapters.push(text);
  }
  return { title, text: ensureText(chapters.join('\n\n'), 'this ePub (it may be DRM-protected)'), source: 'epub' };
}

function resolvePath(dir, href) {
  const parts = (dir + decodeURIComponent(href.split('#')[0])).split('/');
  const out = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p && p !== '.') out.push(p);
  }
  return out.join('/');
}

async function importPdf(file) {
  const pdfjs = await import(vendor('pdfjs/pdf.min.js'));
  pdfjs.GlobalWorkerOptions.workerSrc = vendor('pdfjs/pdf.worker.min.js');
  const task = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    cMapUrl: vendor('pdfjs/cmaps/'),
    cMapPacked: true,
    isEvalSupported: false,
  });
  const pdf = await task.promise;

  const lines = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    let cur = '';
    let y = null;
    const flush = () => {
      const text = cur.replace(/\s+/g, ' ').trim();
      // Drop bare page numbers.
      if (text && !/^\d{1,4}$/.test(text)) lines.push({ text, y, page: p });
      cur = '';
      y = null;
    };
    for (const item of content.items) {
      if (typeof item.str !== 'string') continue;
      if (y === null) y = item.transform[5];
      cur += item.str;
      if (item.hasEOL) flush();
    }
    flush();
    page.cleanup();
  }
  const title = (await pdf.getMetadata().catch(() => null))?.info?.Title?.trim() || baseName(file.name);
  task.destroy();
  return { title, text: ensureText(pdfLinesToText(lines), 'this PDF (scanned PDFs have no text layer)'), source: 'pdf' };
}

// Join PDF lines into paragraphs: a larger-than-usual vertical gap starts a
// new paragraph; hyphenated line breaks are re-joined.
export function pdfLinesToText(lines) {
  const gaps = [];
  for (let i = 1; i < lines.length; i++) {
    const g = lines[i - 1].y - lines[i].y;
    if (lines[i].page === lines[i - 1].page && g > 0) gaps.push(g);
  }
  gaps.sort((a, b) => a - b);
  const typical = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;

  let out = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].text;
    if (i === 0) {
      out = line;
      continue;
    }
    const prev = lines[i - 1];
    const gap = prev.y - lines[i].y;
    const samePage = prev.page === lines[i].page;
    const newPara = samePage && typical > 0 && (gap > typical * 1.5 || gap < 0);
    if (newPara) out += '\n\n' + line;
    else if (/[A-Za-z]-$/.test(out) && /^[a-z]/.test(line)) out = out.slice(0, -1) + line;
    else out += ' ' + line;
  }
  return out;
}
