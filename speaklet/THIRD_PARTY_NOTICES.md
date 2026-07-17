# Third-party notices

speaklet is distributed under the [MIT License](LICENSE). **speaklet is built
on Vosklet; its speech-recognition engine is not an independent implementation
or reimplementation.** speaklet bundles the monosklet engine, which vendors the
Vosklet WebAssembly runtime from the
[Devrax/Vosklet](https://github.com/Devrax/Vosklet) fork of
[msqr1/Vosklet](https://github.com/msqr1/Vosklet).

The bundled Vosklet runtime compiles in the components listed below. The npm
package also depends on `onnxruntime-web` and
`@jaehyun-ko/speaker-verification`; those separately installed packages carry
their own license files and notices.

## Vosklet

- Upstream: <https://github.com/msqr1/Vosklet> (consumed via the
  <https://github.com/Devrax/Vosklet> fork)
- License: MIT — Copyright (c) 2024 Rylex Phan
- Applies to: the Vosklet-derived engine and runtime under `dist/mono/`

## Vosk

- Upstream: <https://github.com/alphacep/vosk-api>
- License: Apache License 2.0 — Copyright Alpha Cephei Inc.
- <https://github.com/alphacep/vosk-api/blob/master/COPYING>
- Compiled into the `.wasm` binary.

## Kaldi

- Upstream: <https://github.com/kaldi-asr/kaldi>
- License: Apache License 2.0 — Copyright the Kaldi contributors (see the
  per-file notices in the Kaldi sources)
- <https://github.com/kaldi-asr/kaldi/blob/master/COPYING>
- Compiled into the `.wasm` binary.

## OpenFST

- Upstream: <https://www.openfst.org/>
- License: Apache License 2.0 — Copyright Google, Inc.
- Compiled into the `.wasm` binary.

## OpenBLAS

- Upstream: <https://github.com/OpenMathLib/OpenBLAS>
- License: BSD 3-Clause — Copyright (c) 2011-2014, The OpenBLAS Project
- <https://github.com/OpenMathLib/OpenBLAS/blob/develop/LICENSE>
- Compiled into the `.wasm` binary.

## Emscripten

- Upstream: <https://github.com/emscripten-core/emscripten>
- License: MIT (with portions under the University of Illinois/NCSA license)
- <https://github.com/emscripten-core/emscripten/blob/main/LICENSE>
- The generated JavaScript glue under `dist/mono/runtime/` includes the
  Emscripten runtime support code.

## Vosk models

Speech models loaded at runtime are **not** part of this package and carry
their own licenses. Most official models listed at
<https://alphacephei.com/vosk/models> are Apache License 2.0, but verify the
license of each model you bundle or fetch before shipping it.
