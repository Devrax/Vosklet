# Android WebView / Capacitor usage

This guide covers the non-`SharedArrayBuffer` fallback mode for Android WebView and Capacitor apps.

## 1) Build a single-threaded artifact

```bash
cd src
VOSKLET_MODE=singlethread OUTPUT_BASENAME=Vosklet.single ./make
```

This produces `Vosklet.single.js` and `Vosklet.single.wasm` without `-sWASM_WORKERS` and without `-matomics`.

## 2) Host model bytes with an extensionless path

For `WebViewAssetLoader` (or equivalent), expose a neutral URL like:

`https://appassets.androidplatform.net/models/en-small`

Serve content as:

- `Content-Type: application/octet-stream`
- **No** `Content-Encoding: gzip` when JS wrapper should run `DecompressionStream('gzip')`

The wrapper detects model format from bytes, so extensionless URLs are supported.

## 3) Capacitor microphone flow

Android WebView can record `audio/webm;codecs=opus` with `MediaRecorder`, but it may not decode that format through `AudioContext.decodeAudioData`. For a live microphone, capture PCM directly instead:

- Create or resume an `AudioContext` from the user gesture.
- Connect `createMediaStreamSource()` to `module.createTransferer(context, 128 * 15)`.
- Store each `transferer.port.onmessage` `Float32Array` while recording, then pass the blocks to `recognizer.acceptWaveform()` after the user selects Stop.
- On Stop, disconnect the microphone node, stop its tracks, call `recognizer.finalResult()`, and release the recognizer.

This keeps the audio in mono Float32 PCM and avoids a browser-specific WebM/Opus decoder. See [Examples/fromMic.html](Examples/fromMic.html) for the transferer setup. Use `decodeAudioData()` only for imported audio files whose format the browser supports.

## Tradeoffs and limitations

- Single-thread mode is generally slower than threaded mode.
- Run recognition in a dedicated regular Web Worker when practical, to avoid UI stalls.
- CI cannot validate Android WebView runtime behavior directly; validate on target devices/emulators.
