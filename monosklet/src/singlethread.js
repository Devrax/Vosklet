import { bootEngine, supportsThreadedRuntime } from "./core.js";

export { supportsThreadedRuntime };
export { createSpeechMonitor, getRootMeanSquare } from "./speechMonitor.js";

/**
 * Single-thread-only entry. Bundlers following this module pull in just the
 * single-thread Vosklet runtime, keeping the threaded `.wasm` (~2.4 MB) out
 * of the application bundle entirely — the right entry for Android WebView,
 * Capacitor, and any other non-cross-origin-isolated deployment.
 */
export async function createVoskletMono(options = {}) {
  if (options.runtime && options.runtime !== "singlethread") {
    throw new TypeError(
      `The "monosklet/singlethread" entry only ships the single-thread ` +
        `runtime; import "monosklet" to use runtime "${options.runtime}".`
    );
  }
  return bootEngine(
    "singlethread",
    async () => (await import("vosklet/singlethread")).loadVosklet,
    options
  );
}
