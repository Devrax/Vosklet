# vosklet-mono

Offline speech recognition that runs anywhere a browser or WebView runs — including Android WebView and Capacitor apps, where `SharedArrayBuffer` does not exist.

vosklet-mono is a small, framework-agnostic wrapper around [Vosklet](https://github.com/msqr1/Vosklet) by msqr1 (Vosk + Kaldi compiled to WebAssembly), consumed via the [Devrax/Vosklet](https://github.com/Devrax/Vosklet) fork that adapts it to WebView environments. It is **language-agnostic**: it loads any Vosk model you point it at — a local asset bundled with your app or an external URL — on demand.

## Why "mono"?

The name is literal, twice:

- **Mono-threaded.** The default runtime is Vosklet's single-thread build, which needs no `SharedArrayBuffer`, no COOP/COEP headers, and no cross-origin isolation — so it runs in environments the default threaded runtime cannot, Android WebView first among them.
- **Mono audio.** The recognition API consumes mono `Float32Array` PCM blocks; that is the entire audio contract between your app and the library.

Equally important is what the name does *not* claim:

- It is **not tied to any language**. You choose the Vosk model (Spanish, English, anything from the [Vosk model list](https://alphacephei.com/vosk/models)) per call, at runtime.
- It is **not an Android port of Vosk** — Vosk already has a native Android SDK, and Vosklet itself ships the single-thread runtime this library uses. vosklet-mono is the ergonomic layer on top: runtime selection, on-demand model loading with caching, a batch `transcribe()` API, and resource lifecycle management.

## Why this exists

Vosklet's default runtime uses Wasm threads, which require `SharedArrayBuffer` and cross-origin isolation (the `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers). **Android's System WebView does not support `SharedArrayBuffer`**, so the default runtime simply cannot start inside a Capacitor or WebView app.

This library wraps Vosklet's **single-thread runtime** by default — no special headers, no isolation — and adds:

- **On-demand model loading** from a local asset or an external URL, with Cache Storage reuse across app launches.
- **A batch `transcribe()` API**: your app captures the audio however it wants and hands the PCM to the library when recording ends. On a single thread this is the reliable pattern — recognize after capture, not during it.
- **Cooperative yielding** during recognition so the WebView UI does not freeze on long recordings.
- **A streaming recognizer** for browsers, and an opt-in switch to Vosklet's threaded runtime when you deploy somewhere that supports it.

## What vosklet-mono does *not* do

It does **not** capture audio. Your application owns the microphone: request permission, capture mono PCM (`Float32Array` samples in `-1.0..1.0`), decide when recording starts and stops, then pass the blocks to vosklet-mono. This keeps the library agnostic of UI, frameworks, and capture strategy. (A helper for Vosklet's `AudioWorklet` transferer is exposed for convenience — see below.)

## Install

```shell
npm install vosklet-mono
# or
pnpm add vosklet-mono
```

The published package is **self-contained**: the build pipeline bundles the [`Devrax/Vosklet`](https://github.com/Devrax/Vosklet) runtimes (minified loaders, Emscripten glue, and the Wasm binaries) into `dist/`, so installing `vosklet-mono` pulls in no other dependency.

### Building the package from source

This repository is a pnpm monorepo; `vosklet` is a `workspace:*` dev
dependency, so build the Vosklet Wasm runtimes at the repository root first
(see the root README), then from the repository root:

```shell
pnpm install
pnpm --filter vosklet-mono build          # Vite: bundles + minifies the wrapper, vendors the Vosklet runtime into dist/
pnpm --filter vosklet-mono pack:check     # list the tarball contents
pnpm --filter vosklet-mono exec npm pack  # → vosklet-mono-<version>.tgz
```

`npm pack` / `npm publish` run the build automatically through the `prepack` script, so the tarball always ships a fresh `dist/`.

## Quick start (Capacitor / Android WebView)

1. **Bundle a model** in your web assets, e.g. `public/models/es-small.tar` (Vosk models are downloadable from [alphacephei.com/vosk/models](https://alphacephei.com/vosk/models); repackage as USTAR TAR — see [Model requirements](#model-requirements)).
2. **Declare the microphone permission** in `android/app/src/main/AndroidManifest.xml`:

   ```xml
   <uses-permission android:name="android.permission.RECORD_AUDIO" />
   <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
   ```

3. **Load the engine and a model, capture audio, transcribe:**

```js
import { createVoskletMono } from "vosklet-mono/singlethread";

// 1. Load the engine. The /singlethread entry ships ONLY the single-thread
//    runtime: safe for Android WebView (no COOP/COEP, no SharedArrayBuffer)
//    and it keeps the threaded runtime's ~2.4 MB .wasm out of your app.
const engine = await createVoskletMono();

// 2. Load a model on demand — local asset here, but any URL works.
const spanish = await engine.loadModel({
  url: "/models/es-small.tar",        // local assets: always plain .tar — see the .gz warning below
  id: "vosk-model-small-es-0.42",     // cache key: bump it when the file changes
  storagePath: "Spanish"
});

// 3. YOUR app captures mono Float32Array PCM blocks (see next section)...
const { blocks, sampleRate } = await recordUntilUserStops();

// 4. ...and hands them to the library when recording ends.
const { text } = await spanish.transcribe(blocks, {
  sampleRate,
  onProgress: (fraction) => updateSpinner(fraction)
});

console.log("Recognized:", text);
```

The first `loadModel()` fetches and unpacks the archive; subsequent app launches reuse the copy in Cache Storage keyed by `storagePath` + `id`.

### Capturing microphone PCM

Any capture strategy that produces mono `Float32Array` blocks works. The simplest is an `AudioContext` plus Vosklet's `AudioWorklet` transferer, which the engine exposes:

```js
const audioContext = new AudioContext();
const stream = await navigator.mediaDevices.getUserMedia({
  audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
});

const source = audioContext.createMediaStreamSource(stream);
const transferer = await engine.createTransferer(audioContext, 128 * 15);

const blocks = [];
transferer.port.onmessage = (event) => blocks.push(event.data);
source.connect(transferer);

// ...later, when your app decides recording is over:
transferer.port.onmessage = null;
source.disconnect();
stream.getTracks().forEach((track) => track.stop());

const { text } = await spanish.transcribe(blocks, {
  sampleRate: audioContext.sampleRate
});
```

> **Why capture first, transcribe after?** The single-thread runtime recognizes on the UI thread. Feeding it live audio competes with capture and rendering. Recording first and batch-transcribing afterwards is the pattern verified on Android. `transcribe()` yields to the event loop every few blocks (configurable via `yieldEveryBlocks`) so progress UI stays responsive.

### Speech hooks: auto-stop on silence

Most voice UIs want to stop recording by themselves once the user finishes talking. `createSpeechMonitor()` packages that: feed it the same PCM blocks you are capturing and it detects speech, tracks silence, and hands you every captured block the moment the speaker has been quiet long enough:

```js
import { createVoskletMono, createSpeechMonitor } from "vosklet-mono/singlethread";

const monitor = createSpeechMonitor({
  speechThreshold: 0.015,   // RMS level a block must reach to count as speech
  stopAfterSpoken: 2_000,   // ms of silence AFTER speech before onAutoStop
  onSpeechStart: () => showListeningIndicator(),
  onSilence: (ms) => updateCountdown(ms),
  onAutoStop: async (blocks) => {
    stopMicrophone();       // your capture teardown
    const { text } = await spanish.transcribe(blocks, {
      sampleRate: audioContext.sampleRate
    });
    console.log("Recognized:", text);
  }
});

// Wire it where your capture produces blocks:
transferer.port.onmessage = (event) => monitor.push(event.data);

// A manual stop button is the same flow — stop() returns the blocks:
stopButton.onclick = () => {
  const blocks = monitor.stop();
  if (blocks.length) transcribeNow(blocks);
};
```

Behavior details:

- Silence **before** the user ever speaks never triggers the auto-stop — the countdown only starts after the first block crosses `speechThreshold`, and every new speech block resets it.
- After `onAutoStop` (or `stop()`), the monitor ignores further `push()` calls; call `reset()` to reuse it for the next recording.
- The blocks handed to `onAutoStop` include everything captured since monitoring began (pre-speech audio too), so the recognizer sees the full recording.
- Detection is **energy-based** (per-block RMS against a threshold), which works well for quiet rooms and challenge/command UIs. It is not a full VAD: in noisy environments, raise `speechThreshold` or supply your own detection and use `getRootMeanSquare()` as a building block.
- Pass `stopAfterSpoken: Infinity` to disable the auto-stop and keep only the accumulation + speech callbacks.
- The monitor is pure JS with no wasm or microphone access — your app still owns capture, exactly as before.

## Loading models on demand

`loadModel()` is how you tell vosklet-mono which model to use — per call, at runtime:

```js
// Local asset shipped with the app (offline-first):
const spanish = await engine.loadModel({
  url: "/models/es-small.tar",
  id: "vosk-model-small-es-0.42"
});

// External model fetched over the network (like original Vosklet).
// Remote URLs may use .tar.gz freely — the restriction below only applies
// to files bundled inside the Android app:
const spanishRemote = await engine.loadModel({
  url: "https://ccoreilly.github.io/vosk-browser/models/vosk-model-small-es-0.3.tar.gz",
  id: "vosk-model-small-es-0.3"
});

// Swap models: free the old one, load another.
spanish.unload();
```

- `url` — local path (resolved against the current page) or absolute external URL.
- `id` — **required.** Cache Storage key together with `storagePath`. Publishing new model content at the same URL? Change the `id`, or users keep the stale cached archive.
- `storagePath` — directory the archive expands to in the Wasm filesystem (default `"model"`). Use distinct paths for concurrently loaded models.

> ⚠️ **Never bundle a `.gz` / `.gzip` model inside the Android app — ship it as plain `.tar`.**
>
> If you put `public/models/es.tar.gz` in your web assets, the installed app will 404 when fetching that URL. This is not a Capacitor bug: Android's asset packager (`aapt`, which the Android Gradle Plugin still uses for `assets/`) has a legacy feature from early Android, when apps pre-gzipped assets to save space — any asset ending in `.gz` is **gunzipped at build time and stored with the `.gz` suffix stripped**, and `AssetManager` used to decompress such entries transparently. So your file effectively ships as `models/es.tar`, the original `es.tar.gz` path no longer exists inside the APK, and the WebView's fetch fails.
>
> Decompress the model before bundling (`gunzip es.tar.gz`) and reference the `.tar`. Uncompressed is also the better choice for bundled assets anyway: the APK/AAB is compressed as a whole, and Vosklet detects the format from the bytes, not the extension. Compressed `.tar.gz` remains perfectly fine for **remote** models fetched over HTTP, like the example above.

Models are memory-hungry; keep one loaded at a time on mobile and call `session.unload()` before loading another.

## Streaming recognition (browser / threaded)

When you want segment-by-segment results instead of one batch call:

```js
const recognizer = await spanish.createRecognizer({
  sampleRate: audioContext.sampleRate
});

for (const block of liveBlocks) {
  const segment = recognizer.accept(block);   // "" while mid-utterance
  if (segment) console.log("Segment:", segment);
}

const fullText = await recognizer.finish();   // flushes + frees the recognizer
```

A `grammar` option (Vosk JSON grammar string) is accepted by both `createRecognizer()` and `transcribe()` to constrain recognition to a phrase list — very effective for challenge/command UIs:

```js
const { text } = await spanish.transcribe(blocks, {
  sampleRate,
  grammar: JSON.stringify(["hola mundo", "adiós", "[unk]"])
});
```

## Choosing a runtime

The package has two entry points, and the choice controls your **bundle size**:

```js
// Slim entry: single-thread only. Bundlers include just one runtime, so the
// threaded .wasm (~2.4 MB) never enters your app. Use this for Capacitor,
// Android WebView, iOS, and any deployment without cross-origin isolation.
import { createVoskletMono } from "vosklet-mono/singlethread";
const engine = await createVoskletMono();

// Flexible entry: picks the runtime at run time, so bundlers must ship BOTH
// runtimes (~4.8 MB of .wasm). Use it only when one build genuinely serves
// isolated and non-isolated environments.
import { createVoskletMono } from "vosklet-mono";
const engine = await createVoskletMono({ runtime: "singlethread" }); // default
const engine = await createVoskletMono({ runtime: "threaded" });     // needs COOP/COEP + SharedArrayBuffer
const engine = await createVoskletMono({ runtime: "auto" });         // threaded when supported, else singlethread
```

Both entries export the same API; switching is a one-line import change. `runtime: "auto"` inherently requires the flexible entry — on-demand choice means shipping both runtimes.

| Runtime | Works in Android WebView / Capacitor | Requires COOP/COEP + `SharedArrayBuffer` | Speed |
| --- | --- | --- | --- |
| `singlethread` (default) | ✅ | No | Slower; batch-transcribe after capture |
| `threaded` | ❌ | Yes | Faster; suitable for live streaming |

Notes:

- `supportsThreadedRuntime()` is exported if you want to feature-detect yourself.
- **One runtime per page.** Both runtimes register the same global loader, so `createVoskletMono()` throws if you request a different runtime after one is already loaded. Calling it again with the same runtime reuses the loaded module.
- **iOS / WKWebView:** WebKit *does* implement `SharedArrayBuffer` (Safari 15.2+), but only in cross-origin-isolated contexts — the same COOP/COEP requirement as Chrome. A Capacitor app is served from `capacitor://localhost` through a custom scheme handler where those headers don't apply, so `crossOriginIsolated` stays `false` and `SharedArrayBuffer` is **not exposed** in practice. The default single-thread runtime is the right choice on iOS too, and `runtime: "auto"` resolves it correctly there. (The `.gz` asset warning above is Android-only; iOS does not rewrite bundled assets.)
- The single-thread path is the one verified end-to-end on Android by this project. The threaded path is wired through but has not been battle-tested here — treat it as upstream Vosklet behavior.

## Running recognition in a Web Worker

The single-thread runtime's one drawback is that it recognizes **on the UI thread**. The `vosklet-mono/worker` entry removes it: the same runtime boots inside a dedicated Web Worker, and the whole API is proxied to it over `postMessage`. Dedicated workers need **no SharedArrayBuffer, COOP, or COEP** — they work in Android WebView, Capacitor, and iOS WKWebView, exactly like the main-thread engine.

```js
import { createVoskletMonoWorker } from "vosklet-mono/worker";

const engine = await createVoskletMonoWorker();

const spanish = await engine.loadModel({
  url: "/models/es-small.tar",
  id: "vosk-model-small-es-0.42",
  storagePath: "Spanish"
});

// Same API shape as createVoskletMono() — but recognition happens in the
// worker, so the page never freezes and no cooperative yielding is needed:
const { text } = await spanish.transcribe(blocks, {
  sampleRate,
  onProgress: (fraction) => updateSpinner(fraction)
});

await engine.dispose(); // frees everything and terminates the worker
```

What changes compared to the main-thread engine:

- **The UI thread stays free.** No `yieldEveryBlocks`, no jank during long transcriptions — the worker recognizes at full speed while the page renders normally.
- **Live streaming becomes viable.** `createRecognizer()` works over the RPC bridge; because recognition happens in the worker, `accept()` is **asynchronous** (`await recognizer.accept(block)`) — that is the one API difference.
- **Block buffers are transferred, not copied** (zero-copy). After `transcribe(blocks)` the arrays are neutered on the main thread; pass `transfer: false` if you need to keep them.
- **Capture stays on the main thread.** Workers have no `AudioContext`, so `engine.createTransferer()` runs the AudioWorklet locally and you `postMessage` nothing yourself — wire it to `monitor.push()` or `transcribe()` as usual.
- `engine.host` is `"worker"`; the runtime is always `"singlethread"` (the threaded runtime manages its own workers and needs cross-origin isolation — pointless to nest).
- `dispose()` also terminates the worker; `terminate()` hard-stops it without cleanup.
- **Native speaker identification is available.** `engine.loadSpkModel({ url, id, storagePath? })` loads a Vosk speaker model (e.g. [vosk-model-spk-0.4](https://alphacephei.com/vosk/models), language-independent, same USTAR TAR packaging as speech models); pass the session as `speakerModel` to `transcribe()` or `createRecognizer()` and results gain `speakerVectors` — one `{ vector, frames }` x-vector per completed utterance. Compare enrolled and probe embeddings (e.g. cosine similarity, frames-weighted average across utterances) to identify the speaker. Cannot be combined with `grammar`.

  The x-vector extractor is compiled into the Wasm runtime the engine already runs, so this is the lightest way to add speaker identification: no onnxruntime-web, no extra JS — just the ~13 MB `vosk-model-spk-0.4` archive next to your speech model. The [`vosklet-speaker`](../vosklet-speaker) toolkit remains the higher-level option (a newer NeXt-TDNN embedding model, plus a ready-made enrollment/verification API) at the cost of bundling an ONNX runtime. As a starting point for the raw x-vectors, treat a frames-weighted cosine similarity of **0.75 or higher** as the same speaker — Vosk's classic ~0.45 cutoff proved too lenient in our testing — and tune the threshold against real recordings from your deployment.

Bundler notes: the entry ships the literal `new Worker(new URL("./worker.js", import.meta.url))` and `new URL("./runtime/...", import.meta.url)` patterns, which Vite and webpack 5 detect and bundle automatically. For setups that don't, `createVoskletMonoWorker({ workerUrl, glueUrl, wasmUrl })` overrides the URL resolution. The worker script is a classic worker (not a module worker), so it runs in every WebView that has workers at all.

## Model requirements

- The model must be a **USTAR TAR** archive: `.tar`, `.tar.gz`, or `.tgz`. Format detection uses the bytes, not the file extension.
- Model files must sit directly below the archive's model root.
- Serve model bytes as `application/octet-stream` where possible.
- Do **not** serve a gzip-compressed model with `Content-Encoding: gzip` — Vosklet needs the original gzip bytes to decode the archive itself.
- Official models: [alphacephei.com/vosk/models](https://alphacephei.com/vosk/models). They ship as `.zip`; repackage, e.g.:

  ```shell
  unzip vosk-model-small-es-0.42.zip
  cd vosk-model-small-es-0.42
  tar --format=ustar -cf ../es-small.tar .
  ```

## Android / Capacitor checklist

- [ ] Model archive in your web assets (e.g. `public/models/`) so Capacitor copies it into the app — fully offline recognition.
- [ ] Bundled model named `*.tar`, **never** `*.tar.gz` — `aapt` strips `.gz` assets at build time and the fetch 404s (see the warning in [Loading models on demand](#loading-models-on-demand)).
- [ ] `RECORD_AUDIO` (and typically `MODIFY_AUDIO_SETTINGS`) in the Android manifest, plus a runtime permission request before `getUserMedia`.
- [ ] Import from `vosklet-mono/singlethread` — single-thread is the only runtime a WebView can run, and the slim entry keeps the threaded `.wasm` (~2.4 MB) out of the APK/IPA.
- [ ] Capture first, `transcribe()` after recording ends; drive a progress indicator from `onProgress`.
- [ ] Free resources: recognizers via `finish()`/`cancel()`, models via `unload()`, everything via `engine.dispose()`.
- [ ] Debug with Chrome remote inspection (`chrome://inspect`) while the app runs on a device.

A complete working example — a Spanish voice-challenge Capacitor app using this exact flow — lives in the parent repository under [`Examples/demo/`](https://github.com/Devrax/Vosklet/tree/main/Examples/demo): its home page routes to a main-thread version, a Web Worker version of the same challenge, a speaker-verification variant, and a native x-vector speaker-identification variant built on `loadSpkModel()`.

## API summary

| Member | Description |
| --- | --- |
| `createVoskletMono(options?)` | Loads a Vosklet runtime, returns the engine. Options: `runtime`, `logLevel`, `moduleArg`. Also exported by `vosklet-mono/singlethread` (single-thread only, slimmer bundle). |
| `supportsThreadedRuntime()` | `true` when the threaded runtime can run here. |
| `createSpeechMonitor(options?)` | Energy-based speech monitor: `push(block)` accumulates PCM and fires `onSpeechStart` / `onSpeech` / `onSilence` / `onAutoStop`; `stop()` returns the blocks, `reset()` reuses it. |
| `createVoskletMonoWorker(options?)` | From `vosklet-mono/worker`: boots the single-thread runtime inside a dedicated Web Worker (no SharedArrayBuffer/COOP/COEP) and returns the same engine API — recognition off the UI thread. |
| `supportsWorkerHost()` | From `vosklet-mono/worker`: `true` when Web Workers are available. |
| `engine.loadSpkModel({ url, id, storagePath? })` | Worker engine only: loads a Vosk speaker-identification model; pass the returned session as `speakerModel` to `transcribe()`/`createRecognizer()` for per-utterance x-vectors (`speakerVectors`). |
| `getRootMeanSquare(samples)` | RMS (0..1) of one PCM block — for level meters or custom detection. |
| `engine.loadModel({ url, id, storagePath? })` | Loads a model from a local or external URL; returns a `ModelSession`. |
| `engine.createTransferer(audioContext, bufferSize?)` | Vosklet `AudioWorklet` node for microphone PCM capture. |
| `engine.module` | The raw Vosklet module (escape hatch to the full upstream API). |
| `engine.dispose()` | Frees all models and recognizers. |
| `session.transcribe(pcm, { sampleRate, grammar?, onSegment?, onProgress?, yieldEveryBlocks? })` | Batch-recognizes captured PCM; resolves `{ text, segments }`. |
| `session.createRecognizer({ sampleRate, grammar? })` | Streaming recognizer: `accept(block)`, `finish()`, `cancel()`. |
| `session.unload()` | Frees the native model memory (cached archive is kept). |

Full type definitions are in [`index.d.ts`](index.d.ts). Everything not wrapped here (endpointer tuning, NLSML, word-level results, speaker models on the main-thread engine) remains reachable through `engine.module` and `recognizer.raw` — see the runtime's type declarations ([`Vosklet.d.ts`](../Vosklet.d.ts), vendored into the package as `dist/runtime/Vosklet.d.ts`).

## License

[MIT](LICENSE), same as Vosklet itself. The vendored Wasm runtime compiles in Vosk, Kaldi, and OpenFST (Apache 2.0) and OpenBLAS (BSD 3-Clause) — all permissive; attribution is preserved in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), which ships inside the npm package.

Vosk models carry their own licenses — check the model page before shipping one.
