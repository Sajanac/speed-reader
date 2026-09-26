# Speed Reader

An RSVP (Rapid Serial Visual Presentation) speed reader that runs in the browser. It shows one word at a time with the word's Optimal Recognition Point (ORP) fixed under a crosshair, so your eyes never move. It can also read the text aloud with your device's voices.

It's a static site with no build step and no server. Documents and progress are stored only in your browser.

## Features

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
- **Read aloud.** Uses the Web Speech API. In Safari that means the Apple voices installed on your device. The voice sets the pace: words advance on the voice's word-boundary events, and the WPM control sets the speaking rate (rate = WPM / 180). If the browser sends no word events, word timing is estimated instead. On iPhone the page asks for the "playback" audio session (`navigator.audioSession`, Safari 16.4+), so the ring/silent switch doesn't mute speech. Older iOS versions get the same effect by playing a moment of silence on the first tap.
- **Import sources:**
  - pasted text
  - `.txt`, `.md` and `.html` files
  - ePub files without DRM
  - PDFs with a text layer (scanned PDFs have no text to extract)
  - web pages, via the bookmarklet
- **Persistence.** WPM and appearance settings are kept in `localStorage`. Documents and reading positions are kept in IndexedDB. Re-importing the same page or text resumes where you left off.

## The Speed Read bookmarklet

The bookmarklet copies the page as you currently see it, so pages you're logged into and paywalled articles you can access both work. It opens the reader in a new tab and hands the page over with `postMessage`. The reader then extracts the article with [Mozilla Readability](https://github.com/mozilla/readability), which takes the same approach as Safari Reader.

Some sites block the hand-off to other tabs (for example with a strict `Cross-Origin-Opener-Policy`). On those sites the bookmarklet shows a banner with a **Copy article text** button. Paste the text into the reader with **Import › Paste from clipboard**.

To install it, open the reader, tap **+** (Import), and follow the instructions under **From a webpage**.

On iPhone and iPad, a Home Screen web app has separate storage from Safari. Use the reader in a Safari tab so bookmarklet imports and your library stay in one place.

## Run locally

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```

The app uses ES modules, so it has to be served over HTTP. Opening `index.html` directly from disk won't work.

## Tests

```sh
npm test                      # unit tests (ORP, tokenizer, timing, bookmarklet syntax)
npm install && npm run test:e2e   # browser tests (needs a Chromium; set CHROMIUM_PATH)
```

## Deploy to GitHub Pages

Go to Settings › Pages, choose **Deploy from a branch**, and select `main` / `(root)`.

## Third-party code (in `vendor/`)

- [Mozilla Readability](https://github.com/mozilla/readability) 0.6.0: Apache-2.0
- [JSZip](https://github.com/Stuk/jszip) 3.10.2: MIT or GPLv3 (dual-licensed)
- [PDF.js](https://github.com/mozilla/pdf.js) 6.3.289 (legacy build): Apache-2.0
