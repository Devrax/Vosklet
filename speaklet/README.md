# speaklet

Voice-challenge toolkit for the browser: offline speech recognition
([monosklet](../monosklet)) unified with on-device speaker verification
([@jaehyun-ko/speaker-verification](https://www.npmjs.com/package/@jaehyun-ko/speaker-verification),
NeXt-TDNN via onnxruntime-web), plus the microphone capture that feeds both.
Everything runs locally with single-threaded wasm — no SharedArrayBuffer,
COOP, or COEP — so it works in Android WebView, Capacitor, and iOS WKWebView.

**speaklet is built on Vosklet.** Its speech-recognition engine is not an
independent implementation: speaklet bundles `monosklet`, which directly
vendors the [Vosklet](https://github.com/msqr1/Vosklet) Vosk + Kaldi
WebAssembly runtime from the
[Devrax/Vosklet](https://github.com/Devrax/Vosklet) fork. speaklet adds
microphone capture, enrollment, and NeXt-TDNN speaker verification around that
Vosklet-based engine.

## Install

```sh
pnpm add speaklet
```

The package is self-contained: the monosklet speech engine (worker host,
single-thread wasm runtime) is bundled into it at build time. Its only
dependencies are `onnxruntime-web` and `@jaehyun-ko/speaker-verification`,
both pinned to exact versions — no version ranges, no surprise transitive
upgrades. You still serve onnxruntime-web's wasm binaries yourself (see
`wasmPaths` and the demo app's vite config).

The Vosklet lineage and compiled-in third-party components are documented in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), which ships with the npm
package.

## Run the demo

A speaker-verification example lives in the monorepo's demo app
([`Examples/demo`](../Examples/demo), the `speaker/` page). From a fresh
clone, `pnpm run setup` at the repository root bootstraps everything —
install, builds, the packed tarball the demo consumes, and the model
downloads (they are not committed) — then `pnpm run demo` starts the app
with a home page routing to every example.

## Quick start

```js
import { createVoskletSpeaker } from "speaklet";

const speaker = await createVoskletSpeaker({
  model: { url: "/models/es-small.tar", id: "vosk-model-small-es-0.42" },
  verifier: { model: "standard-384" }
});
void speaker.warmUp(); // prefetch the ONNX speaker model in the background

// 1. Record one utterance (auto-stops after silence, or call capture.stop()).
const capture = await speaker.record({ stopAfterSpoken: 3000 });
const recording = await capture.result; // { blocks, wav, sampleRate, reason }

// 2. Transcribe it (transfers the blocks; the WAV blob keeps the audio).
const { text } = await speaker.transcribe(recording);

// 3a. Enroll the user's voice, gated on them actually reading the text:
const enrollment = await speaker.enroll(
  { wav: recording.wav, text },
  { expectedText: "Confirmo que esta es mi voz...", matchThreshold: 0.65 }
);

// 3b. ...or verify a later recording against the enrolled reference:
if (speaker.hasReference()) {
  const { score, match } = await speaker.verify(recording.wav);
}
```

Bring your own audio if you prefer: `record()` accepts `stream` (skip the
built-in `getUserMedia`) and `audioContext` (reuse yours); both are left
untouched on teardown when you provide them.

## The two models, and where they come from

The suite loads two models: a **Vosk speech model** for recognition and a
**NeXt-TDNN ONNX model** for speaker verification. Each can be bundled with
your app (fully offline) or fetched from a URL (downloaded once, then kept in
Cache Storage across launches).

### Which speaker engine does speaklet use?

The high-level `speaker.enroll()`, `speaker.verify()`, and
`speaker.identify()` methods do **not** use monosklet's native Vosk x-vector
speaker model. In those methods, Vosk + Kaldi handles speech-to-text, while
speaker embeddings and comparisons are produced by the external NeXt-TDNN
ONNX models through `@jaehyun-ko/speaker-verification` and
`onnxruntime-web`.

This does not restrict the bundled monosklet engine. The complete monosklet
worker API remains available through `speaker.engine`, including
`engine.loadSpkModel()` for native Vosk x-vectors. speaklet also re-exports
`createVoskletMonoWorker()` for applications that want to use that engine
directly. In other words, speaklet's convenience methods choose NeXt-TDNN for
speaker verification, while the underlying native Vosk speaker path remains
available as a lower-level option.

### Speech model (Vosk)

Pick a language from [alphacephei.com/vosk/models](https://alphacephei.com/vosk/models).
The downloads are `.zip` archives; the engine consumes **USTAR TAR** (`.tar`,
or `.tar.gz` served without `Content-Encoding: gzip`), so repackage once:

```sh
unzip vosk-model-small-es-0.42.zip
cd vosk-model-small-es-0.42
tar --format=ustar -cf ../es-small.tar .
```

**Local, fully offline** — bundle the `.tar` with your web assets (e.g.
`public/models/`; keep it plain `.tar` inside Android apps, whose asset
packager strips `.gz` files):

```js
const speaker = await createVoskletSpeaker({
  model: { url: "/models/es-small.tar", id: "vosk-model-small-es-0.42" },
  verifier: { model: "standard-384" }
});
```

**Remote** — host the repackaged archive on any static server and point at
it; it is downloaded on first launch and cached under `id`, so bump the `id`
when you publish new model content at the same URL:

```js
const speaker = await createVoskletSpeaker({
  model: {
    url: "https://cdn.example.com/models/vosk-model-small-es-0.42.tar.gz",
    id: "vosk-model-small-es-0.42"
  },
  verifier: { model: "standard-384" }
});
```

### Speaker model (NeXt-TDNN ONNX)

Aliases map to the files published at
[huggingface.co/jaehyun-ko/next-tdnn-onnx](https://huggingface.co/jaehyun-ko/next-tdnn-onnx/tree/main):

| Alias | File on the Hugging Face repo | Size |
| --- | --- | --- |
| `standard-384` (default) | `NeXt_TDNN_C384_B1_K65_7.onnx` | ~27 MB |
| `standard-256` | `NeXt_TDNN_C256_B3_K65_7.onnx` | ~28 MB |
| `standard-192` | `NeXt_TDNN_C192_B1_K65_7.onnx` | ~16 MB |
| `standard-128` | `NeXt_TDNN_C128_B3_K65_7.onnx` | ~7.5 MB |
| `mobile-256` | `NeXt_TDNN_light_C256_B3_K65.onnx` | ~20 MB |
| `mobile-128` | `NeXt_TDNN_light_C128_B3_K65.onnx` | ~5 MB |

**Default URL** — pass just the alias and the model is fetched from that
Hugging Face repo on first use (`warmUp()` prefetches it), then kept in Cache
Storage:

```js
const speaker = await createVoskletSpeaker({
  model: { url: "/models/es-small.tar", id: "vosk-model-small-es-0.42" },
  verifier: { model: "mobile-128" } // smallest; good fit for WebView apps
});
```

**Local / self-hosted** — download the `.onnx` from the table above and serve
it from your own assets or CDN via `modelUrl` (no Hugging Face at runtime).
Keep the alias matching the file — it drives preprocessing and the
reference-store key:

```js
const speaker = await createVoskletSpeaker({
  model: { url: "/models/es-small.tar", id: "vosk-model-small-es-0.42" },
  verifier: {
    model: "standard-384",
    modelUrl: "/models/NeXt_TDNN_C384_B1_K65_7.onnx"
  }
});
```

Embeddings are only comparable within one model: switching the alias forces
re-enrollment (the default reference store keys by alias for exactly that
reason).

## Multiple speakers: enroll by id, then ask who is talking

One suite (one ONNX model instance) serves any number of speakers. Enroll
each voice under a stable `id` (with an optional display `label`), then
`identify()` any later audio against all of them:

```js
await speaker.enroll({ wav: rafaWav, text }, { id: "rafa", label: "Rafael", expectedText });
await speaker.enroll({ wav: anaWav, text }, { id: "ana", label: "Ana", expectedText });

const who = await speaker.identify(recording.wav);
// { id: "ana", label: "Ana", score: 0.71, match: true, threshold: 0.5,
//   scores: [ { id: "ana", ... }, { id: "rafa", score: 0.22, ... } ] }

speaker.listSpeakers();          // [{ id: "rafa", label: "Rafael" }, { id: "ana", label: "Ana" }]
await speaker.verify(wav, { id: "rafa" });  // 1:1 check against one speaker
speaker.clearReference("ana");   // remove one speaker
speaker.clearAllReferences();    // start over
```

Calls without an `id` keep working against the `"default"` speaker, and a
reference enrolled with an older (single-speaker) version of this package is
migrated to that `"default"` id automatically. Custom `referenceStore`
implementations now take the id as their first argument — see
`ReferenceStore` in the type declarations.

### Persisting the enrollment audio

By default only the voice *embedding* is stored — the recorded audio never
leaves page memory. Opt in with `persist: true` to also keep the enrollment
WAV in Cache Storage (the same bucket as the model), so it survives reloads:

```js
await speaker.enroll(
  { wav: recording.wav, text },
  { id: "rafa", label: "Rafael", persist: true, expectedText }
);

const wav = await speaker.loadEnrollmentAudio("rafa"); // Blob | null
await speaker.clearEnrollmentAudio("rafa");            // drop the audio, keep the reference
speaker.clearReference("rafa");                        // drops reference AND persisted audio
```

Persistence is best-effort: on origins where the Cache API is unusable
(e.g. iOS `capacitor://`) enrollment still succeeds and
`loadEnrollmentAudio()` returns `null`. Persisted audio is voice data —
treat it as personal data and clear it when the user asks.

## The pieces, à la carte

The suite is a thin composition — every layer is exported on its own:

- `startCapture(engine, options)` — microphone → AudioWorklet transferer →
  speech monitor → `{ blocks, wav, sampleRate }`.
- `createSpeakerVerifier(options)` — ONNX model download with persistent
  Cache Storage (with a fallback for non-HTTP(S) origins like iOS
  `capacitor://`), embeddings, cosine comparison, multi-speaker
  enroll/verify/identify by id, and a pluggable `referenceStore`
  (localStorage by default).
- `encodeWav(blocks, sampleRate)` — mono Float32 PCM → 16-bit WAV blob.
- `normalizeText` / `textsMatch` / `wordOverlap` — accent/punctuation-proof
  transcript comparison for challenge and enrollment gates.

## App bundler requirements

Two things the consuming app must configure (see the demo app's vite config
in `Examples/demo`):

1. **onnxruntime-web wasm binaries.** Its exports map hides the `.wasm`
   files from bundlers; serve them under `ort/` next to your page (the
   default `wasmPaths`), or pass `verifier.wasmPaths`.
2. **`ort` alias.** `@jaehyun-ko/speaker-verification` is a UMD bundle whose
   external dependency is literally named `ort`; alias it to
   `onnxruntime-web` (in vite: `resolve.alias.ort = "onnxruntime-web"`).

## License

MIT — see [LICENSE](./LICENSE).
