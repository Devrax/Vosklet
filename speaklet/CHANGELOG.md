# Changelog

All notable changes to **speaklet** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-07-17

### Added

- Optional enrollment-audio persistence: `enroll(audio, { persist: true })`
  keeps the enrollment WAV in Cache Storage (best-effort; embedding-only
  behavior stays the default). New `loadEnrollmentAudio(id?)` and
  `clearEnrollmentAudio(id?)` on both the verifier and the suite;
  `clearReference()` / `clearAllReferences()` also remove any persisted
  audio for the speakers they clear.

## [1.0.0] - 2026-07-17

First stable release.

### Added

- `createVoskletSpeaker()` suite: speech engine + Vosk model + speaker
  verifier + shared-AudioContext microphone capture in one object, with
  `record()`, `transcribe()`, `enroll()`, `verify()`, and `identify()`.
- Multi-speaker support: enroll any number of voices under stable ids (with
  optional display labels) through one verifier — one ONNX model instance
  serves all speakers. `identify()` answers who is talking with the full
  ranking; `verify()` runs the 1:1 check against a chosen id. References
  enrolled by pre-multi-speaker versions migrate to the `"default"` id
  automatically.
- À-la-carte exports: `startCapture()`, `createSpeakerVerifier()`,
  `encodeWav()`, `normalizeText()` / `textsMatch()` / `wordOverlap()`, and
  the bundled engine's `createVoskletMonoWorker()` / `supportsWorkerHost()`.

### Changed

- Self-contained package: the monosklet engine (worker host and
  single-thread Wasm runtime) is bundled into `dist/mono/` at build time —
  monosklet is no longer a dependency. The only dependencies are
  `onnxruntime-web` and `@jaehyun-ko/speaker-verification`, pinned to exact
  versions.
