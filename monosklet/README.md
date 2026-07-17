# monosklet

Offline speech recognition for browsers, WebViews, and Capacitor applications.
It loads local or remote Vosk models on demand, caches them between launches,
accepts mono PCM audio, and exposes batch and streaming recognition APIs.

**monosklet is built directly on
[Vosklet](https://github.com/msqr1/Vosklet).** It is the higher-level npm
wrapper maintained in the [Devrax/Vosklet](https://github.com/Devrax/Vosklet)
fork—not a separate speech engine. The package vendors Vosklet's Vosk + Kaldi
WebAssembly runtime and adds model lifecycle, caching, worker hosting, and an
application-oriented API.

## Install

```sh
npm install monosklet
# or
pnpm add monosklet
```

The npm package includes the Vosklet runtime and Wasm binaries. A speech model
is not included; your application chooses and hosts one.

## Choose an entry point

| Import | Use it when | Recognition thread |
| --- | --- | --- |
| `monosklet/worker` | Recommended for browser, Android WebView, Capacitor, and WKWebView applications | Dedicated Web Worker |
| `monosklet/singlethread` | You cannot use Web Workers or want direct main-thread control | Main/UI thread |
| `monosklet` | One web build must choose between Vosklet's single-thread and threaded runtimes at run time | Main/UI thread |

For most applications, start with `monosklet/worker`. It uses Vosklet's
single-thread runtime inside a dedicated worker, so it requires no
`SharedArrayBuffer`, COOP/COEP headers, or cross-origin isolation and does not
block the page while recognizing.

The `/singlethread` and root entries expose `createSpeechMonitor()` and
`getRootMeanSquare()`. These helpers are pure JavaScript and can be used with a
worker engine, as shown in the microphone example below.

## Quick start

If your application already captures mono `Float32Array` PCM blocks, the
complete recognition flow is:

```js
import { createVoskletMonoWorker } from "monosklet/worker";

const engine = await createVoskletMonoWorker();

const model = await engine.loadModel({
  url: "/models/es-small.tar",
  id: "vosk-model-small-es-0.42",
  storagePath: "Spanish"
});

// `blocks` is a Float32Array[] containing mono samples in -1.0..1.0.
const { text, segments } = await model.transcribe(blocks, {
  sampleRate,
  onProgress: (fraction) => {
    console.log(`Recognizing ${Math.round(fraction * 100)}%`);
  }
});

console.log(text, segments);

model.unload();
await engine.dispose();
```

The first `loadModel()` downloads and unpacks the archive. Later launches reuse
the cached model identified by `storagePath` + `id`. Change `id` whenever the
contents at the same URL change.

## Complete microphone example

monosklet deliberately does not own microphone permissions or UI. The engine
does expose Vosklet's AudioWorklet transferer, and `createSpeechMonitor()` can
collect blocks and stop after the user becomes silent:

```js
import { createSpeechMonitor } from "monosklet/singlethread";
import { createVoskletMonoWorker } from "monosklet/worker";

const engine = await createVoskletMonoWorker();
const model = await engine.loadModel({
  url: "/models/es-small.tar",
  id: "vosk-model-small-es-0.42"
});

async function recordOneUtterance() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true
    }
  });

  const audioContext = new AudioContext();
  await audioContext.resume();

  const source = audioContext.createMediaStreamSource(stream);
  const transferer = await engine.createTransferer(audioContext, 128 * 15);

  return new Promise((resolve) => {
    const finish = (blocks) => {
      transferer.port.onmessage = null;
      source.disconnect();
      transferer.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      void audioContext.close();
      resolve({ blocks, sampleRate: audioContext.sampleRate });
    };

    const monitor = createSpeechMonitor({
      speechThreshold: 0.015,
      stopAfterSpoken: 2_000,
      onSpeechStart: () => console.log("Speech detected"),
      onSilence: (milliseconds) => console.log("Silent for", milliseconds),
      onAutoStop: (blocks) => finish(blocks)
    });

    transferer.port.onmessage = (event) => monitor.push(event.data);
    source.connect(transferer);

    // A stop button can call: finish(monitor.stop())
  });
}

const recording = await recordOneUtterance();
const { text } = await model.transcribe(recording.blocks, {
  sampleRate: recording.sampleRate
});

console.log("Recognized:", text);
await engine.dispose();
```

`createSpeechMonitor()` uses an RMS threshold, not a full voice-activity
detector. Tune `speechThreshold` for the microphones and noise conditions in
your deployment. Silence before the user first speaks does not trigger
auto-stop. After `stop()` or `onAutoStop`, call `reset()` before reusing the
monitor.

The repository contains production-shaped implementations with cancellation,
timeouts, progress UI, and error handling:

- [`Examples/demo/src/worker.js`](https://github.com/Devrax/Vosklet/blob/main/Examples/demo/src/worker.js)—worker recognition and microphone capture.
- [`Examples/demo/src/challenge.js`](https://github.com/Devrax/Vosklet/blob/main/Examples/demo/src/challenge.js)—main-thread recognition.
- [`Examples/demo/src/spk.js`](https://github.com/Devrax/Vosklet/blob/main/Examples/demo/src/spk.js)—native Vosk speaker x-vectors.

## Models

### Load local or remote models

```js
// Local asset bundled with an offline application.
const local = await engine.loadModel({
  url: "/models/es-small.tar",
  id: "vosk-model-small-es-0.42"
});

// Model hosted elsewhere and cached after the first download.
const remote = await engine.loadModel({
  url: "https://cdn.example.com/vosk-model-small-es-0.42.tar.gz",
  id: "vosk-model-small-es-0.42-remote",
  storagePath: "SpanishRemote"
});
```

`url` may be page-relative or absolute. `id` is required and acts as a cache
version. `storagePath` defaults to `"model"`; use distinct paths for models
that are loaded concurrently. Mobile devices have limited memory, so unload
models that are no longer needed.

### Package a Vosk model

monosklet consumes a USTAR TAR archive: `.tar`, `.tar.gz`, or `.tgz`. Official
models from [alphacephei.com/vosk/models](https://alphacephei.com/vosk/models)
are distributed as ZIP archives and can be repackaged once:

```sh
unzip vosk-model-small-es-0.42.zip
cd vosk-model-small-es-0.42
tar --format=ustar -cf ../es-small.tar .
```

Model files must sit directly below the archive's model root. Serve the archive
as `application/octet-stream` where possible. Do not apply HTTP
`Content-Encoding: gzip` to an already gzip-compressed model; Vosklet needs the
original gzip bytes.

For Android application assets, use plain `.tar`. Android's asset packager may
rewrite files ending in `.gz`, causing the original URL to return 404 inside
the installed application. Remote HTTP models may still use `.tar.gz`.

## Common recipes

### Constrain recognition with a grammar

Both `transcribe()` and `createRecognizer()` accept a Vosk JSON grammar:

```js
const { text } = await model.transcribe(blocks, {
  sampleRate,
  grammar: JSON.stringify(["hola mundo", "adiós", "[unk]"])
});
```

### Stream audio blocks

```js
const recognizer = await model.createRecognizer({ sampleRate });

for (const block of liveBlocks) {
  // Worker recognizers are asynchronous.
  const segment = await recognizer.accept(block);
  if (segment) console.log("Segment:", segment);
}

const text = await recognizer.finish(); // flushes and frees the recognizer
```

With a main-thread engine, `accept(block)` returns the segment synchronously.
With a worker engine, it returns a promise. Call `cancel()` instead of
`finish()` when the recording should be discarded.

Worker calls transfer block buffers by default. After `transcribe(blocks)`, the
original arrays are no longer usable. Pass `transfer: false` to copy them
instead.

### Native speaker identification with Vosk x-vectors

The worker engine can load a Vosk speaker model and return raw speaker
embeddings:

```js
const speakerModel = await engine.loadSpkModel({
  url: "/models/spk-0.4.tar",
  id: "vosk-model-spk-0.4",
  storagePath: "SpeakerXVector"
});

const { text, speakerVectors } = await model.transcribe(blocks, {
  sampleRate,
  speakerModel
});
```

`speakerVectors` contains one `{ vector, frames }` value per completed
utterance. A `speakerModel` cannot be combined with `grammar`.

These are raw Vosk x-vectors: your application must average utterances, store
reference embeddings, compare them, and choose a threshold. The demo uses a
frames-weighted average and cosine similarity:

<details>
<summary>Frames-weighted averaging and cosine comparison</summary>

```js
function averageXVector(segments) {
  if (!segments.length) return undefined;

  const average = new Array(segments[0].vector.length).fill(0);
  let totalFrames = 0;

  for (const { vector, frames } of segments) {
    totalFrames += frames;
    for (let index = 0; index < vector.length; index += 1) {
      average[index] += vector[index] * frames;
    }
  }

  for (let index = 0; index < average.length; index += 1) {
    average[index] /= totalFrames;
  }

  return { vector: average, frames: totalFrames };
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }

  const norms = Math.sqrt(normA) * Math.sqrt(normB);
  return norms === 0 ? 0 : dot / norms;
}

const reference = averageXVector(enrollment.speakerVectors ?? []);
const probe = averageXVector(verification.speakerVectors ?? []);
const score = cosineSimilarity(reference.vector, probe.vector);
```

</details>

The demo starts with a similarity threshold of `0.75`, based on its tested
recordings, but this is not a universal security threshold. Calibrate it using
your own microphones, languages, speakers, and environment.

For a ready-made enrollment, persistence, verification, and identification
API, use [`speaklet`](../speaklet). speaklet's high-level speaker methods use a
NeXt-TDNN ONNX model; they do not use these native Vosk x-vectors.

## Runtime details

### Worker engine—recommended

```js
import { createVoskletMonoWorker } from "monosklet/worker";

const engine = await createVoskletMonoWorker({
  logLevel: 0,
  // Optional overrides for bundlers that cannot resolve the packaged URLs:
  // workerUrl, glueUrl, wasmUrl
});
```

The worker always uses the single-thread Vosklet runtime. Vite and webpack 5
recognize the packaged worker and Wasm URL patterns automatically. Capture
still runs on the main thread because Web Workers do not provide
`AudioContext`.

### Direct main-thread engine

```js
import { createVoskletMono } from "monosklet/singlethread";

const engine = await createVoskletMono();
```

This entry includes only the single-thread runtime and works without
cross-origin isolation. Batch transcription cooperatively yields to the event
loop; configure it with `yieldEveryBlocks`.

### Runtime-selecting main-thread engine

```js
import { createVoskletMono, supportsThreadedRuntime } from "monosklet";

const engine = await createVoskletMono({ runtime: "auto" });
console.log(engine.runtime, supportsThreadedRuntime());
```

`runtime` may be `"singlethread"`, `"threaded"`, or `"auto"`. The threaded
runtime requires `SharedArrayBuffer` and cross-origin isolation. Because this
entry can select either runtime, bundlers include both Wasm binaries. Only one
runtime can be loaded per page.

## Quick API guide

### Engine creation

| API | Result |
| --- | --- |
| `createVoskletMonoWorker(options?)` | Worker-hosted single-thread engine; exported by `monosklet/worker` |
| `supportsWorkerHost()` | Whether the environment can host the worker engine |
| `createVoskletMono(options?)` | Main-thread engine; exported by `monosklet` and `monosklet/singlethread` |
| `supportsThreadedRuntime()` | Whether the threaded main-thread runtime is available |

### Engine and models

| API | Purpose |
| --- | --- |
| `engine.loadModel({ url, id, storagePath? })` | Load and cache a speech model; returns a model session |
| `engine.loadSpkModel(...)` | Worker only: load a native Vosk speaker model |
| `engine.createTransferer(audioContext, bufferSize?)` | Create the AudioWorklet node that emits mono PCM blocks |
| `engine.setLogLevel(level)` | Change the Vosk runtime log level |
| `engine.dispose()` | Release models and recognizers; also terminates a worker engine |
| `engine.terminate()` | Worker only: stop immediately without graceful cleanup |
| `session.unload()` | Release one model while keeping its cached archive |

### Recognition

| API | Purpose |
| --- | --- |
| `session.transcribe(pcm, options)` | Batch recognition; resolves to `{ text, segments }` and optionally `speakerVectors` in the worker |
| `session.createRecognizer(options)` | Create a streaming recognizer |
| `recognizer.accept(block)` | Feed one block; synchronous on the main thread, asynchronous in a worker |
| `recognizer.finish()` | Flush final text and free the recognizer |
| `recognizer.cancel()` | Free the recognizer without a final result |

Common transcription options are `sampleRate`, `grammar`, `onSegment`, and
`onProgress`. Main-thread batch transcription also accepts `yieldEveryBlocks`;
worker transcription accepts `transfer` and `progressEveryBlocks`.

### Speech monitoring

| API | Purpose |
| --- | --- |
| `createSpeechMonitor(options?)` | Accumulate PCM and report speech/silence events |
| `monitor.push(block)` | Feed one PCM block |
| `monitor.stop()` | Stop manually and return the accumulated blocks |
| `monitor.reset()` | Reuse the monitor for another recording |
| `getRootMeanSquare(samples)` | Measure one block's RMS level |

The published package includes TypeScript declarations for every public entry
point. Main-thread engines additionally expose `engine.module` and
`recognizer.raw` as escape hatches to the underlying Vosklet API.

## Android and Capacitor checklist

- Add `RECORD_AUDIO` and usually `MODIFY_AUDIO_SETTINGS` to the Android manifest.
- Request runtime microphone permission before calling `getUserMedia()`.
- Bundle local models as plain `.tar`, not `.tar.gz`.
- Prefer `monosklet/worker`; use `/singlethread` if workers are unavailable.
- Capture mono PCM and pass the actual `AudioContext.sampleRate` to recognition.
- Stop media tracks and release models and engines when the screen is destroyed.
- Debug the installed application with Chrome remote inspection at `chrome://inspect`.

## Building from source

This repository is a pnpm monorepo. Build the Vosklet Wasm runtimes at the
repository root first, then run:

```sh
pnpm install
pnpm --filter monosklet build
pnpm --filter monosklet pack:check
pnpm --filter monosklet exec npm pack
```

`npm pack` and `npm publish` run the package build through `prepack`.

## Why “mono”?

The default runtime is mono-threaded so it can run where `SharedArrayBuffer` is
unavailable, and the audio contract is mono PCM. The name does not mean one
language: monosklet can load any compatible Vosk model at run time.

## License and third-party software

[MIT](LICENSE), the same license used by Vosklet. The vendored Wasm runtime
compiles Vosk, Kaldi, OpenFST, and OpenBLAS. Their licenses and the full
Vosklet lineage are preserved in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), which ships in the npm
package.

Vosk models have their own licenses; check the selected model before
redistributing it.
