import type {
  LoadModelOptions,
  SpeechMonitorOptions,
  TranscribeResult
} from "vosklet-mono";
import type {
  CreateWorkerOptions,
  WorkerTranscribeOptions
} from "vosklet-mono/worker";

// The speech engine is bundled into this package; its factory and the option
// types apps typically need are re-exported so vosklet-mono itself is never a
// required install.
export { createVoskletMonoWorker, supportsWorkerHost } from "vosklet-mono/worker";
export type { CreateWorkerOptions, WorkerTranscribeOptions } from "vosklet-mono/worker";
export type {
  LoadModelOptions,
  SpeechMonitorOptions,
  TranscribeResult
} from "vosklet-mono";

/**
 * Structural view of a vosklet-mono engine — both createVoskletMono() and
 * createVoskletMonoWorker() results satisfy it.
 */
export interface SpeechEngine {
  loadModel(options: LoadModelOptions): Promise<SpeechSession>;
  createTransferer(
    audioContext: AudioContext,
    bufferSize?: number
  ): Promise<AudioWorkletNode>;
  dispose(): Promise<void>;
}

/** Structural view of a vosklet-mono model session. */
export interface SpeechSession {
  transcribe(
    pcm: Float32Array | Iterable<Float32Array>,
    options: WorkerTranscribeOptions
  ): Promise<TranscribeResult>;
  unload(): void;
}

// ---------------------------------------------------------------------------
// Audio helpers
// ---------------------------------------------------------------------------

/** Encodes mono Float32Array PCM blocks as a 16-bit WAV blob. */
export declare function encodeWav(blocks: Float32Array[], sampleRate: number): Blob;

// ---------------------------------------------------------------------------
// Text matching
// ---------------------------------------------------------------------------

export interface NormalizeTextOptions {
  /** Locale for lowercasing. Default `"es-ES"`. */
  locale?: string;
}

/** Lowercases, strips diacritics and punctuation, and collapses whitespace. */
export declare function normalizeText(text: string, options?: NormalizeTextOptions): string;

/** True when both texts are non-empty and equal after normalization. */
export declare function textsMatch(
  expected: string,
  recognized: string,
  options?: NormalizeTextOptions
): boolean;

/** Bag-of-words overlap (0..1) of the expected words found in the recognized text. */
export declare function wordOverlap(
  expected: string,
  recognized: string,
  options?: NormalizeTextOptions
): number;

// ---------------------------------------------------------------------------
// Microphone capture
// ---------------------------------------------------------------------------

export interface CaptureOptions
  extends Pick<
    SpeechMonitorOptions,
    "speechThreshold" | "stopAfterSpoken" | "onSpeechStart" | "onSpeech" | "onSilence"
  > {
  /** Reuse this AudioContext instead of creating (and later closing) one. */
  audioContext?: AudioContext;
  /** Capture from this stream instead of calling getUserMedia(). */
  stream?: MediaStream;
  /** getUserMedia() audio constraints when no stream is given. */
  audio?: MediaTrackConstraints;
  /** Samples per transferred PCM block. Default `128 * 15`. */
  bufferSamples?: number;
  /** Milliseconds to wait for the audio pipeline to start. Default `5000`. */
  setupTimeout?: number;
}

export interface CaptureResult {
  /** The captured mono PCM blocks — hand them to transcribe(). */
  blocks: Float32Array[];
  /**
   * The same audio as a WAV blob, encoded before the blocks can be
   * neutered by transcribe()'s transfer — hand it to enroll()/verify().
   */
  wav: Blob;
  sampleRate: number;
  reason: "auto" | "manual";
  /** Silence run that triggered the auto-stop (auto-stop only). */
  silentMilliseconds?: number;
}

export interface CaptureHandle {
  audioContext: AudioContext;
  sampleRate: number;
  stream: MediaStream;
  /** Resolves on auto-stop or stop() with the audio, or null after cancel(). */
  result: Promise<CaptureResult | null>;
  /** Stops the capture now; `result` resolves with the audio so far. */
  stop(): Promise<CaptureResult | null>;
  /** Discards the capture; `result` resolves with null. */
  cancel(): Promise<CaptureResult | null>;
}

/**
 * Starts capturing one utterance from the microphone through the engine's
 * AudioWorklet transferer and vosklet-mono's speech monitor.
 */
export declare function startCapture(
  engine: SpeechEngine,
  options?: CaptureOptions
): Promise<CaptureHandle>;

// ---------------------------------------------------------------------------
// Speaker verification
// ---------------------------------------------------------------------------

/** Same-speaker decision threshold recommended by the verification library. */
export declare const DEFAULT_SAME_SPEAKER_THRESHOLD: number;

/** Speaker id used when enroll()/verify() are called without one. */
export declare const DEFAULT_SPEAKER_ID: string;

/** An enrolled speaker: stable id plus optional display label. */
export interface SpeakerRef {
  id: string;
  label?: string;
}

/**
 * Pluggable persistence for reference (enrollment) embeddings, one entry per
 * speaker id.
 */
