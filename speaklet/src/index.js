/**
 * speaklet: one API for voice-challenge flows in the browser —
 * offline speech recognition (monosklet) unified with on-device speaker
 * verification (@jaehyun-ko/speaker-verification), plus the microphone
 * capture that feeds both.
 *
 * Layers, use whichever fits:
 * - createVoskletSpeaker(): the batteries-included suite — engine, model,
 *   verifier, and shared-AudioContext recording in one object.
 * - startCapture() / createSpeakerVerifier(): the pieces, for apps that
 *   manage their own engine, streams, or storage.
 */
import { createVoskletMonoWorker } from "monosklet/worker";
import { startCapture } from "./capture.js";
import { createSpeakerVerifier } from "./verifier.js";
import { wordOverlap } from "./textMatch.js";

// The speech engine ships inside this package — no monosklet install
// needed to boot a custom engine for startCapture() or createVoskletSpeaker().
export { createVoskletMonoWorker, supportsWorkerHost } from "monosklet/worker";
export { startCapture } from "./capture.js";
export {
  createSpeakerVerifier,
  createLocalStorageReferenceStore,
  DEFAULT_SAME_SPEAKER_THRESHOLD,
  DEFAULT_SPEAKER_ID
} from "./verifier.js";
export { encodeWav } from "./wav.js";
export { normalizeText, textsMatch, wordOverlap } from "./textMatch.js";

/**
 * Boots the speech engine (a monosklet worker by default), loads the Vosk
 * model, and pairs both with a speaker verifier. The verifier's ONNX model is
 * NOT downloaded here — call warmUp() to prefetch it in the background, or
 * let the first enroll()/verify() trigger it.
 */
export async function createVoskletSpeaker(options = {}) {
  const {
    engine: providedEngine,
    engineOptions,
    model,
    verifier: verifierOptions,
    capture: captureDefaults = {}
  } = options;
  if (!model?.url || !model?.id) {
    throw new TypeError("createVoskletSpeaker() requires model: { url, id, storagePath? }.");
  }

  const ownsEngine = !providedEngine;
  const engine = providedEngine ?? (await createVoskletMonoWorker(engineOptions));
  const session = await engine.loadModel(model);
  const verifier = createSpeakerVerifier(verifierOptions);

  // One AudioContext shared across recordings: creating one per capture works
  // but pays the construction latency on every press of the record button.
  let audioContext;
  async function sharedAudioContext() {
    audioContext ??= new AudioContext({ sinkId: { type: "none" } });
    await audioContext.resume();
    return audioContext;
  }

  return {
    engine,
    session,
    verifier,

    /** Prefetches the speaker model; see createSpeakerVerifier().init(). */
    warmUp(onStatus) {
      return verifier.init(onStatus);
    },

    /** Starts capturing one utterance; see startCapture() for the handle. */
    async record(recordOptions = {}) {
      return startCapture(engine, {
        audioContext: await sharedAudioContext(),
        ...captureDefaults,
        ...recordOptions
      });
    },

    /** Transcribes a finished recording (the blocks are transferred away). */
    transcribe(recording, transcribeOptions = {}) {
      return session.transcribe(recording.blocks, {
        sampleRate: recording.sampleRate,
        ...transcribeOptions
      });
    },

    /**
     * Saves the recording's voice as the reference for `id` (`"default"`
     * when omitted; pass `label` for a display name). When expectedText is
     * given, the transcript must reach matchThreshold word overlap first —
     * the gate that the user actually read the enrollment text; the voice
     * embedding is what matters, so a mostly-correct reading passes.
     */
    async enroll(
      { wav, text = "" },
      { expectedText, matchThreshold = 0.65, id, label, persist } = {}
    ) {
      const overlap = expectedText != null ? wordOverlap(expectedText, text) : null;
      if (overlap !== null && overlap < matchThreshold) {
        return { accepted: false, overlap };
      }
      const embedding = await verifier.enroll(wav, { id, label, persist });
      return { accepted: true, overlap, embedding };
    },

    /** Compares audio against one speaker's reference: { id, score, match, threshold }. */
    verify(audio, verifyOptions) {
      return verifier.verify(audio, verifyOptions);
    },

    /** Answers who is talking: best match across every enrolled speaker. */
    identify(audio, identifyOptions) {
      return verifier.identify(audio, identifyOptions);
    },

    listSpeakers: () => verifier.listSpeakers(),
    hasReference: (id) => verifier.hasReference(id),
    loadEnrollmentAudio: (id) => verifier.loadEnrollmentAudio(id),
    clearEnrollmentAudio: (id) => verifier.clearEnrollmentAudio(id),
    clearReference: (id) => verifier.clearReference(id),
    clearAllReferences: () => verifier.clearAllReferences(),

    /** Closes the shared AudioContext and, if this suite created the engine, disposes it. */
    async dispose() {
      await audioContext?.close().catch(() => {});
      audioContext = undefined;
      if (ownsEngine) {
        await engine.dispose();
      }
    }
  };
}
