import { defineConfig } from "vite";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(packageDir, "dist");
const monoDir = path.join(outDir, "mono");
const require = createRequire(import.meta.url);
const monoDistDir = path.dirname(require.resolve("monosklet"));

// Vendors the monosklet engine into dist/mono so the published package is
// self-contained — no monosklet dependency for consumers. Only the
// single-thread pieces speaklet uses are copied; the threaded runtime
// (~2.4 MB of wasm) never enters the tarball.
function vendorVoskletMono() {
  return {
    name: "speaklet:vendor-monosklet",
    apply: "build",
    async closeBundle() {
      await mkdir(path.join(monoDir, "runtime"), { recursive: true });

      const files = [
        // Worker engine: worker-host.js is copied verbatim so its literal
        // `new Worker(new URL(...))` / `new URL("./runtime/...", ...)`
        // patterns survive for application bundlers to detect; worker.js and
        // the runtime files sit beside it in the layout those URLs expect.
        "worker-host.js",
        "worker.js",
        // Single-thread entry: createSpeechMonitor (used by startCapture)
        // lives in the shared core chunk copied below.
        "singlethread.js",
        "runtime/index.single.mjs",
        "runtime/Vosklet.single.js",
        "runtime/Vosklet.single.wasm",
        // Type declarations backing the re-exported surface.
        "index.d.ts",
        "singlethread.d.ts",
        "worker-host.d.ts",
        "runtime/Vosklet.d.ts"
      ];
      const chunks = (await readdir(monoDistDir)).filter((name) =>
        /^core-.+\.js$/.test(name)
      );
      for (const name of [...files, ...chunks]) {
        await copyFile(path.join(monoDistDir, name), path.join(monoDir, name));
      }

      // Retarget the public type declarations at the vendored engine.
      const declarations = await readFile(
        path.join(packageDir, "index.d.ts"),
        "utf8"
      );
      await writeFile(
        path.join(outDir, "index.d.ts"),
        declarations
          .replaceAll('"monosklet/worker"', '"./mono/worker-host.js"')
          .replaceAll('"monosklet"', '"./mono/index.js"')
      );
    }
  };
}

export default defineConfig({
  plugins: [vendorVoskletMono()],
  build: {
    outDir,
    emptyOutDir: true,
    target: "es2020",
    lib: {
      entry: { index: path.join(packageDir, "src/index.js") },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`
    },
    rollupOptions: {
      external: [
        "onnxruntime-web",
        "@jaehyun-ko/speaker-verification",
        "monosklet/worker",
        "monosklet/singlethread"
      ],
      output: {
        paths: {
          "monosklet/worker": "./mono/worker-host.js",
          "monosklet/singlethread": "./mono/singlethread.js"
        }
      }
    }
  }
});