export interface ReferenceStore {
  load(id: string): Float32Array | null;
  /** Persists the embedding; a nullish label keeps the speaker's current one. */
  save(id: string, embedding: Float32Array, label?: string): void;
  clear(id: string): void;
  clearAll(): void;
  list(): SpeakerRef[];
}

/** Multi-speaker reference-embedding store backed by localStorage. */
export declare function createLocalStorageReferenceStore(key: string): ReferenceStore;

/**
 * Audio accepted by the verifier: a WAV/audio Blob or File (resampled to the
 * model's 16 kHz automatically), an ArrayBuffer of an audio file, a raw
 * Float32Array ALREADY at 16 kHz, or captured `{ blocks, sampleRate }`
 * (encoded to WAV internally).
 */
export type VerifierAudio =
  | Blob
  | File
  | ArrayBuffer
  | Float32Array
  | { blocks: Float32Array[]; sampleRate: number };

export interface SpeakerVerifierOptions {
  /**
   * Model alias from @jaehyun-ko/speaker-verification (e.g. `"standard-384"`,
   * `"standard-256"`, `"mobile-128"`). Default `"standard-384"` (~32 MB), the
   * most accurate variant. Embeddings are only comparable within one model;
   * the default reference-store key includes the alias, so switching models
   * forces re-enrollment.
   */
  model?: string;
  /** Override where the ONNX model is downloaded from. */
  modelUrl?: string;
  /** Cache Storage bucket for the model bytes. Default `"VoskletSpeaker"`. */
  cacheName?: string;
  /** onnxruntime-web wasm threads. Default `1` (WebView-safe). */
  numThreads?: number;
  /**
   * Where onnxruntime-web loads its .wasm binaries from. Default: `ort/`
   * resolved against the page URL — serve/copy the binaries there (see the
   * demo app's vite config). Pass an absolute URL when pages live in
   * subdirectories.
   */
  wasmPaths?: string;
  /** Reference persistence. Default: localStorage keyed by model alias. */
  referenceStore?: ReferenceStore;
}

export interface VerifierEnrollOptions {
  /** Speaker to enroll. Default `DEFAULT_SPEAKER_ID` (`"default"`). */
  id?: string;
  /** Display name stored with the speaker; omitting keeps the current one. */
  label?: string;
  /**
   * Also keep the enrollment audio itself in Cache Storage, retrievable via
   * loadEnrollmentAudio(id). Best-effort: on origins where the Cache API is
   * unusable (e.g. iOS `capacitor://`) enrollment still succeeds and the
   * audio is simply not persisted. Default `false`.
   */
  persist?: boolean;
}

export interface VerifyOptions {
  /** Speaker to verify against. Default `DEFAULT_SPEAKER_ID` (`"default"`). */
  id?: string;
  /** Same-speaker decision threshold. Default `DEFAULT_SAME_SPEAKER_THRESHOLD`. */
  threshold?: number;
}

export interface VerifyResult {
  /** The speaker the audio was compared against. */
  id: string;
  /** The speaker's display label, when one was enrolled. */
  label?: string;
  /** Cosine similarity (0..1) against the reference embedding. */
  score: number;
  /** True when score >= threshold. */
  match: boolean;
  threshold: number;
}

/** One speaker's similarity to the identified audio. */
export interface SpeakerScore extends SpeakerRef {
  /** Cosine similarity (0..1) against this speaker's reference embedding. */
  score: number;
}

export interface IdentifyOptions {
  /** Same-speaker decision threshold. Default `DEFAULT_SAME_SPEAKER_THRESHOLD`. */
  threshold?: number;
}

/**
 * Who is talking: the best-scoring speaker at the top level, `match` telling
 * whether that best score clears the threshold, and the full ranking in
 * `scores` (best first).
 */
export interface IdentifyResult extends SpeakerScore {
  match: boolean;
  threshold: number;
  scores: SpeakerScore[];
}

export interface SpeakerVerifier {
  readonly model: string;
  readonly modelUrl: string;
  /**
   * Loads the ONNX model and inference session once; safe to call
   * repeatedly, and retried after a failed download.
   * `onStatus("cache" | "network")` reports where the model came from.
   */
  init(onStatus?: (source: "cache" | "network") => void): Promise<unknown>;
  /** Computes the speaker embedding of the audio. */
  embed(audio: VerifierAudio): Promise<Float32Array>;
  /** Cosine similarity (0..1) between two embeddings from this model. */
  compare(a: Float32Array, b: Float32Array): Promise<number>;
  /** Embeds the audio and stores it as the reference voice for `id`. */
  enroll(audio: VerifierAudio, options?: VerifierEnrollOptions): Promise<Float32Array>;
  /** Compares the audio against one enrolled speaker's reference voice. */
  verify(audio: VerifierAudio, options?: VerifyOptions): Promise<VerifyResult>;
  /** Compares the audio against every enrolled speaker: who is talking? */
  identify(audio: VerifierAudio, options?: IdentifyOptions): Promise<IdentifyResult>;
  /** Enrolled speakers as `{ id, label? }`. */
  listSpeakers(): SpeakerRef[];
  /**
   * The enrollment audio persisted by enroll({ persist: true }), or null
   * when none was persisted (or the Cache API is unusable on this origin).
   */
  loadEnrollmentAudio(id?: string): Promise<Blob | null>;
  /** Deletes one speaker's persisted enrollment audio (reference stays). */
  clearEnrollmentAudio(id?: string): Promise<void>;
  hasReference(id?: string): boolean;
  loadReference(id?: string): Float32Array | null;
  saveReference(embedding: Float32Array, options?: VerifierEnrollOptions): void;
  /** Removes the speaker's reference and any persisted enrollment audio. */
  clearReference(id?: string): void;
  /** Removes every reference and all persisted enrollment audio. */
  clearAllReferences(): void;
}

