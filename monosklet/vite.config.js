import { defineConfig, transformWithEsbuild } from "vite";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(packageDir, "dist");
const runtimeDir = path.join(outDir, "runtime");
const require = createRequire(import.meta.url);
const voskletDir = path.dirname(require.resolve("vosklet"));

// Copies the Vosklet runtime into dist/runtime so the published package is
// self-contained. The ESM loaders resolve Vosklet.js / *.wasm relative to
// their own import.meta.url, so the flat side-by-side layout must be kept.
function bundleVoskletRuntime() {
  async function minify(name, options) {
    const source = await readFile(path.join(voskletDir, name), "utf8");
    const { code } = await transformWithEsbuild(source, name, {
      target: "es2020",
      sourcemap: false,
      ...options
    });
    await writeFile(path.join(runtimeDir, name), code);
  }

  return {
    name: "monosklet:bundle-vosklet-runtime",
    apply: "build",
    async closeBundle() {
      await mkdir(runtimeDir, { recursive: true });

      // ESM loaders: full minification.
      await minify("index.mjs", { minify: true, format: "esm" });
      await minify("index.single.mjs", { minify: true, format: "esm" });

      // Emscripten glue: classic scripts exposing the global `loadVosklet`,
      // so top-level identifiers must survive minification.
      const classicScript = {
        minifyWhitespace: true,
        minifySyntax: true,
        minifyIdentifiers: false
      };
      await minify("Vosklet.js", classicScript);
      await minify("Vosklet.single.js", classicScript);

      // Wasm binaries are already optimized by the Emscripten build.
      await copyFile(
        path.join(voskletDir, "Vosklet.wasm"),
        path.join(runtimeDir, "Vosklet.wasm")
      );
      await copyFile(
        path.join(voskletDir, "Vosklet.single.wasm"),
        path.join(runtimeDir, "Vosklet.single.wasm")
      );
      await copyFile(
        path.join(voskletDir, "Vosklet.d.ts"),
        path.join(runtimeDir, "Vosklet.d.ts")
      );

      // Worker host: shipped verbatim (minified, not bundled) so the literal
      // `new Worker(new URL(...))` / `new URL("./runtime/...", ...)` patterns
      // survive for application bundlers to detect. The worker itself is a
      // classic script (importScripts) and must stay a standalone file.
      async function minifyPackageSource(srcName, outName, options) {
        const source = await readFile(
          path.join(packageDir, "src", srcName),
          "utf8"
        );
        const { code } = await transformWithEsbuild(source, srcName, {
          target: "es2020",
          sourcemap: false,
          minify: true,
          ...options
        });
        await writeFile(path.join(outDir, outName), code);
      }
      await minifyPackageSource("worker.js", "worker.js", {
        // Classic script exposing handlers via self.onmessage; nothing to
        // rename at the top level, but keep globals untouched regardless.
        minifyIdentifiers: false,
        minify: false,
        minifyWhitespace: true,
        minifySyntax: true
      });
      await minifyPackageSource("workerHost.js", "worker-host.js", {
        format: "esm"
      });
      await copyFile(
        path.join(packageDir, "worker-host.d.ts"),
        path.join(outDir, "worker-host.d.ts")
      );

      // Retarget the public type declarations at the vendored runtime types.
      const declarations = await readFile(
        path.join(packageDir, "index.d.ts"),
        "utf8"
      );
      await writeFile(
        path.join(outDir, "index.d.ts"),
        declarations.replace('from "vosklet"', 'from "./runtime/Vosklet"')
      );
      await copyFile(
        path.join(packageDir, "singlethread.d.ts"),
        path.join(outDir, "singlethread.d.ts")
      );
    }
  };
}

export default defineConfig({
  plugins: [bundleVoskletRuntime()],
  build: {
    outDir,
    emptyOutDir: true,
    target: "es2020",
    lib: {
      entry: {
        index: path.join(packageDir, "src/index.js"),
        singlethread: path.join(packageDir, "src/singlethread.js")
      },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`
    },
    rollupOptions: {
      external: ["vosklet", "vosklet/singlethread"],
      output: {
        chunkFileNames: "core-[hash].js",
        paths: {
          vosklet: "./runtime/index.mjs",
          "vosklet/singlethread": "./runtime/index.single.mjs"
        }
      }
    }
  }
});
