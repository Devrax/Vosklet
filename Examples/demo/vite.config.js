import { defineConfig } from "vite";
import { copyFile, mkdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.dirname(fileURLToPath(import.meta.url));

// onnxruntime-web's exports map does not expose its .wasm binaries, so Vite
// cannot import them as assets. Serve them in dev and copy them into the
// build output instead; the speaker example points ort.env.wasm.wasmPaths at
// "/ort/". Only the single-threaded binaries are shipped — WebView has no
// SharedArrayBuffer, so the threaded variants could never load anyway.
const ortWasmDir = path.join(appDir, "node_modules/onnxruntime-web/dist/");
const ortWasmFiles = ["ort-wasm-simd.wasm", "ort-wasm.wasm"];

function ortWasm() {
  let isBuild = false;
  return {
    name: "demo:ort-wasm",
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
      const outDir = path.join(appDir, "dist/ort/");
      await mkdir(outDir, { recursive: true });
      for (const name of ortWasmFiles) {
        await copyFile(path.join(ortWasmDir, name), path.join(outDir, name));
      }
    }
  };
}

// The NeXt-TDNN speaker model is consumed locally (no Hugging Face at
// runtime) but too large to commit: models/ is gitignored, so serve it in
// dev and copy it into the build from there. Fetch it with
// `pnpm run fetch:models` at the repository root.
const speakerModelFile = "NeXt_TDNN_C384_B1_K65_7.onnx";
const speakerModelDir = path.join(appDir, "models/");

function speakerModel() {
  let isBuild = false;
  const missing = () =>
    `${path.join(speakerModelDir, speakerModelFile)} is missing — run ` +
    `"pnpm run fetch:models" at the repository root first.`;
  return {
    name: "demo:speaker-model",
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
      const outDir = path.join(appDir, "dist/models/");
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

// One app, five pages: a home page routing to the four examples. Each
// example page keeps its own entry so bundlers only load the engine that
// page actually uses.
export default defineConfig({
  plugins: [ortWasm(), speakerModel()],
  resolve: {
    alias: {
      // @jaehyun-ko/speaker-verification is a UMD bundle whose external
      // dependency is literally named "ort"; map it to onnxruntime-web.
      ort: "onnxruntime-web"
    }
  },
  build: {
    rollupOptions: {
      input: {
        home: path.join(appDir, "index.html"),
        challenge: path.join(appDir, "challenge/index.html"),
        worker: path.join(appDir, "worker/index.html"),
        speaker: path.join(appDir, "speaker/index.html"),
        spk: path.join(appDir, "spk/index.html")
      }
    }
  }
});
