const now = () => (globalThis.performance ? performance.now() : Date.now());

/** Root mean square of one PCM block — the energy measure the monitor uses. */
export function getRootMeanSquare(samples) {
  if (samples.length === 0) {
    return 0;
  }
  let sumOfSquares = 0;
  for (const sample of samples) {
    sumOfSquares += sample * sample;
  }
  return Math.sqrt(sumOfSquares / samples.length);
}

class SpeechMonitor {
  #speechThreshold;
  #stopAfterSpoken;
  #callbacks;
  #blocks = [];
  #hasSpoken = false;
  #lastSpeechAt = 0;
  #stopped = false;

  constructor({ speechThreshold, stopAfterSpoken, ...callbacks }) {
    this.#speechThreshold = speechThreshold;
    this.#stopAfterSpoken = stopAfterSpoken;
    this.#callbacks = callbacks;
  }

  /** True once a block has crossed the speech threshold. */
  get hasSpoken() {
    return this.#hasSpoken;
  }

  /** True after stop() or an auto-stop; push() becomes a no-op. */
  get stopped() {
    return this.#stopped;
  }

  /** Number of blocks accumulated so far. */
  get blockCount() {
    return this.#blocks.length;
  }

  /**
   * Feeds one mono Float32Array PCM block. The monitor accumulates it,
   * classifies it as speech or silence, and fires the matching callbacks.
   * Detection granularity is the block cadence: with the default transferer
   * buffer of 1,920 samples at 48 kHz, push() runs every ~40 ms.
   */
  push(block) {
    if (this.#stopped) {
      return;
    }
    if (!(block instanceof Float32Array)) {
      throw new TypeError("push() expects a Float32Array PCM block.");
    }
    this.#blocks.push(block);
    const rms = getRootMeanSquare(block);
    const at = now();

    if (rms >= this.#speechThreshold) {
      const firstSpeech = !this.#hasSpoken;
      this.#hasSpoken = true;
      this.#lastSpeechAt = at;
      if (firstSpeech) {
        this.#callbacks.onSpeechStart?.(rms);
      }
      this.#callbacks.onSpeech?.(rms);
      return;
    }

    if (!this.#hasSpoken || !Number.isFinite(this.#stopAfterSpoken)) {
      return;
    }
    const silentMilliseconds = at - this.#lastSpeechAt;
    this.#callbacks.onSilence?.(silentMilliseconds);
    if (silentMilliseconds >= this.#stopAfterSpoken) {
      const blocks = this.#take();
      this.#callbacks.onAutoStop?.(blocks, { silentMilliseconds });
    }
  }

  /**
   * Stops monitoring and returns the accumulated blocks — the manual
   * counterpart of the auto-stop. Idempotent: after the blocks have been
   * handed out (by stop() or onAutoStop), further calls return [].
   */
  stop() {
    if (this.#stopped) {
      return [];
    }
    return this.#take();
  }

  /** Clears all state so the monitor can serve another recording. */
  reset() {
    this.#blocks = [];
    this.#hasSpoken = false;
    this.#lastSpeechAt = 0;
    this.#stopped = false;
  }

  #take() {
    this.#stopped = true;
    const blocks = this.#blocks;
    this.#blocks = [];
    return blocks;
  }
}

/**
 * Energy-based speech monitor: feed it the PCM blocks your app captures and
 * it accumulates them, detects when the user starts speaking, and fires
 * onAutoStop with all captured blocks once the user has been silent for
 * `stopAfterSpoken` milliseconds after speaking. Pure JS — it runs anywhere
 * the engine runs and never touches the microphone itself.
 */
export function createSpeechMonitor(options = {}) {
  const {
    speechThreshold = 0.015,
    stopAfterSpoken = 2000,
    onSpeechStart,
    onSpeech,
    onSilence,
    onAutoStop
  } = options;
  if (!(Number.isFinite(speechThreshold) && speechThreshold >= 0)) {
    throw new TypeError("speechThreshold must be a non-negative number.");
  }
  if (Number.isFinite(stopAfterSpoken) && stopAfterSpoken < 0) {
    throw new TypeError(
      "stopAfterSpoken must be >= 0 milliseconds, or a non-finite value (e.g. Infinity) to disable the auto-stop."
    );
  }
  return new SpeechMonitor({
    speechThreshold,
    stopAfterSpoken,
    onSpeechStart,
    onSpeech,
    onSilence,
    onAutoStop
  });
}
