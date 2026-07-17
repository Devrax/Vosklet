import { createSpeechMonitor } from "vosklet-mono/singlethread";
import { createVoskletMonoWorker } from "vosklet-mono/worker";
import {
  compareEmbeddings,
  embedWav,
  encodeWav,
  initSpeakerVerifier,
  loadReferenceEmbedding,
  saveReferenceEmbedding
} from "./speaker.js";
import "./style.css";

const modelUrl = new URL("/models/es-small.tar", window.location.origin).href;
const modelStorePath = "Spanish";
const modelId = "vosk-model-small-es-0.42";
const recordingOptions = {
  stopAfterSpoken: 2_000,
  speechThreshold: 0.015
};

// Enrollment: one phonetically rich sentence (~8 s spoken) — short enough to
// read comfortably, long enough for a stable reference embedding.
const enrollmentText =
  "Confirmo, acepto y autorizo que esta es mi voz";

// Reading a paragraph has natural pauses at the periods, so give the
// auto-stop more slack during enrollment than during the short challenge.
const enrollmentStopAfterSpoken = 3_000;

// Reading accuracy required to accept the enrollment recording (bag-of-words
// overlap; the small Vosk model won't get every word of a long paragraph).
const enrollmentMatchThreshold = 0.8;

// Same-speaker decision threshold recommended by the verification library.
const sameSpeakerThreshold = 0.5;

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

let audioContext;
let engine;
let session;
let stream;
let microphoneNode;
let transferer;
let monitor;
let preparing = false;
let recording = false;
let processing = false;
let mode = "challenge"; // "challenge" | "enroll"
let referenceEmbedding = loadReferenceEmbedding();

function debug(event, details = {}) {
  console.info("[Vosklet Challenge Speaker]", event, details);
}

function updateIdleUi() {
  const idle = Boolean(session) && !preparing && !recording && !processing;
  enrollButton.disabled = !idle;
  startButton.disabled = !(idle && referenceEmbedding);
  referenceText.hidden = Boolean(referenceEmbedding) && mode !== "enroll";
  if (referenceEmbedding) {
    referenceState.textContent = "Referencia guardada";
    enrollButton.textContent = "Volver a grabar referencia";
  } else {
    referenceState.textContent = "Sin registrar: lee el texto en voz alta para guardar tu voz";
    enrollButton.textContent = "Grabar voz de referencia";
  }
}

function withTimeout(promise, message, timeout = 5000) {
  let timeoutId;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeoutId = window.setTimeout(() => reject(new Error(message)), timeout);
    })
  ]).finally(() => window.clearTimeout(timeoutId));
}

function normalize(text) {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase("es-ES")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wordOverlap(expected, recognized) {
  const expectedWords = normalize(expected).split(" ").filter(Boolean);
  if (expectedWords.length === 0) {
    return 0;
  }
  const bag = new Map();
  for (const word of normalize(recognized).split(" ")) {
    bag.set(word, (bag.get(word) ?? 0) + 1);
  }
  let hits = 0;
  for (const word of expectedWords) {
    const count = bag.get(word) ?? 0;
    if (count > 0) {
      hits += 1;
      bag.set(word, count - 1);
    }
  }
  return hits / expectedWords.length;
}

function setTranscript(text) {
  const matchesChallenge = normalize(text) === normalize(challengeText.value);
  debug("challenge-compared", {
    expected: normalize(challengeText.value),
    recognized: normalize(text),
    matchesChallenge
  });
  transcript.textContent = text || "No se reconoció una respuesta.";
  transcript.classList.toggle("is-correct", Boolean(text) && matchesChallenge);
  transcript.classList.toggle("is-incorrect", Boolean(text) && !matchesChallenge);
  recordingState.textContent = matchesChallenge ? "Respuesta correcta" : "La respuesta no coincide";
  return matchesChallenge;
}

async function createAudioContext() {
  if (!audioContext) {
    audioContext = new AudioContext({ sinkId: { type: "none" } });
    debug("audio-context-created", { sampleRate: audioContext.sampleRate });
  }
  await audioContext.resume();
}

function disconnectMicrophone() {
  microphoneNode?.disconnect();
  transferer?.disconnect();
  stream?.getTracks().forEach((track) => track.stop());
  microphoneNode = undefined;
  transferer = undefined;
  stream = undefined;
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
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true
      }
    });
    const [audioTrack] = stream.getAudioTracks();
    debug("microphone-granted", {
      label: audioTrack?.label,
      settings: audioTrack?.getSettings()
    });
    await createAudioContext();
    microphoneNode = audioContext.createMediaStreamSource(stream);
    debug("transferer-creating");
    transferer = await withTimeout(
      engine.createTransferer(audioContext, 128 * 15),
      "La captura de audio no respondió al iniciar."
    );
    debug("transferer-ready");
    const stopAfterSpoken =
      mode === "enroll" ? enrollmentStopAfterSpoken : recordingOptions.stopAfterSpoken;
    monitor = createSpeechMonitor({
      ...recordingOptions,
      stopAfterSpoken,
      onSpeechStart: (rms) => {
        debug("speech-detected", { rms, threshold: recordingOptions.speechThreshold });
      },
      onAutoStop: (blocks, { silentMilliseconds }) => {
        debug("recording-auto-stop", {
          silentMilliseconds: Math.round(silentMilliseconds),
          stopAfterSpoken
        });
        void finishRecording(blocks);
      }
    });
    transferer.port.onmessage = (audioEvent) => monitor.push(audioEvent.data);
    microphoneNode.connect(transferer);
    recording = true;
    debug("recording-started", {
      mode,
      sampleRate: audioContext.sampleRate,
      transferBufferSamples: 128 * 15
    });
    stopButton.disabled = false;
    recordingState.textContent =
      mode === "enroll" ? "Grabando: lee el texto de referencia" : "Grabando";
  } catch (error) {
    console.error("[Vosklet Challenge Speaker] microphone-request-failed", error);
    disconnectMicrophone();
    recordingState.textContent = "No fue posible acceder al micrófono";
    status.textContent = error.message;
    mode = "challenge";
    updateIdleUi();
  } finally {
    preparing = false;
  }
}

