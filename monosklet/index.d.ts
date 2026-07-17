import type { Model, Module, Recognizer } from "vosklet";

export type Runtime = "singlethread" | "threaded";
export type RuntimeOption = Runtime | "auto";

export interface CreateVoskletMonoOptions {
  /**
   * Which Vosklet runtime to load.
   * - `"singlethread"` (default): works in Android WebView / Capacitor,
   *   no SharedArrayBuffer, COOP, or COEP required.
   * - `"threaded"`: higher throughput, requires cross-origin isolation.
   * - `"auto"`: `"threaded"` when the environment supports it, otherwise
   *   `"singlethread"`.
   *
   * Only one runtime can be loaded per page.
   */
  runtime?: RuntimeOption;
  /** Vosk log level; forwarded to `module.setLogLevel()`. */
  logLevel?: number;
  /** Extra Emscripten module options forwarded to `loadVosklet()`. */
  moduleArg?: Record<string, unknown>;
}

export interface LoadModelOptions {
  /**
   * Location of the Vosk model packaged as a USTAR TAR archive (`.tar`,
   * `.tar.gz`, or `.tgz`). Either a local asset path (e.g.
   * `"/models/es-small.tar"`) or an external URL. Relative paths are
   * resolved against the current page URL.
   */
  url: string;
  /**
   * Stable identifier for the model. Together with `storagePath` it is the
   * Cache Storage key; change it whenever the archive content at the same
   * URL changes.
   */
  id: string;
  /** Directory name the archive expands to inside WasmFS. Default `"model"`. */
  storagePath?: string;
}

export interface CreateRecognizerOptions {
  /** Sample rate of the captured audio, e.g. `audioContext.sampleRate`. */
  sampleRate: number;
  /** Optional Vosk grammar (JSON array string) to constrain recognition. */
  grammar?: string;
}

export interface TranscribeOptions extends CreateRecognizerOptions {
  /** Called with each completed segment's text as recognition progresses. */
  onSegment?: (segment: string) => void;
  /** Called with progress in 0..1 while blocks are being processed. */
  onProgress?: (fraction: number) => void;
  /**
   * Yield to the event loop after this many blocks so the single-thread
   * runtime does not freeze the UI. Default `12`; `0` disables yielding.
   */
  yieldEveryBlocks?: number;
}

export interface TranscribeResult {
  /** All recognized segments joined into one normalized string. */
  text: string;
  /** The individual segment texts, in order. */
  segments: string[];
}

export interface ModelDescriptor {
  url: string;
  id: string;
  storagePath: string;
}

export declare class StreamingRecognizer {
  /** The underlying Vosklet recognizer (escape hatch). */
  readonly raw: Recognizer;
  /** Completed segment texts so far. */
  readonly segments: string[];
  /**
   * Feeds one mono Float32Array PCM block (-1.0..1.0). Returns the text of
   * the segment completed by this block, or `""`.
   */
  accept(block: Float32Array): string;
  /** Flushes the final segment, frees the recognizer, returns the full text. */
  finish(): Promise<string>;
  /** Frees the recognizer without producing a final result. */
  cancel(): Promise<void>;
}

export declare class ModelSession {
  readonly descriptor: ModelDescriptor;
  /** The underlying Vosklet model (escape hatch). */
  readonly raw: Model;
  createRecognizer(options: CreateRecognizerOptions): Promise<StreamingRecognizer>;
  /**
   * Recognizes already-captured audio: a Float32Array or an iterable of
   * Float32Array blocks of mono samples in -1.0..1.0.
   */
  transcribe(
    pcm: Float32Array | Iterable<Float32Array>,
    options: TranscribeOptions
  ): Promise<TranscribeResult>;
  /** Frees the native model memory. The cached archive stays in Cache Storage. */
  unload(): void;
}

export declare class VoskletMono {
  /** The runtime that was actually loaded. */
  readonly runtime: Runtime;
  /** The underlying Vosklet module (escape hatch). */
  readonly module: Module;
  loadModel(options: LoadModelOptions): Promise<ModelSession>;
  /** Vosklet AudioWorklet transferer for microphone PCM capture. */
  createTransferer(
    audioContext: AudioContext,
    bufferSize?: number
  ): Promise<AudioWorkletNode>;
  setLogLevel(level: number): void;
  /** Releases every model and recognizer created by the underlying module. */
  dispose(): Promise<void>;
}

export interface SpeechMonitorOptions {
  /**
   * RMS level (0..1) at or above which a block counts as speech.
   * Default `0.015`.
   */
  speechThreshold?: number;
  /**
   * Milliseconds of continuous silence — after speech has been detected —
   * before `onAutoStop` fires. Default `2000`. Pass a non-finite value
   * (e.g. `Infinity`) to disable the auto-stop and use `stop()` only.
   */
  stopAfterSpoken?: number;
  /** Fired once, on the first block that crosses the speech threshold. */
  onSpeechStart?: (rms: number) => void;
  /** Fired on every block that counts as speech. */
  onSpeech?: (rms: number) => void;
  /**
   * Fired on every silent block after speech, with the milliseconds elapsed
   * since the last speech block — countdown UIs hook in here.
   */
  onSilence?: (silentMilliseconds: number) => void;
  /**
   * Fired when the silence reaches `stopAfterSpoken`, with every block
   * accumulated since monitoring began — hand them to `transcribe()`.
   * The monitor stops itself first, so trailing blocks are dropped.
   */
  onAutoStop?: (
    blocks: Float32Array[],
    info: { silentMilliseconds: number }
  ) => void;
}

export declare class SpeechMonitor {
  /** True once a block has crossed the speech threshold. */
  readonly hasSpoken: boolean;
  /** True after stop() or an auto-stop; push() becomes a no-op. */
  readonly stopped: boolean;
  /** Number of blocks accumulated so far. */
  readonly blockCount: number;
  /** Feeds one mono Float32Array PCM block (-1.0..1.0). */
  push(block: Float32Array): void;
  /**
   * Stops monitoring and returns the accumulated blocks — the manual
   * counterpart of the auto-stop. Returns [] once blocks were handed out.
   */
  stop(): Float32Array[];
  /** Clears all state so the monitor can serve another recording. */
  reset(): void;
}

/**
 * Energy-based speech monitor: feed it captured PCM blocks and it detects
 * speech, tracks silence, and fires `onAutoStop` with the accumulated blocks
 * once the speaker has been silent for `stopAfterSpoken` milliseconds.
 */
export declare function createSpeechMonitor(
  options?: SpeechMonitorOptions
): SpeechMonitor;

/** Root mean square (0..1) of one PCM block — useful for level meters. */
export declare function getRootMeanSquare(samples: Float32Array): number;

/** True when the threaded runtime can run in the current environment. */
export declare function supportsThreadedRuntime(): boolean;

/** Loads the chosen Vosklet runtime and returns the speech engine. */
export declare function createVoskletMono(
  options?: CreateVoskletMonoOptions
): Promise<VoskletMono>;
