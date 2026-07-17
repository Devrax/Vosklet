/**
 * Worker host: runs the single-thread Vosklet runtime inside a dedicated Web
 * Worker and proxies the vosklet-mono API to it over postMessage. Dedicated
 * workers need no SharedArrayBuffer, COOP, or COEP, so recognition moves off
 * the UI thread in exactly the environments the single-thread runtime
 * targets: Android WebView, Capacitor, and iOS WKWebView.
 *
 * This module is shipped verbatim (minified, not bundled) so the literal
 * `new Worker(new URL("./worker.js", import.meta.url))` and
 * `new URL("./runtime/...", import.meta.url)` patterns survive into the
 * application build, where bundlers (Vite, webpack 5) detect them and copy
 * the worker and runtime files. Keep this file free of imports.
 */

/** True when this environment can host the worker engine. */
export function supportsWorkerHost() {
  return typeof Worker === "function";
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

function assertSampleRate(sampleRate) {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new TypeError(
      "createRecognizer() requires the sampleRate of the captured audio, e.g. audioContext.sampleRate."
    );
  }
}

function transferListFor(blocks) {
  // A buffer may back several blocks; a duplicate in the transfer list
  // throws a DataCloneError.
  return [...new Set(blocks.map((block) => block.buffer))];
}

class WorkerRpc {
  #worker;
  #pending = new Map();
  #nextCallId = 1;

  constructor(worker) {
    this.#worker = worker;
    worker.onmessage = (event) => {
      const { type, callId } = event.data;
      const pending = this.#pending.get(callId);
      if (!pending) {
        return;
      }
      if (type === "result") {
        this.#pending.delete(callId);
        pending.resolve(event.data.result);
      } else if (type === "error") {
        this.#pending.delete(callId);
        pending.reject(new Error(event.data.message));
      } else if (type === "progress") {
        pending.onProgress?.(event.data.fraction);
      } else if (type === "segment") {
        pending.onSegment?.(event.data.segment);
      }
    };
    worker.onerror = (event) => {
      this.#rejectAll(new Error("Vosklet worker error: " + (event.message || "unknown")));
    };
    worker.onmessageerror = () => {
      this.#rejectAll(new Error("Vosklet worker message could not be deserialized."));
    };
  }

  get worker() {
    return this.#worker;
  }

  #rejectAll(error) {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }

  call(type, payload = {}, { transfer = [], onProgress, onSegment } = {}) {
    return new Promise((resolve, reject) => {
      const callId = this.#nextCallId++;
      this.#pending.set(callId, { resolve, reject, onProgress, onSegment });
      this.#worker.postMessage({ type, callId, ...payload }, transfer);
    });
  }

  terminate() {
    this.#worker.terminate();
    this.#rejectAll(new Error("Vosklet worker was terminated."));
  }
}

// Worker-side ids of the speaker-model sessions, kept out of the public
// surface of WorkerSpkModelSession.
const spkModelIds = new WeakMap();

class WorkerSpkModelSession {
  #rpc;
  #descriptor;
  #unloaded = false;

  constructor(rpc, spkModelId, descriptor) {
    this.#rpc = rpc;
    this.#descriptor = descriptor;
    spkModelIds.set(this, spkModelId);
  }

  get descriptor() {
    return { ...this.#descriptor };
  }

  assertLoaded() {
    if (this.#unloaded) {
      throw new Error(
        `Speaker model "${this.#descriptor.id}" was unloaded. Call loadSpkModel() again.`
      );
    }
  }

  /** Frees the native speaker-model memory in the worker; the cached archive stays. */
  unload() {
    if (this.#unloaded) {
      return;
    }
    this.#unloaded = true;
    void this.#rpc.call("unloadSpkModel", { spkModelId: spkModelIds.get(this) });
  }
}

function resolveSpkModelId(speakerModel) {
  if (speakerModel == null) {
    return undefined;
  }
  if (!(speakerModel instanceof WorkerSpkModelSession)) {
    throw new TypeError(
      "speakerModel must be a session returned by engine.loadSpkModel()."
    );
  }
  speakerModel.assertLoaded();
  return spkModelIds.get(speakerModel);
}

class WorkerStreamingRecognizer {
  #rpc;
  #recognizerId;
  #segments = [];
  #speakerVectors = [];
  #finished = false;

  constructor(rpc, recognizerId) {
    this.#rpc = rpc;
    this.#recognizerId = recognizerId;
  }