async function finishEnrollment(text, wav) {
  const overlap = wordOverlap(enrollmentText, text);
  debug("enrollment-compared", { overlap: Number(overlap.toFixed(2)), recognized: text });
  transcript.textContent = text || "No se reconoció la lectura.";
  const percent = Math.round(overlap * 100);
  if (overlap >= enrollmentMatchThreshold) {
    transcript.classList.add("is-correct");
    recordingState.textContent = "Analizando tu voz...";
    const embedding = await embedWav(wav);
    saveReferenceEmbedding(embedding);
    referenceEmbedding = embedding;
    debug("enrollment-saved", { embeddingSize: embedding.length });
    recordingState.textContent = `Referencia guardada (lectura ${percent}% correcta)`;
  } else {
    transcript.classList.add("is-incorrect");
    recordingState.textContent = `Lectura incompleta (${percent}%). Lee el texto completo e intenta de nuevo.`;
  }
}

async function finishChallenge(text, wav) {
  const matchesChallenge = setTranscript(text);
  if (!matchesChallenge || !referenceEmbedding) {
    return;
  }
  recordingState.textContent = "Comparando con tu voz de referencia...";
  const score = await compareEmbeddings(referenceEmbedding, await embedWav(wav));
  const percent = Math.round(score * 100);
  debug("voice-compared", { score: Number(score.toFixed(3)), sameSpeakerThreshold });
  similarity.hidden = false;
  if (score >= sameSpeakerThreshold) {
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

async function finishRecording(blocks) {
  if (!recording || processing) {
    return;
  }

  recording = false;
  processing = true;
  startButton.disabled = true;
  stopButton.disabled = true;
  transferer.port.onmessage = null;
  disconnectMicrophone();
  const capturedAudio = blocks ?? monitor.stop();
  recordingState.textContent = "Procesando audio...";
  debug("recording-stopped", { mode, chunks: capturedAudio.length });

  try {
    // Encode the WAV BEFORE transcribing: transcribe() transfers the block
    // buffers to the worker, so the audio would be gone afterwards.
    const wav = encodeWav(capturedAudio, audioContext.sampleRate);
    const { text } = await session.transcribe(capturedAudio, {
      sampleRate: audioContext.sampleRate,
      onSegment: (segment) => debug("recognizer-result", { result: segment }),
      onProgress: (fraction) => {
        recordingState.textContent = `Procesando audio... ${Math.round(fraction * 100)}%`;
      }
    });
    debug("transcription-finished", { text });
    if (mode === "enroll") {
      await finishEnrollment(text, wav);
    } else {
      await finishChallenge(text, wav);
    }
  } catch (error) {
    console.error("[Vosklet Challenge Speaker] recording-processing-failed", error);
    transcript.textContent = "No fue posible procesar la grabación.";
    transcript.classList.add("is-incorrect");
    recordingState.textContent = "Error al procesar el audio";
    status.textContent = error.message;
  } finally {
    monitor = undefined;
    processing = false;
    mode = "challenge";
    updateIdleUi();
  }
}

async function initialize() {
  try {
    debug("module-loading", { modelUrl });
    engine = await createVoskletMonoWorker();
    debug("module-loaded", { runtime: engine.runtime, host: engine.host });
    status.textContent = "Cargando el modelo español local...";
    session = await engine.loadModel({
      url: modelUrl,
      id: modelId,
      storagePath: modelStorePath
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

  // Warm the speaker model in the background; the enroll/compare paths await
  // initSpeakerVerifier() themselves, which retries if this download failed.
  try {
    await initSpeakerVerifier((source) => {
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
  void finishRecording();
});

updateIdleUi();
initialize();
