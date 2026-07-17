# speaklet

An on-device voice-challenge toolkit for browsers and WebViews. speaklet joins
offline speech recognition, microphone capture, enrollment, speaker
verification, and speaker identification behind one application API.

**speaklet is built on Vosklet.** Speech-to-text is provided by the bundled
[`monosklet`](../monosklet) engine, which vendors the
[Vosklet](https://github.com/msqr1/Vosklet) Vosk + Kaldi WebAssembly runtime
from the [Devrax/Vosklet](https://github.com/Devrax/Vosklet) fork. speaklet adds
capture and NeXt-TDNN speaker verification through
`@jaehyun-ko/speaker-verification` and `onnxruntime-web`.

Everything runs on the device. You decide whether the speech and speaker
models are bundled with the application or downloaded and cached on first use.

## Install

```sh
npm install speaklet
# or
pnpm add speaklet
```

Installing `monosklet` separately is not required. Its worker engine and
single-thread Vosklet runtime are bundled into speaklet.

## Required application setup

speaklet needs three runtime assets:

1. A Vosk speech model repackaged as USTAR TAR.
2. A NeXt-TDNN ONNX speaker model, either from the default remote URL or your own URL.
3. The `onnxruntime-web` Wasm binaries served by your application.

### 1. Prepare a speech model

Choose a language from
[alphacephei.com/vosk/models](https://alphacephei.com/vosk/models), then convert
the downloaded ZIP archive:

```sh
unzip vosk-model-small-es-0.42.zip
cd vosk-model-small-es-0.42
tar --format=ustar -cf ../es-small.tar .
```

Put the TAR file in your application's static assets, for example
`public/models/es-small.tar`. Android application assets should use plain
`.tar`, not `.tar.gz`.

### 2. Serve the ONNX Runtime Wasm files

Copy these files from `node_modules/onnxruntime-web/dist/` into a static
directory served as `/ort/`:

```text
ort-wasm.wasm
ort-wasm-simd.wasm
```

For example, a Vite application can copy them into `public/ort/` as part of its
setup or build script. If they are served elsewhere, pass an absolute
`verifier.wasmPaths` URL.

### 3. Configure the `ort` bundler alias

`@jaehyun-ko/speaker-verification` imports an external dependency named `ort`.
Map it to `onnxruntime-web` in the consuming application:

```js
// vite.config.js
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: {
      ort: "onnxruntime-web"
    }
  }
});
```

Other bundlers need the equivalent alias. The repository's
[`Examples/demo/vite.config.js`](https://github.com/Devrax/Vosklet/blob/main/Examples/demo/vite.config.js)
shows a complete Vite plugin that serves the files in development and copies
them into production builds.

## Quick start: enroll, then verify

This example records two separate utterances: the first enrolls a voice, and
the second verifies it.

```js
import { createVoskletSpeaker } from "speaklet";

const enrollmentText =
  "Confirmo que esta es mi voz y autorizo guardarla como referencia";

const speaker = await createVoskletSpeaker({
  model: {
    url: "/models/es-small.tar",
    id: "vosk-model-small-es-0.42"
  },
  verifier: {
    model: "standard-384",
    wasmPaths: new URL("/ort/", window.location.origin).href
  },
  capture: {
    speechThreshold: 0.015,
    stopAfterSpoken: 3_000
  }
});

async function recordOnce() {
  const capture = await speaker.record();
  const recording = await capture.result;

  if (!recording) {
    throw new Error("Recording was cancelled");
  }

  return recording;
}

try {
  // Optional: download or restore the ONNX model before the user records.
  await speaker.warmUp((source) => console.log(`Speaker model: ${source}`));

  // 1. Enrollment recording.
  const enrollmentRecording = await recordOnce();
  const { text: enrollmentTranscript } =
    await speaker.transcribe(enrollmentRecording);

  const enrollment = await speaker.enroll(
    {
      wav: enrollmentRecording.wav,
      text: enrollmentTranscript
    },
    {
      expectedText: enrollmentText,
      matchThreshold: 0.65,
      id: "current-user",
      label: "Current user"
    }
  );

  if (!enrollment.accepted) {
    throw new Error(`Enrollment reading matched only ${enrollment.overlap}`);
  }

  // 2. A different, later recording.
  const verificationRecording = await recordOnce();
  const { text } = await speaker.transcribe(verificationRecording);
  const verification = await speaker.verify(verificationRecording.wav, {
    id: "current-user"
  });

  console.log({ text, ...verification });
  // { text, id, label, score, match, threshold }
} finally {
  await speaker.dispose();
}
```

`record()` auto-stops after speech followed by silence. Its returned handle also
provides `stop()` for a stop button and `cancel()` to discard the recording.
The WAV is created before `transcribe()` transfers the PCM block buffers to the
worker, so it remains available for `enroll()`, `verify()`, or `identify()`.

For a complete interface with UI state, progress, errors, manual stop, and
model status, see
[`Examples/demo/src/speaker.js`](https://github.com/Devrax/Vosklet/blob/main/Examples/demo/src/speaker.js).

## Which speaker engine is being used?

speaklet contains two distinct speaker-processing paths:

| Path | Speech-to-text | Speaker embeddings | What you implement |
| --- | --- | --- | --- |
| `speaker.enroll()`, `verify()`, `identify()` | Vosk + Kaldi through monosklet | External NeXt-TDNN ONNX models | High-level API handles enrollment, persistence, comparison, and thresholds |
| `createVoskletMonoWorker()` / `engine.loadSpkModel()` | Vosk + Kaldi through monosklet | Native Vosk x-vectors | Your application stores, averages, and compares raw embeddings |

Therefore, speaklet's high-level speaker methods do **not** use monosklet's
native Vosk speaker-recognition model. Vosk + Kaldi recognizes the words;
`@jaehyun-ko/speaker-verification` and `onnxruntime-web` produce and compare the
voice embeddings.

The bundled monosklet functionality is not restricted. speaklet re-exports
`createVoskletMonoWorker()` and `supportsWorkerHost()` for applications that
want the native Vosk x-vector API. The default suite's worker is also available
at `speaker.engine` at run time, but no high-level speaklet method wraps
`loadSpkModel()`.

## Configure the models

### Vosk speech model

Use a local model for a fully offline installation:

```js
const speaker = await createVoskletSpeaker({
  model: {
    url: "/models/es-small.tar",
    id: "vosk-model-small-es-0.42",
    storagePath: "Spanish"
  }
});
```

Or download one from your own server on first use:

```js
const speaker = await createVoskletSpeaker({
  model: {
    url: "https://cdn.example.com/vosk-model-small-es-0.42.tar.gz",
    id: "vosk-model-small-es-0.42"
  }
});
```

The archive is cached under `id`; change the ID when replacing model contents
at the same URL.

### NeXt-TDNN speaker model

The following aliases are provided by
`@jaehyun-ko/speaker-verification`:

| Alias | Approximate download | Notes |
| --- | ---: | --- |
| `standard-384` | 27 MB | Default; highest-capacity standard option |
| `standard-256` | 28 MB | Standard model |
| `standard-192` | 16 MB | Smaller standard model |
| `standard-128` | 7.5 MB | Compact standard model |
| `mobile-256` | 20 MB | Mobile architecture |
| `mobile-128` | 5 MB | Smallest; useful for WebView applications |

With only an alias, the model is downloaded from the project's default
Hugging Face repository and cached on first use:

```js
verifier: { model: "mobile-128", wasmPaths: "/ort/" }
```

To avoid a runtime dependency on Hugging Face, host the matching ONNX file:

```js
verifier: {
  model: "standard-384",
  modelUrl: "/models/NeXt_TDNN_C384_B1_K65_7.onnx",
  wasmPaths: new URL("/ort/", window.location.origin).href
}
```

Keep the alias consistent with the selected model file. Embeddings from
different models are not comparable, and changing models requires enrollment
again. `wasmPaths` should be absolute when the application has pages below a
subpath such as `/speaker/`.

## Multiple speakers

Enroll each person under a stable ID, optionally with a display label:

```js
await speaker.enroll(
  { wav: rafaRecording.wav, text: rafaTranscript },
  { id: "rafa", label: "Rafael", expectedText: enrollmentText }
);

await speaker.enroll(
  { wav: anaRecording.wav, text: anaTranscript },
  { id: "ana", label: "Ana", expectedText: enrollmentText }
);

const identified = await speaker.identify(probeRecording.wav);
// {
//   id: "ana", label: "Ana", score: 0.71, match: true, threshold: 0.5,
//   scores: [{ id: "ana", ... }, { id: "rafa", score: 0.22, ... }]
// }

speaker.listSpeakers();
await speaker.verify(probeRecording.wav, { id: "rafa" }); // one-to-one
speaker.clearReference("ana");
speaker.clearAllReferences();
```

Calls without an ID use the `"default"` speaker.

## Persistence and privacy

Reference embeddings are stored in localStorage by default. Enrollment audio
is not persisted unless explicitly requested:

```js
await speaker.enroll(
  { wav: recording.wav, text },
  {
    id: "rafa",
    label: "Rafael",
    expectedText: enrollmentText,
    persist: true
  }
);

const wav = await speaker.loadEnrollmentAudio("rafa");
await speaker.clearEnrollmentAudio("rafa"); // keeps the embedding
speaker.clearReference("rafa");             // removes both
```

Audio persistence uses Cache Storage and is best-effort. On origins where that
API cannot be used, such as some `capacitor://` environments, enrollment still
succeeds and `loadEnrollmentAudio()` returns `null`.

Voice recordings and embeddings are biometric data. Tell users what is stored,
protect application access, and provide a way to clear it.

## Quick API guide

### High-level suite

```js
const speaker = await createVoskletSpeaker({
  model: { url, id, storagePath },
  engine,         // optional existing monosklet-compatible engine
  engineOptions,  // options used when speaklet creates its worker
  verifier,       // NeXt-TDNN/ONNX options
  capture         // defaults merged into every record() call
});
```

| API | Purpose |
| --- | --- |
| `speaker.warmUp(onStatus?)` | Load the ONNX speaker model before first use |
| `speaker.record(options?)` | Start microphone capture; returns a capture handle |
| `speaker.transcribe(recording, options?)` | Recognize the captured PCM through monosklet |
| `speaker.enroll(input, options?)` | Gate an enrollment by expected text and save its embedding |
| `speaker.verify(audio, options?)` | Compare audio with one enrolled speaker |
| `speaker.identify(audio, options?)` | Rank audio against every enrolled speaker |
| `speaker.listSpeakers()` | Return `{ id, label? }` entries |
| `speaker.hasReference(id?)` | Check whether a speaker is enrolled |
| `speaker.loadEnrollmentAudio(id?)` | Load audio saved with `persist: true` |
| `speaker.clearEnrollmentAudio(id?)` | Remove saved audio but keep its embedding |
| `speaker.clearReference(id?)` | Remove one embedding and its saved audio |
| `speaker.clearAllReferences()` | Remove every enrollment |
| `speaker.dispose()` | Close the shared AudioContext and owned worker engine |

`enroll()` resolves `{ accepted, overlap, embedding? }`. `verify()` resolves
`{ id, label?, score, match, threshold }`. `identify()` adds a best-first
`scores` array.

### Capture handle

| API | Purpose |
| --- | --- |
| `capture.result` | Resolves to `{ blocks, wav, sampleRate, reason }`, or `null` after cancellation |
| `capture.stop()` | Finish immediately and return the audio captured so far |
| `capture.cancel()` | Discard the recording and resolve `result` with `null` |

`record()` accepts an existing `stream` or `audioContext`. Values provided by
the application are left open during capture teardown.

### Lower-level exports

| Export | Purpose |
| --- | --- |
| `startCapture(engine, options)` | Use speaklet capture with your own compatible engine |
| `createSpeakerVerifier(options)` | Use NeXt-TDNN enrollment and comparison without speech recognition |
| `createLocalStorageReferenceStore(key)` | Create the default-style multi-speaker store |
| `encodeWav(blocks, sampleRate)` | Encode mono Float32 PCM as 16-bit WAV |
| `normalizeText`, `textsMatch`, `wordOverlap` | Compare challenge transcripts despite case, accents, and punctuation |
| `createVoskletMonoWorker`, `supportsWorkerHost` | Access the bundled monosklet worker directly |
| `DEFAULT_SAME_SPEAKER_THRESHOLD`, `DEFAULT_SPEAKER_ID` | Default verification constants |

`createSpeakerVerifier()` additionally exposes `init`, `embed`, `compare`,
`enroll`, `verify`, `identify`, reference management, and persisted-enrollment
audio management. The published TypeScript declarations document the complete
option and result shapes.

## Run the repository demo

From a fresh clone of the monorepo:

```sh
pnpm run setup
pnpm run demo
```

`setup` installs dependencies, builds the packages, packs the tarballs consumed
by the demo, and downloads the uncommitted model assets. Open the `speaker/`
page for the high-level speaklet flow or `spk/` for native Vosk x-vectors.

## License and third-party software

MIT—see [LICENSE](LICENSE).

The Vosklet lineage and the Vosk, Kaldi, OpenFST, OpenBLAS, NeXt-TDNN, and ONNX
Runtime components are documented in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), which ships in the npm
package. Models have their own licenses; verify them before redistribution.
