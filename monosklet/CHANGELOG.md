# Changelog

All notable changes to **monosklet** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-07-17

First stable release. The API surface (`monosklet`,
`monosklet/singlethread`, `monosklet/worker`) is now considered stable
and covered by semantic versioning.

### Added

- Native Vosk speaker identification in the worker engine: `engine.loadSpkModel({ url, id, storagePath })` loads a speaker model archive (e.g. [vosk-model-spk-0.4](https://alphacephei.com/vosk/models)) through the same USTAR TAR pipeline as `loadModel()`, and the returned session is passed as `speakerModel` to `session.transcribe()` or `session.createRecognizer()`. Results then carry `speakerVectors` — one `{ vector, frames }` x-vector per completed utterance — for speaker identification/verification by embedding comparison. `speakerModel` cannot be combined with `grammar` (the underlying runtime supports one or the other per recognizer).

### Fixed

- `grammar` support was broken in both engines: the runtime's `createRecognizerWithGrm(model, sampleRate, grammar)` was being called with `grammar` and `sampleRate` swapped.

## [0.4.0] - 2026-07-17

### Added

- `monosklet/worker` entry with `createVoskletMonoWorker()`: boots the single-thread runtime inside a dedicated Web Worker and proxies the engine API over `postMessage`, keeping recognition off the UI thread. Dedicated workers need no `SharedArrayBuffer`, COOP, or COEP, so this works in Android WebView, Capacitor, and iOS WKWebView. Same API shape as `createVoskletMono()` with three differences: streaming `accept()` is asynchronous, block buffers are transferred to the worker by default (`transfer: false` copies instead), and `dispose()` also terminates the worker. `createTransferer()` still runs on the main thread (workers have no `AudioContext`). `supportsWorkerHost()` is exported for feature detection.
- The vendored Vosklet runtimes now install their API in worker scopes as well (upstream wrapper gate widened from `ENVIRONMENT_IS_WEB` to include `ENVIRONMENT_IS_WORKER`).

## [0.3.0] - 2026-07-17

### Added

- `createSpeechMonitor()`: an energy-based speech monitor that turns captured PCM blocks into speech hooks. Feed it blocks with `push()`; it accumulates them, fires `onSpeechStart`/`onSpeech` when the RMS crosses `speechThreshold`, `onSilence` with the elapsed quiet time, and `onAutoStop` with every captured block once the speaker has been silent for `stopAfterSpoken` milliseconds (default 2000; pass `Infinity` to disable). `stop()` is the manual counterpart and `reset()` reuses the monitor for the next recording. Detection is energy-based (RMS threshold), suited to quiet environments — tune `speechThreshold` for noisier ones.
- `getRootMeanSquare()`: the monitor's RMS measure, exported for level meters and custom detection.

## [0.2.1] - 2026-07-17

Initial public release.

### Added

- `createVoskletMono()` engine factory wrapping the [Vosklet](https://github.com/msqr1/Vosklet) runtimes, with three runtime modes: `singlethread` (default), `threaded`, and `auto`.
- Slim `monosklet/singlethread` entry point that ships only the single-thread runtime — no `SharedArrayBuffer` or COOP/COEP required, safe for Android WebView, Capacitor, and iOS WKWebView.
- On-demand model loading via `engine.loadModel({ url, id, storagePath })` from local assets or external URLs, with Cache Storage reuse across app launches.
- Batch `session.transcribe()` API with `onSegment`/`onProgress` callbacks and cooperative yielding (`yieldEveryBlocks`) to keep the WebView UI responsive.
- Streaming `session.createRecognizer()` API with `accept()`/`finish()`/`cancel()`, plus optional Vosk JSON `grammar` support in both APIs.
- `engine.createTransferer()` helper exposing Vosklet's `AudioWorklet` microphone PCM transferer.
- `supportsThreadedRuntime()` feature detection and `engine.module` escape hatch to the full upstream Vosklet API.
- Resource lifecycle management: `session.unload()` and `engine.dispose()`.
- Self-contained publish pipeline: Vite build vendors the Vosklet runtimes (loaders, Emscripten glue, and Wasm binaries) into `dist/`, so the package installs with zero dependencies.

[Unreleased]: https://github.com/Devrax/Vosklet/tree/main/monosklet
[0.4.0]: https://github.com/Devrax/Vosklet/tree/main/monosklet
[0.3.0]: https://github.com/Devrax/Vosklet/tree/main/monosklet
[0.2.1]: https://github.com/Devrax/Vosklet/tree/main/monosklet