  get segments() {
    return [...this.#segments];
  }

  /**
   * Speaker x-vectors collected so far — one per completed utterance, only
   * when the recognizer was created with a `speakerModel`. Complete after
   * finish() resolves.
   */
  get speakerVectors() {
    return [...this.#speakerVectors];
  }

  /**
   * Feeds one mono Float32Array PCM block. Unlike the main-thread engine,
   * recognition happens in the worker, so accept() is asynchronous and
   * resolves with the completed segment's text, or "" mid-utterance.
   */
  async accept(block, { transfer = true } = {}) {
    if (this.#finished) {
      throw new Error("Recognizer already finished. Create a new one.");
    }
    const { segment } = await this.#rpc.call(
      "accept",
      { recognizerId: this.#recognizerId, block },
      { transfer: transfer ? transferListFor([block]) : [] }
    );
    if (segment) {
      this.#segments.push(segment);
    }
    return segment;
  }

  /** Flushes the final segment, frees the recognizer, returns the full text. */
  async finish() {
    if (this.#finished) {
      throw new Error("Recognizer already finished.");
    }
    this.#finished = true;
    const { text, segments, speakerVectors } = await this.#rpc.call("finishRecognizer", {
      recognizerId: this.#recognizerId
    });
    this.#segments = segments;
    this.#speakerVectors = speakerVectors ?? [];
    return text;
  }

  /** Discards the recognizer without producing a final result. */
  async cancel() {
    if (this.#finished) {
      return;
    }
    this.#finished = true;
    await this.#rpc.call("cancelRecognizer", { recognizerId: this.#recognizerId });
  }
}

class WorkerModelSession {
  #rpc;
  #modelId;
  #descriptor;
  #unloaded = false;

  constructor(rpc, modelId, descriptor) {
    this.#rpc = rpc;
    this.#modelId = modelId;
    this.#descriptor = descriptor;
  }

  get descriptor() {
    return { ...this.#descriptor };
  }

  #assertLoaded() {
    if (this.#unloaded) {
      throw new Error(
        `Model "${this.#descriptor.id}" was unloaded. Call loadModel() again.`
      );
    }
  }

  async createRecognizer({ sampleRate, grammar, speakerModel } = {}) {
    this.#assertLoaded();
    assertSampleRate(sampleRate);
    const { recognizerId } = await this.#rpc.call("createRecognizer", {
      modelId: this.#modelId,
      sampleRate,
      grammar,
      spkModelId: resolveSpkModelId(speakerModel)
    });
    return new WorkerStreamingRecognizer(this.#rpc, recognizerId);
  }

  /**
   * Recognizes already-captured audio in the worker. Same contract as the
   * main-thread transcribe(), plus `transfer` (default true): block buffers
   * are transferred to the worker instead of copied, so the arrays are
   * neutered on this thread afterwards — pass `transfer: false` to keep
   * using them. With a `speakerModel` (from engine.loadSpkModel()), the
   * result also carries `speakerVectors`: one x-vector per completed
   * utterance, for speaker identification.
   */
  async transcribe(pcm, options = {}) {
    this.#assertLoaded();
    const {
      sampleRate,
      grammar,
      speakerModel,
      onSegment,
      onProgress,
      transfer = true,
      progressEveryBlocks = 12
    } = options;
    assertSampleRate(sampleRate);
    const blocks = toBlockList(pcm);
    return this.#rpc.call(
      "transcribe",
      {
        modelId: this.#modelId,
        blocks,
        sampleRate,
        grammar,
        spkModelId: resolveSpkModelId(speakerModel),
        progressEveryBlocks
      },
      {
        transfer: transfer ? transferListFor(blocks) : [],
        onProgress,
        onSegment
      }
    );
  }

  /** Frees the native model memory in the worker; the cached archive stays. */
  unload() {
    if (this.#unloaded) {
      return;
    }
    this.#unloaded = true;
    void this.#rpc.call("unloadModel", { modelId: this.#modelId });
  }
}

// The AudioWorklet transferer must live on the main thread (workers have no
// AudioContext), so the worker host ships its own copy of Vosklet's
// processor instead of proxying createTransferer to the worker.
let processorUrl;
function getProcessorUrl() {
  processorUrl ??= URL.createObjectURL(
    new Blob(
      [
        "(",
        (() => {
          registerProcessor(
            "VoskletMonoTransferer",
            class extends AudioWorkletProcessor {
              constructor(opts) {
                super();
                this.filled = 0;
                this.bufSize = opts.processorOptions[0];
                this.buf = new Float32Array(this.bufSize);
              }
              process(inputs) {
                if (inputs[0][0]) {
                  this.buf.set(inputs[0][0], this.filled);
                  this.filled += 128;
                  if (this.filled >= this.bufSize) {
                    this.filled = 0;
                    this.port.postMessage(this.buf, [this.buf.buffer]);
                    this.buf = new Float32Array(this.bufSize);
                  }
                }
                return true;
              }
            }
          );
        }).toString(),
        ")()"
      ],
      { type: "text/javascript" }
    )
  );
  return processorUrl;
}

