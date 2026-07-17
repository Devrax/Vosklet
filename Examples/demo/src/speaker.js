import { createVoskletSpeaker, normalizeText, textsMatch } from "vosklet-speaker";
import "./style.css";

const modelUrl = new URL("/models/es-small.tar", window.location.origin).href;
const modelStorePath = "Spanish";
const modelId = "vosk-model-small-es-0.42";
const recordingOptions = {
  stopAfterSpoken: 3_000,
  speechThreshold: 0.015
};

// Enrollment: one sentence, ~8 s spoken — comfortable to read in one take,
// and long enough audio for a stable reference embedding.
const enrollmentText =
  "Confirmo, acepto y autorizo que esta es mi voz, y la registro con calma y claridad como referencia única para verificar mi identidad";

// Reading a paragraph has natural pauses at the periods, so give the
// auto-stop more slack during enrollment than during the short challenge.
const enrollmentStopAfterSpoken = 5_000;

// Reading accuracy required to accept the enrollment recording (bag-of-words
// overlap). Deliberately lenient: the reading only gates that the user
// actually spoke the reference text — the voice embedding is what matters,
// so a mostly-correct reading should not force a retry.
const enrollmentMatchThreshold = 0.65;

const challengeText = document.querySelector("#challengeText");
const startButton = document.querySelector("#startButton");
const stopButton = document.querySelector("#stopButton");
const enrollButton = document.querySelector("#enrollButton");
const recordingState = document.querySelector("#recordingState");
const referenceState = document.querySelector("#referenceState");
const referenceText = document.querySelector("#referenceText");
const status = document.querySelector("#status");
const transcript = document.querySelector("#transcript");
const similarity = document.querySelector("#similarity");

referenceText.textContent = enrollmentText;

let speaker;
let capture;
let preparing = false;
let recording = false;
let processing = false;
let mode = "challenge"; // "challenge" | "enroll"

function debug(event, details = {}) {
  console.info("[Vosklet Challenge Speaker]", event, details);
}

function updateIdleUi() {
  const hasReference = Boolean(speaker?.hasReference());
  const idle = Boolean(speaker) && !preparing && !recording && !processing;
  enrollButton.disabled = !idle;
  startButton.disabled = !(idle && hasReference);
  referenceText.hidden = hasReference && mode !== "enroll";
  if (hasReference) {
    referenceState.textContent = "Referencia guardada";
    enrollButton.textContent = "Volver a grabar referencia";
  } else {
    referenceState.textContent = "Sin registrar: lee el texto en voz alta para guardar tu voz";
    enrollButton.textContent = "Grabar voz de referencia";
  }
}

function setTranscript(text) {
  const matchesChallenge = textsMatch(challengeText.value, text);
  debug("challenge-compared", {
    expected: normalizeText(challengeText.value),
    recognized: normalizeText(text),
    matchesChallenge
  });
  transcript.textContent = text || "No se reconoció una respuesta.";
  transcript.classList.toggle("is-correct", Boolean(text) && matchesChallenge);
  transcript.classList.toggle("is-incorrect", Boolean(text) && !matchesChallenge);
  recordingState.textContent = matchesChallenge ? "Respuesta correcta" : "La respuesta no coincide";
  return matchesChallenge;
}

async function startRecording() {
  if (preparing || processing || recording) {
    debug("recording-start-ignored", { preparing, processing, recording });
    return;
  }

  preparing = true;
  startButton.disabled = true;
  stopButton.disabled = true;
  enrollButton.disabled = true;
  transcript.classList.remove("is-correct", "is-incorrect");
  similarity.hidden = true;
  recordingState.textContent = "Preparando micrófono...";
  debug("microphone-requested", { mode });

  try {
    capture = await speaker.record({
      stopAfterSpoken:
        mode === "enroll" ? enrollmentStopAfterSpoken : recordingOptions.stopAfterSpoken,
      onSpeechStart: (rms) => {
        debug("speech-detected", { rms, threshold: recordingOptions.speechThreshold });
      }
    });
    recording = true;
    debug("recording-started", { mode, sampleRate: capture.sampleRate });
    stopButton.disabled = false;
    recordingState.textContent =
      mode === "enroll" ? "Grabando: lee el texto de referencia" : "Grabando";
    void capture.result.then((finished) => {
      if (finished) {
        void processRecording(finished);
      }
    });
  } catch (error) {
    console.error("[Vosklet Challenge Speaker] microphone-request-failed", error);
    recordingState.textContent = "No fue posible acceder al micrófono";
    status.textContent = error.message;
    mode = "challenge";
    updateIdleUi();
  } finally {
    preparing = false;
  }
}

async function finishEnrollment(text, wav) {
  transcript.textContent = text || "No se reconoció la lectura.";
  recordingState.textContent = "Analizando tu voz...";
  const { accepted, overlap } = await speaker.enroll(
    { wav, text },
    { expectedText: enrollmentText, matchThreshold: enrollmentMatchThreshold }
  );
  const percent = Math.round(overlap * 100);
  debug("enrollment-compared", { overlap: Number(overlap.toFixed(2)), accepted, recognized: text });
  if (accepted) {
    transcript.classList.add("is-correct");
    recordingState.textContent = `Referencia guardada (lectura ${percent}% correcta)`;
  } else {
    transcript.classList.add("is-incorrect");
    recordingState.textContent = `Lectura incompleta (${percent}%). Lee el texto completo e intenta de nuevo.`;
  }
}

