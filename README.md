# Vosklet

**Offline, in-browser speech recognition that also works inside Android WebView and iOS WKWebView — no cloud, no native SDK, no special HTTP headers.**

Vosklet is [Vosk](https://alphacephei.com/vosk/) (Kaldi) compiled to WebAssembly with a browser-facing API: it loads a speech model from a local or remote archive, accepts mono `Float32Array` PCM samples, and returns recognized text. This repository is a fork of [msqr1/Vosklet](https://github.com/msqr1/Vosklet) that solves one specific, painful problem and packages the solution for application developers.

## The problem this repository solves

Upstream Vosklet's runtime uses Wasm threads, which require `SharedArrayBuffer` and **cross-origin isolation** — the `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` response headers.

That combination is unavailable in exactly the places hybrid apps live:

- **Android System WebView** does not support `SharedArrayBuffer` at all.
- **iOS WKWebView** implements it in the engine (WebKit 15.2+), but only exposes it in cross-origin-isolated contexts — and a Capacitor app served from `capacitor://localhost` through a custom scheme handler is never cross-origin isolated.

So a stock Capacitor or WebView app simply cannot start the threaded runtime. This fork resolves that with three layers:

1. **A single-thread Wasm runtime** (`Vosklet.single.js` / `Vosklet.single.wasm`): same API, no `SharedArrayBuffer`, no COOP/COEP, runs anywhere a modern WebView runs. Recognition is slower, so the recommended pattern is *capture first, transcribe after recording ends*.
2. **[`vosklet-mono/`](vosklet-mono)** — a small, framework-agnostic npm library wrapping both runtimes with the ergonomics an app actually needs: on-demand model loading (local asset **or** external URL, cached across launches), a batch `transcribe()` API with progress callbacks for already-captured PCM, a streaming recognizer, and a slim `vosklet-mono/singlethread` entry that keeps the unused threaded runtime's ~2.4 MB `.wasm` out of your app bundle. Start with its [README](vosklet-mono/README.md) if you are building an app.
3. **[`Examples/demo/`](Examples/demo)** — a working Spanish voice-challenge app (Vite + Capacitor) that builds for Android and iOS and exercises the exact packaged library artifact. Two variants of the same app live beside it: [`Examples/demo-worker/`](Examples/demo-worker) runs recognition inside a Web Worker (`vosklet-mono/worker`) so the UI thread never blocks, and [`Examples/demo-speaker/`](Examples/demo-speaker) adds speaker verification on top — you first record a reference voice reading a set text, and when you pass the spoken challenge it tells you how similar your voice sounds to that reference ([NeXt-TDNN](https://github.com/jaehyun-ko/node-speaker-verification) via onnxruntime-web; the ~7.5 MB speaker model downloads from Hugging Face on first launch and is cached, unlike the fully offline Vosk model).

## Which part should I use?

| You are... | Use | Where |
| --- | --- | --- |
| Building an app (Capacitor, WebView, or browser) | The `vosklet-mono` wrapper library | [`vosklet-mono/README.md`](vosklet-mono/README.md) |
| Wanting the raw low-level Vosklet API | The `vosklet` package (`vosklet` / `vosklet/singlethread`) | [Documentation.md](Documentation.md) |
| Modifying the C++/Wasm runtime itself | The build script in `src/` | [Build the Wasm runtimes](#step-1--build-the-wasm-runtimes) |
| Looking for a full working reference | The Spanish challenge demo | [Spanish Capacitor demo](#spanish-capacitor-demo) |

## How it works

1. The ESM loader imports the generated JavaScript and Wasm assets, then passes a bundler-safe `locateFile` callback to Emscripten.
2. `createModel()` fetches a USTAR TAR model archive, expands it in WasmFS, creates a Vosk model, and caches the fetched archive with the supplied model path and ID.
3. The application captures microphone PCM through an `AudioContext` and an `AudioWorklet`, or supplies PCM from an already-decoded audio file.
4. A recognizer receives mono `Float32Array` blocks in the range `-1.0` to `1.0`; `finalResult()` flushes the final text.
5. Applications must delete recognizers and models when they are no longer needed (`vosklet-mono` manages this lifecycle for you).

## Requirements

### Using it in an application

- A modern browser or WebView in a secure context (`https://`, `http://localhost`, or a Capacitor app scheme).
- WebAssembly, `fetch`, Cache Storage, `AudioContext`, and microphone permission for microphone flows.
- `AudioWorklet` for direct microphone PCM capture.
- A Vosk model packaged as a USTAR TAR archive, either uncompressed (`.tar`) or gzip-compressed (`.tar.gz` / `.tgz`). Format detection uses the bytes, not the URL extension. **Models bundled inside an Android app must be plain `.tar`** — Android's asset packager strips `.gz` assets at build time (explained in the [vosklet-mono README](vosklet-mono/README.md#loading-models-on-demand)).

Only the threaded runtime additionally requires `SharedArrayBuffer` and cross-origin isolation (COOP/COEP headers). The single-thread runtime — the default in `vosklet-mono` — has no isolation requirements.

### Building everything from source

The Wasm build script downloads and builds Emscripten, OpenFST, OpenBLAS, Kaldi, and Vosk on first use. It needs a network connection, substantial disk space, and time.

Host tools:

- Git, Bash, `curl` or `wget`, `tar`, and `realpath`.
- `make`, `pkg-config`, `autoconf`, `automake`, and `libtool`.
- A host C/C++ compiler for the OpenBLAS bootstrap (`clang` is the default on macOS).
- Node.js and npm for packaging the library; [pnpm](https://pnpm.io/) for the demo (it declares `pnpm@10.32.1`).

macOS one-liner for the autotools dependencies:

```shell
brew install autoconf automake libtool pkg-config
```

The script installs and activates Emscripten `4.0.13` under `emsdk/` if absent; point `EMSDK=/path/to/emsdk` at an existing SDK to reuse it.

For the demo apps:

- **Android**: Android Studio, an Android SDK, and a compatible JDK (verified with JDK 21). Inspect the running WebView via `chrome://inspect`.
- **iOS**: Xcode with an iOS 14.3+ simulator or device (WKWebView gained `getUserMedia` in 14.3). Capacitor uses Swift Package Manager — no CocoaPods. Inspect via Safari's Develop menu.

## Bundle a correct package yourself, end to end

This is the full pipeline from a fresh clone to an npm-ready artifact and a device build. Each step feeds the next.

### Step 0 — Clone

```shell
git clone https://github.com/Devrax/Vosklet.git
cd Vosklet
```

### Step 1 — Build the Wasm runtimes

Run one or both build modes from `src/`:

```shell
cd src

# Threaded runtime → ../Vosklet.js and ../Vosklet.wasm
./make

# Single-thread WebView-safe runtime → ../Vosklet.single.js and ../Vosklet.single.wasm
VOSKLET_MODE=singlethread OUTPUT_BASENAME=Vosklet.single ./make

cd ..
```

Build both if you plan to package `vosklet-mono`, since it vendors both runtimes. Accepted environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `VOSKLET_MODE` | `threaded` | `threaded` or `singlethread`. |
| `OUTPUT_BASENAME` | `Vosklet` | Generated JavaScript and Wasm file base name. |
| `INITIAL_MEMORY` | `315mb` | Initial Wasm memory; it can grow when necessary. |
| `MAX_THREADS` | `1` | Maximum recognizer worker count in the threaded build. |
| `JOBS` | CPU count | Parallel jobs for native dependency builds. |
| `EMSDK` | `../emsdk` | Existing Emscripten SDK location. |

If a dependency must be rebuilt, remove its generated directory at the repository root (`openfst/`, `openblas/`, `kaldi/`, or `vosk/`) and run the build again.

### Step 2 — Package the `vosklet-mono` library

`vosklet-mono` consumes the repository root as a `file:..` dev dependency, bundles and minifies its wrapper with Vite, vendors the runtimes you built in Step 1 into `dist/`, and produces a **self-contained** tarball with no runtime dependencies:

```shell
cd vosklet-mono
npm install
npm pack          # runs the Vite build via prepack → vosklet-mono-<version>.tgz
cd ..
```

Sanity checks along the way:

```shell
npm run build         # build dist/ without packing
npm run pack:check    # list the tarball contents without writing it
```

The tarball is what you would `npm publish` (or install directly from the file path / a git URL). It ships both entry points — `vosklet-mono` (runtime selectable) and `vosklet-mono/singlethread` (slim, WebView-first) — plus type declarations and third-party license notices.

### Step 3 — Get a model

Download a model for your language from [alphacephei.com/vosk/models](https://alphacephei.com/vosk/models) and repackage the `.zip` as a USTAR TAR:

```shell
unzip vosk-model-small-es-0.42.zip
cd vosk-model-small-es-0.42
tar --format=ustar -cf ../es-small.tar .
```

Bundle the `.tar` in your app's web assets, or host it (uncompressed or `.tar.gz`) on any static server — never with `Content-Encoding: gzip`.

### Step 4 — Consume it in your app

```shell
npm install ./vosklet-mono/vosklet-mono-0.2.1.tgz    # or from npm once published
```

```js
import { createVoskletMono } from "vosklet-mono/singlethread";

const engine = await createVoskletMono();
const session = await engine.loadModel({
  url: "/models/es-small.tar",
  id: "vosk-model-small-es-0.42"
});
const { text } = await session.transcribe(capturedPcmBlocks, { sampleRate });
```

The [vosklet-mono README](vosklet-mono/README.md) covers microphone capture, model swapping, grammar constraints, runtime selection, and the Android/iOS checklists.

### Step 5 — Verify with the demo (optional but recommended)

The demo consumes the exact tarball from Step 2, so it doubles as an integration test:

```shell
cd Examples/demo
pnpm install

pnpm dev            # browser development server
pnpm build          # production Vite build

pnpm android:sync   # build web assets and copy them into the Android project
pnpm android:open   # ...and open Android Studio
pnpm android:run    # ...and run through the Capacitor CLI

pnpm ios:sync       # iOS equivalents
pnpm ios:open
pnpm ios:run
```

Or assemble the debug APK directly:

```shell
cd Examples/demo/android
./gradlew :app:assembleDebug --no-daemon
# → Examples/demo/android/app/build/outputs/apk/debug/app-debug.apk
```

After rebuilding the Wasm runtimes (Step 1), repeat Step 2 and reinstall in the demo so everything picks up the fresh artifacts:

```shell
cd vosklet-mono && npm install && npm pack
cd ../Examples/demo && pnpm install
```

## Using the low-level `vosklet` package directly

The wrapper is optional; the underlying package remains fully usable:

```js
import { loadVosklet } from "vosklet";               // threaded; cross-origin-isolated deployments only
import { loadVosklet } from "vosklet/singlethread";  // WebView-safe single-thread runtime
```

```js
const module = await loadVosklet();
const model = await module.createModel(
  new URL("/models/vosk-model-small-en-us.tar", window.location.origin).href,
  "English",
  "vosk-model-small-en-us-0.15"
);

const recognizer = await module.createRecognizer(model, audioContext.sampleRate);

for (const pcmBlock of pcmBlocks) {
  const result = JSON.parse(recognizer.acceptWaveform(pcmBlock));
  if (result.text) {
    console.log("Completed segment:", result.text);
  }
}

const finalResult = JSON.parse(recognizer.finalResult());
console.log("Final text:", finalResult.text);

await recognizer.delete();
model.delete();
```

For direct microphone PCM, connect `AudioContext.createMediaStreamSource()` to `module.createTransferer()`; its `port.onmessage` receives mono PCM blocks. See [Examples/fromMic.html](Examples/fromMic.html) and [Documentation.AndroidWebView.md](Documentation.AndroidWebView.md).

### Model hosting rules

- The model archive must contain model files directly below its model root.
- Serve model bytes as `application/octet-stream` where possible.
- Do not serve a gzip-compressed model with `Content-Encoding: gzip`; Vosklet must receive the original gzip bytes to decode the archive itself.
- The cache key consists of the model path and ID supplied to `createModel()`. Change the ID when publishing updated model content at the same path.

## Spanish Capacitor demo

The demo packages a local Spanish model at [`Examples/demo/public/models/es-small.tar`](Examples/demo/public/models/es-small.tar). Vite serves it as `/models/es-small.tar`, then Capacitor copies it into the Android and iOS web assets, so recognition is fully offline.

It consumes the packaged wrapper library, `"vosklet-mono": "file:../vosklet-mono/vosklet-mono-0.2.1.tgz"`, through the slim `vosklet-mono/singlethread` entry — exercising the exact artifact that would be published to npm while keeping the threaded runtime's `.wasm` out of the app bundle.

Platform notes:

- The Android manifest declares `RECORD_AUDIO` and `MODIFY_AUDIO_SETTINGS`. Install the debug app, grant microphone permission, then use Chrome remote inspection to view the `Vosklet Challenge` logs.
- The iOS project declares `NSMicrophoneUsageDescription` in `Examples/demo/ios/App/App/Info.plist`. iOS WKWebView does not expose `SharedArrayBuffer` in a stock Capacitor app, so the single-thread runtime is the correct choice there as well. The simulator uses the host Mac's microphone.

Recording behavior is configured in [`Examples/demo/src/main.js`](Examples/demo/src/main.js):

- `stopAfterSpoken` is the continuous silence delay in milliseconds after the first detected speech block. Its default is `1_500`; assign `false` to require an explicit Stop action.
- `speechThreshold` is the RMS amplitude used to classify a PCM block as speech. Its default is `0.015` and should be adjusted for unusually noisy or quiet microphone environments.

The demo only uses those PCM measurements to decide when to stop recording. Captured audio is passed to the recognizer after recording ends, so the single-thread runtime never blocks live capture.

## Verify changes

```shell
# Library: rebuild, type-check output, and inspect the tarball file list
cd vosklet-mono && npm run build && npm run pack:check

# Browser demo build
pnpm --dir Examples/demo run build

# Android: copy web assets and build the debug APK
pnpm --dir Examples/demo run android:sync
cd Examples/demo/android && ./gradlew :app:assembleDebug --no-daemon

# iOS: copy web assets and build for the simulator
pnpm --dir Examples/demo run ios:sync
cd Examples/demo/ios/App && xcodebuild -project App.xcodeproj -scheme App -sdk iphonesimulator -configuration Debug build
```

## Repository layout

| Path | Purpose |
| --- | --- |
| `src/` | C++ bindings, browser wrapper, patches, and the native/Wasm build script. |
| `Vosklet.js`, `Vosklet.wasm` | Generated default threaded runtime. |
| `Vosklet.single.js`, `Vosklet.single.wasm` | Generated single-thread Android/WebView runtime. |
| `index.mjs`, `index.single.mjs` | ESM loaders that resolve generated assets safely through bundlers. |
| `vosklet-mono/` | Consumer-facing npm wrapper library (on-demand models, batch transcription, WebView-safe by default). |
| `Examples/` | Standalone HTML usage examples. |
| `Examples/demo/` | Vite Spanish challenge application with Capacitor Android and iOS projects. |
| `Documentation.md` | Full API reference and deployment notes. |
| `Documentation.AndroidWebView.md` | Android WebView and Capacitor-specific integration guidance. |

## Further documentation

- [vosklet-mono library README](vosklet-mono/README.md)
- [API reference and deployment details](Documentation.md)
- [Android WebView / Capacitor guide](Documentation.AndroidWebView.md)
- [Type declarations](Vosklet.d.ts)
- [License](LICENSE) — MIT, with [third-party notices](vosklet-mono/THIRD_PARTY_NOTICES.md) for the compiled-in components
- Upstream project: [msqr1/Vosklet](https://github.com/msqr1/Vosklet)
