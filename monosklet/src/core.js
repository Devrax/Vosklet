const RUNTIMES = new Set(["singlethread", "threaded", "auto"]);

// Both Vosklet runtimes register the same `globalThis.loadVosklet` entry
// point, so a page can only ever host one of them.
let activeRuntime;
let activeModulePromise;

export function supportsThreadedRuntime() {
  if (typeof SharedArrayBuffer !== "function") {
    return false;
  }
  return typeof globalThis.crossOriginIsolated === "boolean"
    ? globalThis.crossOriginIsolated
    : true;
}

export function resolveRuntime(runtime) {
  if (!RUNTIMES.has(runtime)) {
    throw new TypeError(
      `Unknown runtime "${runtime}". Expected "singlethread", "threaded", or "auto".`
    );
  }
  if (runtime === "auto") {
    return supportsThreadedRuntime() ? "threaded" : "singlethread";
  }
  return runtime;
}

function parseSegment(raw) {
  try {
    const parsed = JSON.parse(raw);
    return { text: (parsed.text ?? parsed.partial ?? "").trim(), raw: parsed };
  } catch {
    return { text: (raw ?? "").trim(), raw };
  }
}

function toBlockList(pcm) {
  if (pcm instanceof Float32Array) {
    return [pcm];
  }
  const blocks = Array.from(pcm);
  for (const block of blocks) {
    if (!(block instanceof Float32Array)) {
      throw new TypeError(
        "transcribe() expects a Float32Array or an iterable of Float32Array blocks."
      );
    }
  }
  return blocks;
}

function yieldToEventLoop() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

class StreamingRecognizer {
  #recognizer;
  #finished = false;
  #segments = [];

  constructor(recognizer) {
    this.#recognizer = recognizer;
  }

  /** Direct access to the underlying Vosklet recognizer. */
  get raw() {
    return this.#recognizer;
  }