/** Creates a speaker verifier; the model is only downloaded on first use. */
export declare function createSpeakerVerifier(
  options?: SpeakerVerifierOptions
): SpeakerVerifier;

// ---------------------------------------------------------------------------
// The suite: engine + model + verifier + capture in one object
// ---------------------------------------------------------------------------

export interface CreateVoskletSpeakerOptions {
  /** Vosk model to load (tar/tgz archive), as in vosklet-mono loadModel(). */
  model: LoadModelOptions;
  /** Reuse an existing engine instead of booting a worker one. */
  engine?: SpeechEngine;
  /** Options for the worker engine created when `engine` is not given. */
  engineOptions?: CreateWorkerOptions;
  /** Options for the speaker verifier. */
  verifier?: SpeakerVerifierOptions;
  /** Defaults merged into every record() call. */
  capture?: CaptureOptions;
}

export interface EnrollmentInput {
  /** The recording's WAV blob (CaptureResult.wav). */
  wav: VerifierAudio;
  /** What the recognizer heard; required when expectedText is used. */
  text?: string;
}

export interface EnrollmentOptions {
  /** Enrollment text the user was asked to read. */
  expectedText?: string;
  /** Minimum wordOverlap() to accept the reading. Default `0.65`. */
  matchThreshold?: number;
  /** Speaker to enroll. Default `DEFAULT_SPEAKER_ID` (`"default"`). */
  id?: string;
  /** Display name stored with the speaker; omitting keeps the current one. */
  label?: string;
  /**
   * Also keep the enrollment audio in Cache Storage (best-effort),
   * retrievable via loadEnrollmentAudio(id). Default `false`.
   */
  persist?: boolean;
}

export interface EnrollmentResult {
  accepted: boolean;
  /** Word overlap reached (null when no expectedText was given). */
  overlap: number | null;
  /** The saved reference embedding (accepted enrollments only). */
  embedding?: Float32Array;
}

export interface VoskletSpeaker {
  readonly engine: SpeechEngine;
  readonly session: SpeechSession;
  readonly verifier: SpeakerVerifier;
  /** Prefetches the speaker model in the background. */
  warmUp(onStatus?: (source: "cache" | "network") => void): Promise<unknown>;
  /** Starts capturing one utterance on a shared AudioContext. */
  record(options?: CaptureOptions): Promise<CaptureHandle>;
  /** Transcribes a finished recording (the blocks are transferred away). */
  transcribe(
    recording: Pick<CaptureResult, "blocks" | "sampleRate">,
    options?: Omit<WorkerTranscribeOptions, "sampleRate">
  ): Promise<TranscribeResult>;
  /** Saves the recording's voice as the reference for a speaker id, gated by expectedText. */
  enroll(input: EnrollmentInput, options?: EnrollmentOptions): Promise<EnrollmentResult>;
  /** Compares audio against one speaker's reference: { id, score, match, threshold }. */
  verify(audio: VerifierAudio, options?: VerifyOptions): Promise<VerifyResult>;
  /** Answers who is talking: best match across every enrolled speaker. */
  identify(audio: VerifierAudio, options?: IdentifyOptions): Promise<IdentifyResult>;
  /** Enrolled speakers as `{ id, label? }`. */
  listSpeakers(): SpeakerRef[];
  hasReference(id?: string): boolean;
  /** The enrollment audio persisted by enroll with `persist: true`, or null. */
  loadEnrollmentAudio(id?: string): Promise<Blob | null>;
  /** Deletes one speaker's persisted enrollment audio (reference stays). */
  clearEnrollmentAudio(id?: string): Promise<void>;
  /** Removes the speaker's reference and any persisted enrollment audio. */
  clearReference(id?: string): void;
  /** Removes every reference and all persisted enrollment audio. */
  clearAllReferences(): void;
  /** Closes the shared AudioContext; disposes the engine if the suite created it. */
  dispose(): Promise<void>;
}

/**
 * Boots the speech engine (a vosklet-mono worker by default), loads the Vosk
 * model, and pairs both with a speaker verifier.
 */
export declare function createVoskletSpeaker(
  options: CreateVoskletSpeakerOptions
): Promise<VoskletSpeaker>;
