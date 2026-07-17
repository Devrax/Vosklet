# Changelog

All notable changes to **vosklet-mono** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.1] - 2026-07-17

Initial public release.

### Added

- `createVoskletMono()` engine factory wrapping the [Vosklet](https://github.com/msqr1/Vosklet) runtimes, with three runtime modes: `singlethread` (default), `threaded`, and `auto`.
- Slim `vosklet-mono/singlethread` entry point that ships only the single-thread runtime — no `SharedArrayBuffer` or COOP/COEP required, safe for Android WebView, Capacitor, and iOS WKWebView.
- On-demand model loading via `engine.loadModel({ url, id, storagePath })` from local assets or external URLs, with Cache Storage reuse across app launches.
- Batch `session.transcribe()` API with `onSegment`/`onProgress` callbacks and cooperative yielding (`yieldEveryBlocks`) to keep the WebView UI responsive.
- Streaming `session.createRecognizer()` API with `accept()`/`finish()`/`cancel()`, plus optional Vosk JSON `grammar` support in both APIs.
- `engine.createTransferer()` helper exposing Vosklet's `AudioWorklet` microphone PCM transferer.
- `supportsThreadedRuntime()` feature detection and `engine.module` escape hatch to the full upstream Vosklet API.
- Resource lifecycle management: `session.unload()` and `engine.dispose()`.
- Self-contained publish pipeline: Vite build vendors the Vosklet runtimes (loaders, Emscripten glue, and Wasm binaries) into `dist/`, so the package installs with zero dependencies.

[Unreleased]: https://github.com/Devrax/Vosklet/tree/main/vosklet-mono
[0.2.1]: https://github.com/Devrax/Vosklet/tree/main/vosklet-mono