class WorkerVoskletMono {
  #rpc;

  constructor(rpc) {
    this.#rpc = rpc;
  }

  /** The worker always runs the single-thread runtime. */
  get runtime() {
    return "singlethread";
  }

  /** Distinguishes this engine from the main-thread one. */
  get host() {
    return "worker";
  }

  async loadModel({ url, id, storagePath = "model" } = {}) {
    if (!url) {
      throw new TypeError("loadModel() requires a model archive `url`.");
    }
    if (!id) {
      throw new TypeError(
        "loadModel() requires a stable model `id` (used as the cache key)."
      );
    }
    // Resolve against the page URL here — inside the worker, relative URLs
    // would resolve against the worker script's location instead.
    const resolvedUrl = globalThis.location
      ? new URL(url, globalThis.location.href).href
      : url;
    const { modelId } = await this.#rpc.call("loadModel", {
      url: resolvedUrl,
      id,
      storagePath
    });
    return new WorkerModelSession(this.#rpc, modelId, {
      url: resolvedUrl,
      id,
      storagePath
    });
  }

  /**
   * Loads a Vosk speaker-identification model (e.g. vosk-model-spk-0.4) in
   * the worker, from the same USTAR TAR archive pipeline as loadModel().
   * Pass the returned session as `speakerModel` to createRecognizer() or
   * transcribe() to receive per-utterance x-vectors.
   */
  async loadSpkModel({ url, id, storagePath = "spk-model" } = {}) {
    if (!url) {
      throw new TypeError("loadSpkModel() requires a model archive `url`.");
    }
    if (!id) {
      throw new TypeError(
        "loadSpkModel() requires a stable model `id` (used as the cache key)."
      );
    }
    const resolvedUrl = globalThis.location
      ? new URL(url, globalThis.location.href).href
      : url;
    const { spkModelId } = await this.#rpc.call("loadSpkModel", {
      url: resolvedUrl,
      id,
      storagePath
    });
    return new WorkerSpkModelSession(this.#rpc, spkModelId, {
      url: resolvedUrl,
      id,
      storagePath
    });
  }

  /** Main-thread AudioWorklet transferer for microphone PCM capture. */
  async createTransferer(audioContext, bufferSize = 128 * 15) {
    await audioContext.audioWorklet.addModule(getProcessorUrl());
    return new AudioWorkletNode(audioContext, "VoskletMonoTransferer", {
      channelCountMode: "explicit",
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      processorOptions: [bufferSize]
    });
  }

  setLogLevel(level) {
    void this.#rpc.call("setLogLevel", { level });
  }

  /** Releases every model and recognizer, then terminates the worker. */
  async dispose() {
    try {
      await this.#rpc.call("dispose");
    } finally {
      this.terminate();
    }
  }

  /** Hard-stops the worker immediately; the engine is unusable afterwards. */
  terminate() {
    this.#rpc.terminate();
  }
}

/**
 * Boots the single-thread Vosklet runtime inside a dedicated Web Worker and
 * returns an engine with the same shape as createVoskletMono() — recognition
 * runs off the UI thread, so no cooperative yielding is needed and the page
 * stays responsive during long transcriptions.
 *
 * Options: `logLevel`, plus `workerUrl` / `glueUrl` / `wasmUrl` overrides for
 * bundler setups where the automatic URL resolution does not apply.
 */
export async function createVoskletMonoWorker(options = {}) {
  if (!supportsWorkerHost()) {
    throw new Error(
      "Web Workers are unavailable here; use createVoskletMono() from vosklet-mono/singlethread instead."
    );
  }
  const worker = options.workerUrl
    ? new Worker(options.workerUrl)
    : new Worker(new URL("./worker.js", import.meta.url));
  const rpc = new WorkerRpc(worker);
  try {
    await rpc.call("init", {
      glueUrl:
        options.glueUrl ??
        new URL("./runtime/Vosklet.single.js", import.meta.url).href,
      wasmUrl:
        options.wasmUrl ??
        new URL("./runtime/Vosklet.single.wasm", import.meta.url).href,
      logLevel: options.logLevel
    });
  } catch (error) {
    rpc.terminate();
    throw error;
  }
  return new WorkerVoskletMono(rpc);
}
