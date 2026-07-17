import { defineConfig } from "vite";
import { copyFile, mkdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// onnxruntime-web's exports map does not expose its .wasm binaries, so Vite
// cannot import them as assets. Serve them in dev and copy them into the
// build output instead; src/speaker.js points ort.env.wasm.wasmPaths at
// "ort/". Only the single-threaded binaries are shipped — WebView has no
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

// publicDir: reuse the original demo's public assets — most importantly the
// 38 MB Vosk model archive — instead of duplicating them in the repository.
export default defineConfig({
  publicDir: "../demo/public",
  plugins: [ortWasm()],
  resolve: {
    alias: {
      // @jaehyun-ko/speaker-verification is a UMD bundle whose external
      // dependency is literally named "ort"; map it to onnxruntime-web.
      ort: "onnxruntime-web"
    }
  }
});
