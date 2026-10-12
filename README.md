# Speed Reader

A browser reader with three modes: **One word** (RSVP), **Read along** (selectable paragraphs with spoken highlights), and **Listen**. It supports articles, PDFs, and DRM-free EPUB books, with free device voices and optional natural narration using Kokoro.

The public site is static, with no build step or paid TTS account. Documents, progress, and prepared audio stay in this browser. Optional local Mac narration uses a separate free service; browser narration runs on the device after a model download.

## Features

- **Immersive reading.** Selectable paragraphs, click a word to start there, automatic following that pauses when you scroll, and reading a selected passage. Eleven pastel/neutral colors include lavender, mint, peach, cream, sand, taupe, and warm gray. Choose full, half, underline, or rounded highlights; adjust opacity, sentence emphasis, text size, line spacing, font, and light/dark appearance. Bookmarks and reading preferences persist on the device.
- **Natural narration.** Browser Kokoro runs in a worker on the CPU; the first use downloads about 90 MB of model weights plus runtime assets. It supplies sentence audio, so highlights follow sentences. The local Mac Kokoro adapter accepts matching word captions for word highlights, with an explicit sentence fallback when they do not match. Both use native HTML audio after preparation. See [natural voice setup](docs/LOCAL_VOICE.md).
- **Offline audio.** Prepared audio is saved in IndexedDB. Export a `.readalong` package to transfer text/audio/timings/highlight appearance to a phone, or download a WAV/MP3 audiobook. Keep exported files for durable storage: browsers can evict cached data. A service worker keeps the reader shell available after its first successful online visit. First-time OCR/model downloads need internet.
- **Listening controls.** Native audio supports play/pause, speed, 15-second skips in Listen mode, and Media Session metadata/actions for system controls. Bluetooth/car audio is supported through ordinary phone audio playback. This website does not supply a native CarPlay app or entitlement; lock-screen and vehicle controls need verification on your actual iPhone/car. An exported audiobook can be added to Apple Books on Mac and synced to iPhone for its Audiobooks CarPlay interface.
- **ORP alignment.** The ORP letter is drawn in the accent colour and centred exactly on the crosshair. Letters before it extend left and letters after it extend right, with trailing punctuation included. Very long words shrink so they fit.
- **ORP table** (based on the letter count, ignoring punctuation): 0–1 letters → index 0, 2–5 → 1, 6–9 → 2, 10–13 → 3, more than 13 → 4. A leading quote or bracket is skipped so the ORP always lands on a letter.
- **Timing.** `baseInterval = 60000 / WPM`. Words get extra time as follows (multipliers are in `TIMING` in `js/text.js`):
  - sentence end (`.` `!` `?`): 2×
  - clause end (`,` `;` `:`): 1.5×
  - paragraph end: 2.5×
  - words longer than 10 letters: an extra 1.3×
- **Controls.** Play/pause, back or forward 10 words, a timeline scrubber, and a WPM slider (100–1000). While paused, the current sentence is shown for context.
- **Reading view.** While playing, everything except the word and its guide lines fades out, and the layout doesn't shift. Tap anywhere to pause and bring the controls back.
- **Keyboard.** Space plays and pauses, ←/→ jump 10 words, ↑/↓ change speed.
- **Device read aloud.** Uses the Web Speech API and installed voices. Download Enhanced/Premium voices in device accessibility settings for better quality. The voice drives highlights through word-boundary events; browsers without boundaries use an estimate. Narration speed (0.5–3×) is separate from silent RSVP speed (100–1000 WPM). The reader requests the playback audio session on supported Safari versions; background reliability varies, so use prepared audio for longer listening.
- **Import sources:**
  - pasted text
  - `.txt`, `.md` and `.html` files
  - ePub files without DRM
  - PDFs with a text layer, plus optional on-device English OCR for scanned pages
  - saved `.readalong` audio packages
  - web pages, via the bookmarklet
- **Persistence.** Preferences are kept in localStorage; documents, chapter/page locations, positions, and audio are in IndexedDB. Re-importing unchanged text resumes it. Changed article content resets progress and invalidates its old audio. Nothing syncs automatically between devices.

PDF layouts are extracted heuristically; complex columns/tables and OCR can need correction. EPUB DRM is unsupported. Website imports use the bookmarklet or pasted text instead of a public scraping proxy. See [import behavior and limitations](docs/IMPORTS.md).

## The Speed Read bookmarklet

The bookmarklet copies the page as you currently see it, so pages you're logged into and paywalled articles you can access both work. It opens the reader in a new tab and hands the page over with `postMessage`. The reader then extracts the article with [Mozilla Readability](https://github.com/mozilla/readability), which takes the same approach as Safari Reader.

Some sites block the hand-off to other tabs (for example with a strict `Cross-Origin-Opener-Policy`). On those sites the bookmarklet shows a banner with a **Copy article text** button. Paste the text into the reader with **Import › Paste from clipboard**.

To install it, open the reader, tap **+** (Import), and follow the instructions under **From a webpage**.

On iPhone and iPad, a Home Screen web app has separate storage from Safari. Use the reader in a Safari tab so bookmarklet imports and your library stay in one place.

## Add a "Speed read" button to your own site

Add these two lines to your article template:

```html
<script src="https://reader.sajanacharya.com/embed.js" defer></script>
<button type="button" data-speed-read>Speed read this article</button>
```

The older address `https://sajanac.github.io/speed-reader/embed.js` also works: GitHub Pages forwards it to the custom domain, and the hand-off accepts the reader tab even when its address has been forwarded.

Clicking the button opens the reader in a new tab with the article loaded. The script reads the element marked `data-speed-read-content`, or else the page's `<article>`, or else `<main>`. To leave something out (a newsletter box or related links, for example), add `data-speed-read-skip` to it. Buttons, forms, navigation and scripts inside the article are skipped automatically.

## Run locally

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

The app uses ES modules, so it has to be served over HTTP. Opening `index.html` directly from disk won't work.

## Tests

```sh
npm test                      # unit tests (ORP, tokenizer, timing, bookmarklet syntax)
npm install && npm run test:e2e   # browser tests (needs a Chromium; set CHROMIUM_PATH)
npm run test:experience        # immersive, imports, selection, audio, system controls
```

## Deploy to GitHub Pages

Go to Settings › Pages, choose **Deploy from a branch**, and select `main` / `(root)`.

The reader is served at `reader.sajanacharya.com`. That needs a DNS `CNAME` record for `reader` pointing to `sajanac.github.io`, and `reader.sajanacharya.com` entered as the custom domain under Settings › Pages. GitHub stores the custom domain in a `CNAME` file in the repo.

The **← Blog** link in the top bar is set in `index.html` (`.home-link`).

## Third-party code (in `vendor/`)

- [Mozilla Readability](https://github.com/mozilla/readability) 0.6.0: Apache-2.0
- [JSZip](https://github.com/Stuk/jszip) 3.10.2: MIT or GPLv3 (dual-licensed)
- [PDF.js](https://github.com/mozilla/pdf.js) 6.3.289 (legacy build): Apache-2.0
