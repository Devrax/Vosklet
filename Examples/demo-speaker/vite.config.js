import { defineConfig } from "vite";
import { copyFile, mkdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// onnxruntime-web's exports map does not expose its .wasm binaries, so Vite
// cannot import them as assets. Serve them in dev and copy them into the
// build output instead; vosklet-speaker's default wasmPaths points
// ort.env.wasm.wasmPaths at "ort/". Only the single-threaded binaries are shipped — WebView has no
// SharedArrayBuffer, so the threaded variants could never load anyway.
const ortWasmDir = fileURLToPath(
  new URL("./node_modules/onnxruntime-web/dist/", import.meta.url)
);
const ortWasmFiles = ["ort-wasm-simd.wasm", "ort-wasm.wasm"];

function ortWasm() {
  let isBuild = false;
  return {
    name: "demo-speaker:ort-wasm",
    configResolved(config) {
      isBuild = config.command === "build";
    },
    configureServer(server) {
      server.middlewares.use("/ort", (req, res, next) => {
        const name = req.url.split("?")[0].replace(/^\//, "");
        if (!ortWasmFiles.includes(name)) {
          return next();
        }
        res.setHeader("Content-Type", "application/wasm");
        createReadStream(path.join(ortWasmDir, name)).pipe(res);
      });
    },
    async closeBundle() {
      if (!isBuild) {
        return;
      }
      const outDir = fileURLToPath(new URL("./dist/ort/", import.meta.url));
      await mkdir(outDir, { recursive: true });
      for (const name of ortWasmFiles) {
        await copyFile(path.join(ortWasmDir, name), path.join(outDir, name));
      }
    }
  };
}

// The NeXt-TDNN speaker model is consumed locally (no Hugging Face at
// runtime) but too large to commit: models/ is gitignored, so serve it in
// dev and copy it into the build from there. Fetch it once with
// `pnpm run fetch:speaker-model`.
const speakerModelFile = "NeXt_TDNN_C384_B1_K65_7.onnx";
const speakerModelDir = fileURLToPath(new URL("./models/", import.meta.url));

function speakerModel() {
  let isBuild = false;
  const missing = () =>
    `${path.join(speakerModelDir, speakerModelFile)} is missing — run ` +
    `"pnpm run fetch:speaker-model" in Examples/demo-speaker first.`;
  return {
    name: "demo-speaker:speaker-model",
    configResolved(config) {
      isBuild = config.command === "build";
    },
    configureServer(server) {
      server.middlewares.use(`/models/${speakerModelFile}`, (_req, res) => {
        res.setHeader("Content-Type", "application/octet-stream");
        createReadStream(path.join(speakerModelDir, speakerModelFile))
          .on("error", () => {
            res.statusCode = 404;
            res.end(missing());
          })
          .pipe(res);
      });
    },
    async closeBundle() {
      if (!isBuild) {
        return;
      }
      const outDir = fileURLToPath(new URL("./dist/models/", import.meta.url));
      await mkdir(outDir, { recursive: true });
      try {
        await copyFile(
          path.join(speakerModelDir, speakerModelFile),
          path.join(outDir, speakerModelFile)
        );
      } catch {
        throw new Error(missing());
      }
    }
  };
}

// publicDir: reuse the original demo's public assets — most importantly the
// 38 MB Vosk model archive — instead of duplicating them in the repository.
export default defineConfig({
  publicDir: "../demo/public",
  plugins: [ortWasm(), speakerModel()],
  resolve: {
    alias: {
      // @jaehyun-ko/speaker-verification is a UMD bundle whose external
      // dependency is literally named "ort"; map it to onnxruntime-web.
      ort: "onnxruntime-web"
    }
  }
});
