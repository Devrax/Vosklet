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

## 3) Capacitor flow for completed recordings

- Record user audio (`MediaRecorder`) or accept user-selected `File`.
- Decode with `AudioContext.decodeAudioData`.
- Feed mono Float32 PCM to `recognizer.acceptWaveform()` in ordered chunks.
- Call `recognizer.finalResult()` after the last chunk to flush final text.

See [Examples/fromRecordingBatch.html](Examples/fromRecordingBatch.html) for a minimal implementation.

## Tradeoffs and limitations

- Single-thread mode is generally slower than threaded mode.
- Run recognition in a dedicated regular Web Worker when practical, to avoid UI stalls.
- CI cannot validate Android WebView runtime behavior directly; validate on target devices/emulators.
