import type {
  LoadModelOptions,
  ModelDescriptor,
  TranscribeResult
} from "./index";

export type {
  LoadModelOptions,
  ModelDescriptor,
  TranscribeResult
} from "./index";

export interface CreateWorkerOptions {
  /** Vosk log level; forwarded to the runtime inside the worker. */
  logLevel?: number;
  /** Override the URL of the worker script (dist/worker.js). */
  workerUrl?: string | URL;
  /** Override the URL of the Emscripten glue (dist/runtime/Vosklet.single.js). */
  glueUrl?: string;
  /** Override the URL of the wasm binary (dist/runtime/Vosklet.single.wasm). */
  wasmUrl?: string;
}

export interface WorkerCreateRecognizerOptions {
  /** Sample rate of the captured audio, e.g. `audioContext.sampleRate`. */
  sampleRate: number;
  /** Optional Vosk grammar (JSON array string) to constrain recognition. */
  grammar?: string;
}

export interface WorkerTranscribeOptions extends WorkerCreateRecognizerOptions {
  /** Called with each completed segment's text as recognition progresses. */
  onSegment?: (segment: string) => void;
  /** Called with progress in 0..1 while blocks are being processed. */
  onProgress?: (fraction: number) => void;
  /**
   * Transfer block buffers to the worker instead of copying them (default
   * true). Transferred arrays are neutered on the calling thread; pass
   * false to keep using them after the call.
   */
  transfer?: boolean;
  /** Post a progress message after this many blocks. Default `12`. */
  progressEveryBlocks?: number;
}

export declare class WorkerStreamingRecognizer {
  /** Completed segment texts so far. */
  readonly segments: string[];
  /**
   * Feeds one mono Float32Array PCM block. Recognition happens in the
   * worker, so accept() is asynchronous — it resolves with the completed
   * segment's text, or `""` mid-utterance.
   */
  accept(block: Float32Array, options?: { transfer?: boolean }): Promise<string>;
  /** Flushes the final segment, frees the recognizer, returns the full text. */
  finish(): Promise<string>;
  /** Frees the recognizer without producing a final result. */
  cancel(): Promise<void>;
}

export declare class WorkerModelSession {
  readonly descriptor: ModelDescriptor;
  createRecognizer(
    options: WorkerCreateRecognizerOptions
  ): Promise<WorkerStreamingRecognizer>;
  /** Recognizes already-captured audio in the worker. */
  transcribe(
    pcm: Float32Array | Iterable<Float32Array>,
    options: WorkerTranscribeOptions
  ): Promise<TranscribeResult>;
  /** Frees the native model memory in the worker; the cached archive stays. */
  unload(): void;
}

export declare class WorkerVoskletMono {
  /** The worker always runs the single-thread runtime. */
  readonly runtime: "singlethread";
  /** Distinguishes this engine from the main-thread one. */
  readonly host: "worker";
  loadModel(options: LoadModelOptions): Promise<WorkerModelSession>;
  /** Main-thread AudioWorklet transferer for microphone PCM capture. */
  createTransferer(
    audioContext: AudioContext,
    bufferSize?: number
  ): Promise<AudioWorkletNode>;
  setLogLevel(level: number): void;
  /** Releases every model and recognizer, then terminates the worker. */
  dispose(): Promise<void>;
  /** Hard-stops the worker immediately; the engine is unusable afterwards. */
  terminate(): void;
}

/** True when this environment can host the worker engine. */
export declare function supportsWorkerHost(): boolean;

/**
 * Boots the single-thread Vosklet runtime inside a dedicated Web Worker —
 * no SharedArrayBuffer, COOP, or COEP needed — and returns an engine with
 * the same shape as createVoskletMono(). Recognition runs off the UI
 * thread, so the page stays responsive during long transcriptions.
 */
export declare function createVoskletMonoWorker(
  options?: CreateWorkerOptions
): Promise<WorkerVoskletMono>;
