# Third-party notices

vosklet-mono is distributed under the [MIT License](LICENSE). Its published
`dist/` directory vendors the Vosklet runtime, whose WebAssembly binaries
compile in the third-party components listed below. All of them are permissive
licenses; this file preserves their attribution as those licenses request.

## Vosklet

- Upstream: <https://github.com/msqr1/Vosklet> (consumed via the
  <https://github.com/Devrax/Vosklet> fork)
- License: MIT — Copyright (c) 2024 Rylex Phan
- Applies to: `dist/runtime/index.mjs`, `dist/runtime/index.single.mjs`,
  `dist/runtime/Vosklet*.js`, `dist/runtime/Vosklet*.wasm`

## Vosk

- Upstream: <https://github.com/alphacep/vosk-api>
- License: Apache License 2.0 — Copyright Alpha Cephei Inc.
- <https://github.com/alphacep/vosk-api/blob/master/COPYING>
- Compiled into the `.wasm` binaries.

## Kaldi

- Upstream: <https://github.com/kaldi-asr/kaldi>
- License: Apache License 2.0 — Copyright the Kaldi contributors (see the
  per-file notices in the Kaldi sources)
- <https://github.com/kaldi-asr/kaldi/blob/master/COPYING>
- Compiled into the `.wasm` binaries.

## OpenFST

- Upstream: <https://www.openfst.org/>
- License: Apache License 2.0 — Copyright Google, Inc.
- Compiled into the `.wasm` binaries.

## OpenBLAS

- Upstream: <https://github.com/OpenMathLib/OpenBLAS>
- License: BSD 3-Clause — Copyright (c) 2011-2014, The OpenBLAS Project
- <https://github.com/OpenMathLib/OpenBLAS/blob/develop/LICENSE>
- Compiled into the `.wasm` binaries.

## Emscripten

- Upstream: <https://github.com/emscripten-core/emscripten>
- License: MIT (with portions under the University of Illinois/NCSA license)
- <https://github.com/emscripten-core/emscripten/blob/main/LICENSE>
- The generated JavaScript glue (`dist/runtime/Vosklet*.js`) includes the
  Emscripten runtime support code.

## Vosk models

Speech models loaded at runtime through `loadModel()` are **not** part of this
package and carry their own licenses. Most official models listed at
<https://alphacephei.com/vosk/models> are Apache License 2.0, but verify the
license of each model you bundle or fetch before shipping it.
