# Local document imports

`importFile(file, options)` and `articleFromHtml(html, url, options)` keep the existing `{title, text, source, url?}` result. They also return `sections`, ordered ranges in the final normalized text. Each section has `{title, start, end, page?, href?}`. Offsets count UTF-16 characters and `end` is exclusive, matching the token offsets and browser speech events. Metadata can include author, language, publication date, PDF page count, OCR pages and skipped pages. A PDF can return `warnings` when pages could not be read.

The optional settings are `ocr` (default false), `signal` (an AbortSignal) and `onProgress(message)`. Cancellation rejects with `AbortError`. Import progress can drive the UI without a server or paid endpoint.

## Websites and blogs

Mozilla Readability extracts the main article. Headings become sections and paragraphs retain their breaks. The importer also accepts standalone HTML and plain article text. HTML is parsed into an inert document and converted to plain text; imported markup is never inserted into the reader UI. The bookmarklet and blog embed continue to capture the page the reader already has permission to view. Arbitrary URL downloads still require a cooperating origin or a backend because of browser CORS restrictions.

## EPUB

The local JSZip parser reads chapters in OPF spine order and retains chapter headings and source paths. Navigation documents and non-linear spine entries are skipped. Font obfuscation does not block extraction. LCP licenses and other encrypted content report `DRM_UNSUPPORTED`; the reader does not remove DRM. This reading view extracts text rather than reproducing fixed layouts, book styling or EPUB media overlays.

## PDF

PDF.js extracts the existing text layer locally. Geometry reconstructs spaces and lines and conservatively reorders repeated pairs of columns. Full-width headings divide column bands. Page numbers in the outer margins are omitted; body numerals remain. The result retains page sections. Complex tables, unusual rotations and mixed layouts can still require a better source document or a selected-text import. Password-protected PDFs report `PDF_PASSWORD_REQUIRED` and need an unlocked copy.

If a PDF contains no readable text and OCR is disabled, the error has `code: 'OCR_REQUIRED'`. Mixed documents retain their readable pages and report skipped pages. With OCR enabled, only pages without readable text are scanned. Blank image pages may remain skipped.

## Free OCR and downloads

OCR renders one page at a time with PDF.js and runs Tesseract.js in a worker on the device. The current first version recognizes English. The document and page images are not uploaded. The first scan needs internet access to download public code and a language model from jsDelivr. The pinned versions are `tesseract.js@7.0.0`, `tesseract.js-core@7.0.0` and `@tesseract.js-data/eng@1.0.0`. Model data is cached by Tesseract.js in browser storage when available; runtime files depend on the browser's HTTP cache. Offline OCR is therefore not guaranteed. Cancellation stops recognition and page rendering; a library initialization download already in flight can finish before its worker is disposed.

The model is roughly 3 MB compressed; the runtime adds several MB depending on device capabilities. OCR may take time on phones, and its text can contain recognition errors. Large pages are rendered at a bounded resolution and canvases/workers are released after use.

To self-host OCR later, serve the complete matching Tesseract distribution, all selected core variants and the English traineddata file, then change the importer URLs. This remains compatible with static hosting and introduces no per-character fee.

References: [Tesseract.js API](https://github.com/naptha/tesseract.js/blob/v7.0.0/docs/api.md), [version 7 release](https://github.com/naptha/tesseract.js/releases/tag/v7.0.0), [PDF.js text content](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFPageProxy.html), [Mozilla Readability](https://github.com/mozilla/readability).
