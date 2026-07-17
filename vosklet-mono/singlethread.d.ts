import type { CreateVoskletMonoOptions, VoskletMono } from "./index";

export type {
  CreateRecognizerOptions,
  CreateVoskletMonoOptions,
  LoadModelOptions,
  ModelDescriptor,
  Runtime,
  RuntimeOption,
  SpeechMonitorOptions,
  TranscribeOptions,
  TranscribeResult
} from "./index";
export {
  ModelSession,
  SpeechMonitor,
  StreamingRecognizer,
  VoskletMono,
  createSpeechMonitor,
  getRootMeanSquare,
  supportsThreadedRuntime
} from "./index";

export interface CreateSinglethreadOptions
  extends Omit<CreateVoskletMonoOptions, "runtime"> {
  /** This entry ships only the single-thread runtime. */
  runtime?: "singlethread";
}

/**
 * Single-thread-only entry: bundlers include just the single-thread Vosklet
 * runtime, keeping the threaded `.wasm` out of the application bundle.
 */
export declare function createVoskletMono(
  options?: CreateSinglethreadOptions
): Promise<VoskletMono>;
