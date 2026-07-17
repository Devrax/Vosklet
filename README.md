# Vosklet

Vosklet is browser speech recognition powered by [Vosk](https://alphacephei.com/vosk/) and WebAssembly. It packages the Vosk/Kaldi runtime as a browser-facing API that loads a local or remote model archive, accepts mono `Float32Array` PCM samples, and returns recognized text.

The project provides two WebAssembly runtimes:

- `vosklet`: the default threaded runtime. It uses Wasm workers and atomics for higher throughput, and requires cross-origin isolation.
- `vosklet/singlethread`: an Android WebView and Capacitor-safe runtime. It does not require `SharedArrayBuffer`, COOP, or COEP, but recognition runs on one thread and can take longer.

The repository also includes a Spanish voice-challenge demo in [`demo/`](demo). It is a Vite application packaged as an Android app through Capacitor.

## How it works

1. The ESM loader imports the generated JavaScript and Wasm assets, then passes a bundler-safe `locateFile` callback to Emscripten.
2. `createModel()` fetches a USTAR TAR model archive, expands it in WasmFS, creates a Vosk model, and caches the fetched archive with the supplied model path and ID.
3. The application captures microphone PCM through an `AudioContext` and an `AudioWorklet`, or supplies PCM from an already-decoded audio file.
4. A recognizer receives mono `Float32Array` blocks in the range `-1.0` to `1.0`; `finalResult()` flushes the final text.
5. Applications must delete recognizers and models when they are no longer needed. `module.cleanUp()` is available as a convenience cleanup method.

## Requirements

### Using Vosklet in an application

- A modern browser in a secure context (`https://`, or `http://localhost` while developing).
- WebAssembly, `fetch`, Cache Storage, `AudioContext`, and microphone permission for microphone flows.
- `AudioWorklet` for direct microphone PCM capture.
- A Vosk model packaged as a USTAR TAR archive, either uncompressed (`.tar`) or gzip-compressed (`.tar.gz` or `.tgz`). Format detection uses the bytes, not the URL extension.

The default threaded runtime additionally requires:

- `SharedArrayBuffer` support.
- Cross-origin isolation. Serve `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (or use an equivalent deployment configuration).

The single-thread runtime does not have those isolation requirements and is the appropriate choice for the included Android WebView demo.

### Building the Wasm runtimes from source

The build script downloads and builds Emscripten, OpenFST, OpenBLAS, Kaldi, and Vosk on first use. It needs a network connection, substantial disk space, and can take some time.

Install these host tools before building:

- Git, Bash, `curl` or `wget`, `tar`, and `realpath`.
- `make`, `pkg-config`, `autoconf`, `automake`, and `libtool`.
- A host C/C++ compiler for the OpenBLAS bootstrap. `clang` is the default on macOS.

For macOS, the core autotools dependencies can be installed with:

```shell
brew install autoconf automake libtool pkg-config
```

The script installs and activates Emscripten `4.0.13` under `emsdk/` if it is absent. To use a pre-existing SDK, provide its path with `EMSDK=/path/to/emsdk`.

### Running the demo and Android app

- Node.js and [pnpm](https://pnpm.io/). The demo declares `pnpm@10.32.1` in its `packageManager` field.
- Android Studio, an Android SDK, and a compatible JDK. The current Android debug build has been verified with JDK 21.
- An Android device or emulator for microphone verification. Browser developer tools can inspect the WebView when the debug app is running.

## Build Vosklet

Clone the repository and run one or both build modes from `src/`:

```shell
git clone https://github.com/msqr1/Vosklet.git
cd Vosklet/src

# Default: threaded runtime, outputs ../Vosklet.js and ../Vosklet.wasm
./make

# Android/WebView-safe runtime, outputs ../Vosklet.single.js and ../Vosklet.single.wasm
VOSKLET_MODE=singlethread OUTPUT_BASENAME=Vosklet.single ./make
```

The build accepts these environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `VOSKLET_MODE` | `threaded` | `threaded` or `singlethread`. |
| `OUTPUT_BASENAME` | `Vosklet` | Generated JavaScript and Wasm file base name. |
| `INITIAL_MEMORY` | `315mb` | Initial Wasm memory; it can grow when necessary. |
| `MAX_THREADS` | `1` | Maximum recognizer worker count in the threaded build. |
| `JOBS` | CPU count | Parallel jobs for native dependency builds. |
| `EMSDK` | `../emsdk` | Existing Emscripten SDK location. |

If a dependency must be rebuilt, remove its generated directory at the repository root (`openfst/`, `openblas/`, `kaldi/`, or `vosk/`) and run the build again.

## Install and use the package

Install the runtime that matches your deployment constraints:

```shell
pnpm add vosklet
```

Use the default runtime only in a cross-origin-isolated deployment:

```js
import { loadVosklet } from "vosklet";
```

Use the single-thread runtime for Capacitor and Android WebView:

```js
import { loadVosklet } from "vosklet/singlethread";
```

Minimal batch-recognition flow:

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

For direct microphone PCM, connect `AudioContext.createMediaStreamSource()` to `module.createTransferer()`. The transferer's `port.onmessage` receives mono PCM blocks. See [Examples/fromMic.html](Examples/fromMic.html) and [Documentation.AndroidWebView.md](Documentation.AndroidWebView.md).

### Model hosting

- The model archive must contain model files directly below its model root.
- Serve model bytes as `application/octet-stream` where possible.
- Do not serve a gzip-compressed model with `Content-Encoding: gzip`; Vosklet must receive the original gzip bytes to decode the archive itself.
- The cache key consists of the model path and ID supplied to `createModel()`. Change the ID when publishing updated model content at the same path.

## Spanish Capacitor demo

The demo packages a local Spanish model at [`demo/public/models/es-small.tar`](demo/public/models/es-small.tar). Vite serves it as `/models/es-small.tar`, then Capacitor copies it into the Android app's web assets.

The demo uses a local file dependency, `"vosklet": "file:.."`. After rebuilding Vosklet at the repository root, run `pnpm install` in `demo/` so the bundled application picks up the fresh generated runtime.

```shell
cd demo
pnpm install

# Browser development server
pnpm dev

# Production Vite build
pnpm build

# Build web assets and copy them into the Android project
pnpm android:sync

# Synchronize and open Android Studio
pnpm android:open

# Synchronize and run through the Capacitor CLI
pnpm android:run
```

The Android manifest declares `RECORD_AUDIO` and `MODIFY_AUDIO_SETTINGS`. Install the debug app, grant microphone permission, then use Chrome remote inspection to view the `Vosklet Challenge` logs emitted by the demo.

The recording behavior is configured in [`demo/src/main.js`](demo/src/main.js):

- `stopAfterSpoken` is the continuous silence delay in milliseconds after the first detected speech block. Its default is `1_500`; assign `false` to require an explicit Stop action.
- `speechThreshold` is the RMS amplitude used to classify a PCM block as speech. Its default is `0.015` and should be adjusted for unusually noisy or quiet microphone environments.

The demo only uses those PCM measurements to decide when to stop recording. It still passes captured audio to Vosklet after recording ends, so the single-thread Android runtime does not need `SharedArrayBuffer` or live recognition.

To assemble the debug APK directly:

```shell
cd demo/android
./gradlew :app:assembleDebug --no-daemon
```

The result is written to `demo/android/app/build/outputs/apk/debug/app-debug.apk`.

## Verify changes

```shell
# Check the package file list without publishing
npm run pack:check

# Build the browser demo
pnpm --dir demo run build

# Copy web assets to Android and build the debug APK
pnpm --dir demo run android:sync
cd demo/android && ./gradlew :app:assembleDebug --no-daemon
```

## Repository layout

| Path | Purpose |
| --- | --- |
| `src/` | C++ bindings, browser wrapper, patches, and the native/Wasm build script. |
| `Vosklet.js`, `Vosklet.wasm` | Generated default threaded runtime. |
| `Vosklet.single.js`, `Vosklet.single.wasm` | Generated single-thread Android/WebView runtime. |
| `index.mjs`, `index.single.mjs` | ESM loaders that resolve generated assets safely through bundlers. |
| `Examples/` | Standalone HTML usage examples. |
| `demo/` | Vite Spanish challenge application and Capacitor Android project. |
| `Documentation.md` | Full API reference and deployment notes. |
| `Documentation.AndroidWebView.md` | Android WebView and Capacitor-specific integration guidance. |

## Further documentation

- [API reference and deployment details](Documentation.md)
- [Android WebView / Capacitor guide](Documentation.AndroidWebView.md)
- [Type declarations](Vosklet.d.ts)
- [License](LICENSE)