async function finishChallenge(text, wav) {
  const matchesChallenge = setTranscript(text);
  if (!matchesChallenge || !speaker.hasReference()) {
    return;
  }
  recordingState.textContent = "Comparando con tu voz de referencia...";
  const { score, match } = await speaker.verify(wav);
  const percent = Math.round(score * 100);
  debug("voice-compared", { score: Number(score.toFixed(3)), match });
  similarity.hidden = false;
  if (match) {
    similarity.textContent = `Tu voz suena ${percent}% similar a tu referencia: parece la misma persona.`;
    similarity.classList.remove("is-different");
    similarity.classList.add("is-similar");
    recordingState.textContent = "Respuesta correcta y voz verificada";
  } else {
    similarity.textContent = `Tu voz suena solo ${percent}% similar a tu referencia: no parece la misma persona.`;
    similarity.classList.remove("is-similar");
    similarity.classList.add("is-different");
    recordingState.textContent = "Respuesta correcta, pero la voz no coincide";
  }
}

async function processRecording(finished) {
  if (processing) {
    return;
  }

  recording = false;
  processing = true;
  startButton.disabled = true;
  stopButton.disabled = true;
  recordingState.textContent = "Procesando audio...";
  debug("recording-stopped", {
    mode,
    chunks: finished.blocks.length,
    reason: finished.reason,
    silentMilliseconds: Math.round(finished.silentMilliseconds ?? 0)
  });

  try {
    // finished.wav was encoded by the library BEFORE this call transfers the
    // block buffers to the worker, so the audio survives transcription.
    const { text } = await speaker.transcribe(finished, {
      onSegment: (segment) => debug("recognizer-result", { result: segment }),
      onProgress: (fraction) => {
        recordingState.textContent = `Procesando audio... ${Math.round(fraction * 100)}%`;
      }
    });
    debug("transcription-finished", { text });
    if (mode === "enroll") {
      await finishEnrollment(text, finished.wav);
    } else {
      await finishChallenge(text, finished.wav);
    }
  } catch (error) {
    console.error("[Vosklet Challenge Speaker] recording-processing-failed", error);
    transcript.textContent = "No fue posible procesar la grabación.";
    transcript.classList.add("is-incorrect");
    recordingState.textContent = "Error al procesar el audio";
    status.textContent = error.message;
  } finally {
    capture = undefined;
    processing = false;
    mode = "challenge";
    updateIdleUi();
  }
}

async function initialize() {
  try {
    debug("module-loading", { modelUrl });
    status.textContent = "Cargando el modelo español local...";
    speaker = await createVoskletSpeaker({
      model: { url: modelUrl, id: modelId, storagePath: modelStorePath },
      // The ONNX speaker model is served locally (see vite.config.js), so
      // nothing is fetched from Hugging Face at runtime. wasmPaths must be
      // absolute: this page lives under /speaker/, so the default
      // page-relative "ort/" would miss the binaries served at /ort/.
      verifier: {
        model: "standard-384",
        modelUrl: "/models/NeXt_TDNN_C384_B1_K65_7.onnx",
        wasmPaths: new URL("/ort/", window.location.origin).href
      },
      capture: recordingOptions
    });
    debug("model-loaded", { modelId, modelStorePath });
    status.textContent = "Modelo español local";
    updateIdleUi();
  } catch (error) {
    console.error("[Vosklet Challenge Speaker] initialization-failed", error);
    status.textContent = error.message;
    recordingState.textContent = "El modelo no pudo cargarse";
    return;
  }

  // Warm the speaker model in the background; enroll/verify await the
  // verifier themselves, which retries if this download failed.
  try {
    await speaker.warmUp((source) => {
      status.textContent =
        source === "cache"
          ? "Cargando modelo de voz (caché)..."
          : "Descargando modelo de voz...";
    });
    status.textContent = "Modelos listos (español + verificación de voz)";
    debug("speaker-verifier-ready");
  } catch (error) {
    console.error("[Vosklet Challenge Speaker] speaker-model-failed", error);
    status.textContent = `Modelo de voz no disponible: ${error.message}`;
  }
}

startButton.addEventListener("click", () => {
  mode = "challenge";
  void startRecording();
});
enrollButton.addEventListener("click", () => {
  mode = "enroll";
  referenceText.hidden = false;
  void startRecording();
});
stopButton.addEventListener("click", () => {
  debug("recording-stop-requested");
  void capture?.stop();
});

updateIdleUi();
// Cache FAB: wipes every Cache Storage bucket (Vosk archive + ONNX speaker
// model) and reloads, so the next launch re-downloads from scratch. The
// enrolled reference lives in localStorage and is left untouched.
const clearCacheButton = document.querySelector("#clearCacheButton");
clearCacheButton.addEventListener("click", async () => {
  clearCacheButton.disabled = true;
  debug("cache-clear-requested");
  try {
    if ("caches" in globalThis) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
  } catch (error) {
    console.error("[Vosklet Challenge Speaker] cache-clear-failed", error);
  }
  location.reload();
});

initialize();
