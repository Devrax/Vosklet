/**
 * Microphone capture for challenge flows: acquires the microphone (or uses a
 * caller-provided stream/AudioContext), routes PCM through the engine's
 * AudioWorklet transferer into monosklet's speech monitor, and resolves
 * with the captured audio once the speaker goes silent — or when stop() is
 * called. The WAV blob is encoded before the promise resolves, so callers can
 * hand the raw blocks to transcribe() (which transfers and neuters their
 * buffers) and still keep the audio.
 */
import { createSpeechMonitor } from "monosklet/singlethread";
import { encodeWav } from "./wav.js";

const DEFAULT_AUDIO_CONSTRAINTS = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true
};

function withTimeout(promise, message, timeout) {
  let timeoutId;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(message)), timeout);
    })
  ]).finally(() => clearTimeout(timeoutId));
}

/**
 * Starts capturing one utterance. Resolves the returned handle's `result`
 * with `{ blocks, wav, sampleRate, reason }` on auto-stop or stop(), or with
 * `null` on cancel(). Resources the capture created itself (stream, context)
 * are released when it settles; caller-provided ones are left untouched.
 */
export async function startCapture(engine, options = {}) {
  const {
    audioContext: providedContext,
    stream: providedStream,
    audio = DEFAULT_AUDIO_CONSTRAINTS,
    bufferSamples = 128 * 15,
    speechThreshold = 0.015,
    stopAfterSpoken = 2000,
    setupTimeout = 5000,
    onSpeechStart,
    onSpeech,
    onSilence
  } = options;

  const ownsStream = !providedStream;
  const ownsContext = !providedContext;
  let stream = providedStream;
  let audioContext = providedContext;
  let source;
  let transferer;
  let settled = false;

  let resolveResult;
  const result = new Promise((resolve) => {
    resolveResult = resolve;
  });

  function teardown() {
    if (transferer) {
      transferer.port.onmessage = null;
    }
    source?.disconnect();
    transferer?.disconnect();
    if (ownsStream) {
      stream?.getTracks().forEach((track) => track.stop());
    }
    if (ownsContext) {
      void audioContext?.close().catch(() => {});
    }
  }

  function settle(reason, blocks, info = {}) {
    if (settled) {
      return;
    }
    settled = true;
    const sampleRate = audioContext.sampleRate;
    teardown();
    resolveResult(
      blocks ? { blocks, wav: encodeWav(blocks, sampleRate), sampleRate, reason, ...info } : null
    );
  }

  try {
    stream ??= await navigator.mediaDevices.getUserMedia({ audio });
    // No playback path is needed; { type: "none" } keeps the output device
    // free on browsers that support AudioContext sinkId.
    audioContext ??= new AudioContext({ sinkId: { type: "none" } });
    await audioContext.resume();
    source = audioContext.createMediaStreamSource(stream);
    transferer = await withTimeout(
      engine.createTransferer(audioContext, bufferSamples),
      "Audio capture did not respond while starting.",
      setupTimeout
    );
    const monitor = createSpeechMonitor({
      speechThreshold,
      stopAfterSpoken,
      onSpeechStart,
      onSpeech,
      onSilence,
      onAutoStop: (blocks, info) => settle("auto", blocks, info)
    });
    transferer.port.onmessage = (event) => monitor.push(event.data);
    source.connect(transferer);

    return {
      audioContext,
      sampleRate: audioContext.sampleRate,
      stream,
      result,
      /** Stops the capture now; `result` resolves with the audio so far. */
      stop() {
        settle("manual", monitor.stop());
        return result;
      },
      /** Discards the capture; `result` resolves with null. */
      cancel() {
        monitor.stop();
        settle("cancel", null);
        return result;
      }
    };
  } catch (error) {
    settled = true;
    teardown();
    throw error;
  }
}
