import { bootEngine, resolveRuntime, supportsThreadedRuntime } from "./core.js";

export { supportsThreadedRuntime };
export { createSpeechMonitor, getRootMeanSquare } from "./speechMonitor.js";

async function importLoader(runtime) {
  const entry = runtime === "threaded"
    ? await import("vosklet")
    : await import("vosklet/singlethread");
  return entry.loadVosklet;
}

/**
 * Creates the speech engine. Defaults to the single-thread runtime, which
 * works in Android WebView / Capacitor without SharedArrayBuffer, COOP, or
 * COEP. Pass `runtime: "threaded"` for the cross-origin-isolated runtime,
 * or `runtime: "auto"` to pick based on the current environment.
 *
 * This entry keeps the runtime choice dynamic, so bundlers include BOTH
 * runtimes in the application bundle. Apps committed to the single-thread
 * runtime should import "vosklet-mono/singlethread" instead, which ships
 * only that runtime.
 */
export async function createVoskletMono(options = {}) {
  const resolved = resolveRuntime(options.runtime ?? "singlethread");
  return bootEngine(resolved, () => importLoader(resolved), options);
}
