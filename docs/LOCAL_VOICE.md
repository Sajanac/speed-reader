# Natural voices with no paid TTS API

The reader has two opt-in natural voice engines. Device speech remains a lightweight fallback. Neither natural engine requires a paid TTS account. Their speech quality varies with the voice and text; ElevenLabs-equivalent expressiveness is not promised.

## Browser voice

Choose a browser natural voice and Prepare. The reader downloads Kokoro only when you request preparation. The pinned runtime is [`kokoro-js@1.2.1`](https://github.com/hexgrad/kokoro/tree/main/kokoro.js), loaded into a worker from jsDelivr. Its WASM runtime assets are pinned to `@huggingface/transformers@3.5.1`. The `onnx-community/Kokoro-82M-v1.0-ONNX` q8 model is about **92.4 MB**, plus runtime and voice assets. The model is obtained from Hugging Face and may be retained in browser cache; clearing browser data or storage eviction can cause another download. The app does not send your article text to a TTS server during browser generation. The asset hosts receive normal download requests.

The present browser adapter uses English voices and WASM on the CPU. A separate worker keeps the page responsive. Long documents take time and use memory, battery, and storage; prepare a passage or chapter first. Cancel terminates its inference worker. Speech already prepared as audio plays without model inference.

Kokoro.js supplies sentence audio, not word timestamps. Browser narration highlights the currently playing sentence. It does not pretend that estimated word positions are exact. To read an exact selected passage, prepare that selection. The adapter rejects oversized/truncated synthesis chunks.

If downloading the model fails, keep using device voices or the local API. This runtime and model have not been bundled in the repository, so a first download needs internet access. Browser natural narration does not use an online no-key Edge endpoint.

## Local Kokoro API (word highlights)

For personal use, [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) provides natural speech and word captions on your own computer. Preparing audio before driving avoids depending on a running home computer. The reader calls its captioned endpoint and matches timing tokens to the original document; if timing tokens are missing or do not match, the app falls back to sentence highlighting. It never guesses that mismatched timing metadata is accurate.

Caption end times initially estimate each local clip's duration. The audio element replaces that estimate with its decoded media duration when the clip loads. When the service returns no usable timestamps, preparation reads the audio metadata before returning the clip. This keeps chapter timing and skip controls usable; initial caption-based total duration may differ slightly from the complete decoded audio.

Install and start Kokoro separately after reviewing its repository. This project does not automatically install models or run a third-party TTS service. CPU mode works without buying a GPU. For a Mac with Docker already installed, the published release can be started on **loopback only**:

```sh
docker run --rm -p 127.0.0.1:8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:v0.9.0
```

That command downloads a substantial image and model. Apple Silicon can alternatively use the upstream native MPS instructions. Check upstream release notes before upgrading, and keep a tested release pinned.

Run the included standard-library helper from the reader folder:

```sh
python3 tools/local-voice/serve.py
```

Open **http://127.0.0.1:8000/**. Choose Local API with endpoint **`/local-voice`**, choose the voice, and Prepare. This serves the reader and proxies its single captioned route to `127.0.0.1:8880`; it avoids mixed-content and cross-origin problems. It does not expose the service to your Wi-Fi network or the internet, and it does not proxy arbitrary URLs or backend debug routes. Other websites cannot submit voice requests through the helper. Stop the helper with Control-C. `--port` and `--voice-port` change local port numbers, never the loopback binding.

An ordinary static server or the published website does not provide `/local-voice`. A direct local API address also needs the upstream server's CORS policy to permit your page. A direct external service must use HTTPS and an access token; it requires a deliberate authenticated deployment. A computer's `localhost` is not the same endpoint as an iPhone's `localhost`.

## Transfer prepared audio to the phone

The transfer package contains the original text, narration chunks, timings, voice details, and embedded audio. It uses the `reader-audio-package` version 1 JSON format. Export a prepared passage/chapter and import the downloaded package on your phone. The package carries private document text and audio, so share it only with the intended recipient. No model/API connection is required to play an imported package.

Packages can be large because audio is embedded as base64. The importer caps a file at 150 MB; use chapter-sized exports for long books. Import rejects remote audio references and validates timing/index ranges. Browser storage and file retention are separate: keep exported files if you need durable copies. The app's media controls can drive prepared audio; phone/background/car behavior must still be checked on the actual phone and car.

## Module contract

`prepareNaturalVoice({doc,text,engine:'browser'|'local',voice,endpoint:'/local-voice',token,signal,onProgress,from?,to?})` returns a version 1 manifest. `from` is inclusive and `to` is exclusive, in the document's token indices. `onProgress` receives model download or generation progress. Audio objects are `Blob`s suitable for IndexedDB.

`NativeAudioNarrator({onWord,onState,onError,onProgress,audio?})` exposes `load(doc,text,manifest)`, `play`, `pause`, `toggle`, `seek(index)`, `skip(words)`, `skipSeconds(seconds)`, `setRate(0.5…3)`, `setRange(start,end)`, `cancelRange`, `reset`/`unload`, and `dispose`. `reset` clears a document while retaining event listeners for reuse; `dispose` also removes them. `onWord(index,{from,to,timing})` distinguishes real word timing from a whole sentence. `playing`, `index`, `currentTime`, `duration`, and `currentSpan` are available. The audio clock controls highlights; speed changes do not rewrite stored timestamps. An arbitrary word range cannot be cut from a sentence-timed chunk; prepare that selected passage instead.

`serializeAudioPackage(manifest,metadata)` asynchronously returns a JSON `Blob`. `importAudioPackage(fileOrJSON)` returns `{manifest,metadata,doc,text}` and validates it.

`exportNarrationAudio(manifest)` returns one playable audio `Blob`: browser PCM chunks become a single WAV with a corrected header; local MP3 chunks join in sequence after repeated ID3 tags are removed. Some MP3 players may estimate the joined file's duration or seek positions incorrectly. The transfer package preserves separate chunks and timing metadata for reliable reading in this app. Standalone WAV/MP3 files play in ordinary audio apps, but do not carry this app's text highlighting or bookmarks.

## Licenses and sources

Kokoro weights and Kokoro.js are Apache-2.0. Its phonemizer wrapper uses eSpeak NG, whose engine is GPL-3.0; a permissive model license does not change dependency obligations. Kokoro-FastAPI's wrapper is Apache-2.0 with MIT inference code and separately licensed dependencies. Check the exact runtime/binary licenses before distributing a bundled model/runtime.

- [Kokoro model card](https://huggingface.co/hexgrad/Kokoro-82M)
- [ONNX model files](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/tree/main/onnx)
- [Kokoro.js source and limitations](https://github.com/hexgrad/kokoro/blob/main/kokoro.js/src/kokoro.js)
- [Kokoro-FastAPI caption endpoint](https://github.com/remsky/Kokoro-FastAPI#captions)
- [Kokoro-FastAPI v0.9.0 release](https://github.com/remsky/Kokoro-FastAPI/releases/tag/v0.9.0)
- [Phonemizer.js](https://github.com/xenova/phonemizer.js)
- [eSpeak NG license](https://github.com/espeak-ng/espeak-ng/blob/master/COPYING)