  get segments() {
    return [...this.#segments];
  }

  /**
   * Feeds one mono Float32Array PCM block (-1.0..1.0). Returns the text of
   * the segment Vosk completed with this block, or "" when the utterance is
   * still in progress.
   */
  accept(block) {
    if (this.#finished) {
      throw new Error("Recognizer already finished. Create a new one.");
    }
    const { text } = parseSegment(this.#recognizer.acceptWaveform(block));
    if (text) {
      this.#segments.push(text);
    }
    return text;
  }

  /**
   * Flushes the final segment, deletes the native recognizer, and returns
   * the full recognized text.
   */
  async finish() {
    if (this.#finished) {
      throw new Error("Recognizer already finished.");
    }
    this.#finished = true;
    try {
      const { text } = parseSegment(this.#recognizer.finalResult());
      if (text) {
        this.#segments.push(text);
      }
    } finally {
      await this.#recognizer.delete();
    }
    return this.#segments.join(" ").replace(/\s+/g, " ").trim();
  }

  /** Discards the recognizer without producing a final result. */
  async cancel() {
    if (this.#finished) {
      return;
    }
    this.#finished = true;
    await this.#recognizer.delete();
  }
}

class ModelSession {
  #module;
  #model;
  #descriptor;
  #unloaded = false;

  constructor(module, model, descriptor) {
    this.#module = module;
    this.#model = model;
    this.#descriptor = descriptor;
  }

  get descriptor() {
    return { ...this.#descriptor };
  }

  /** Direct access to the underlying Vosklet model. */
  get raw() {
    return this.#model;
  }

  #assertLoaded() {
    if (this.#unloaded) {
      throw new Error(
        `Model "${this.#descriptor.id}" was unloaded. Call loadModel() again.`
      );
    }
  }

  async createRecognizer({ sampleRate, grammar } = {}) {
    this.#assertLoaded();
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new TypeError(
        "createRecognizer() requires the sampleRate of the captured audio, e.g. audioContext.sampleRate."
      );
    }
    const recognizer = grammar
      ? await this.#module.createRecognizerWithGrm(this.#model, sampleRate, grammar)
      : await this.#module.createRecognizer(this.#model, sampleRate);
    return new StreamingRecognizer(recognizer);
  }

  /**
   * Recognizes already-captured audio. `pcm` is a Float32Array or an
   * iterable of Float32Array blocks of mono samples in -1.0..1.0, captured
   * by the application at `sampleRate`.
   */
  async transcribe(pcm, options = {}) {
    const {
      sampleRate,
      grammar,
      onSegment,
      onProgress,
      yieldEveryBlocks = 12
    } = options;
    const blocks = toBlockList(pcm);
    const recognizer = await this.createRecognizer({ sampleRate, grammar });
    try {
      for (let index = 0; index < blocks.length; index += 1) {
        const segment = recognizer.accept(blocks[index]);
        if (segment) {
          onSegment?.(segment);
        }
        if (yieldEveryBlocks > 0 && index % yieldEveryBlocks === 0) {
          onProgress?.((index + 1) / blocks.length);
          // The single-thread runtime recognizes on the UI thread; yielding
          // keeps the WebView responsive during long recordings.
          await yieldToEventLoop();
        }
      }
      const text = await recognizer.finish();
      onProgress?.(1);
      return { text, segments: recognizer.segments };
    } catch (error) {
      await recognizer.cancel();
      throw error;
    }
  }

  /** Frees the native model memory. The cached archive stays in Cache Storage. */
  unload() {
    if (this.#unloaded) {
      return;
    }
    this.#unloaded = true;
    this.#model.delete();
  }
}

class VoskletMono {
  #module;
  #runtime;

  constructor(module, runtime) {
    this.#module = module;
    this.#runtime = runtime;
  }

  /** The runtime that was actually loaded: "singlethread" or "threaded". */
  get runtime() {
    return this.#runtime;
  }

  /** Direct access to the underlying Vosklet module (escape hatch). */
  get module() {
    return this.#module;
  }

  /**
   * Loads a Vosk model on demand from a local asset or an external URL.
   * `url` must point at a USTAR TAR archive (.tar, .tar.gz, or .tgz).
   * `id` is the cache key together with `storagePath`; change it whenever
   * the archive content at the same URL changes.
   */
  async loadModel({ url, id, storagePath = "model" } = {}) {
    if (!url) {
      throw new TypeError("loadModel() requires a model archive `url`.");
    }
    if (!id) {
      throw new TypeError(
        "loadModel() requires a stable model `id` (used as the cache key)."
      );
    }
    const resolvedUrl = globalThis.location
      ? new URL(url, globalThis.location.href).href
      : url;
    const model = await this.#module.createModel(resolvedUrl, storagePath, id);
    return new ModelSession(this.#module, model, {
      url: resolvedUrl,
      id,
      storagePath
    });
  }

  /**
   * Convenience wrapper around Vosklet's AudioWorklet transferer for apps
   * that capture microphone PCM through an AudioContext.
   */
  createTransferer(audioContext, bufferSize = 128 * 15) {
    return this.#module.createTransferer(audioContext, bufferSize);
  }

  setLogLevel(level) {
    this.#module.setLogLevel(level);
  }

  /** Releases every model and recognizer created by the underlying module. */
  async dispose() {
    await this.#module.cleanUp();
  }
}

/**
 * Boots the engine for an already-resolved runtime. `loadRuntime` is
 * supplied by the entry module so bundlers only see the dynamic imports
 * that entry actually needs.
 */
export async function bootEngine(resolved, loadRuntime, options = {}) {
  const { logLevel, moduleArg = {} } = options;
  if (activeRuntime && activeRuntime !== resolved) {
    throw new Error(
      `The "${activeRuntime}" runtime is already loaded on this page; ` +
        `a page cannot host both Vosklet runtimes. Requested: "${resolved}".`
    );
  }
  activeRuntime = resolved;
  activeModulePromise ??= loadRuntime().then((load) => load(moduleArg));
  let module;
  try {
    module = await activeModulePromise;
  } catch (error) {
    activeRuntime = undefined;
    activeModulePromise = undefined;
    throw error;
  }
  if (typeof logLevel === "number") {
    module.setLogLevel(logLevel);
  }
  return new VoskletMono(module, resolved);
}
