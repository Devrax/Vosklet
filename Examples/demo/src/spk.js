import { createSpeechMonitor } from "monosklet/singlethread";
import { createVoskletMonoWorker } from "monosklet/worker";
import "./style.css";

const modelUrl = new URL("/models/es-small.tar", window.location.origin).href;
const modelStorePath = "Spanish";
const modelId = "vosk-model-small-es-0.42";

// Native Vosk speaker-identification model (x-vector extractor). Language
// independent by design — this demo tests how well it separates Spanish
// speakers. Fetched by scripts/fetch-models.sh next to the Spanish model.
const spkModelUrl = new URL("/models/spk-0.4.tar", window.location.origin).href;
const spkModelStorePath = "SpeakerXVector";
const spkModelId = "vosk-model-spk-0.4";

const recordingOptions = {
  stopAfterSpoken: 3_000,
  speechThreshold: 0.015
};

// Enrollment: one sentence, ~8 s spoken — enough voiced audio for a stable
// x-vector. Same text as the NeXt-TDNN speaker example so the two speaker
// backends can be compared on identical recordings.
const enrollmentText =
  "Confirmo, acepto y autorizo que esta es mi voz, y la registro con calma y claridad como referencia única para verificar mi identidad";
const enrollmentStopAfterSpoken = 5_000;

// Cosine similarity between x-vectors at or above which the demo calls it
// the same speaker. Vosk's own examples accept a cosine distance below ~0.55
// (similarity above ~0.45), but that proved too lenient here — different
// people reading the same phrase score close to it. 0.75 held up better in
// testing with Spanish speakers; watch the raw score in the console and tune
// it per microphone and environment.
const matchThreshold = 0.75;

const referenceStorageKey = "vosklet-demo-xvector-reference";

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
let spkSession;
let stream;
let microphoneNode;
let transferer;
let monitor;
let preparing = false;
let recording = false;
let processing = false;
let mode = "challenge"; // "challenge" | "enroll"
let reference = loadReference();

function debug(event, details = {}) {
  console.info("[Vosklet Challenge x-vector]", event, details);
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
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es-ES")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function loadReference() {
  try {
    const raw = localStorage.getItem(referenceStorageKey);
    if (!raw) {
      return undefined;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.vector) || parsed.vector.length === 0) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function saveReference(vector, frames) {
  reference = { vector, frames, savedAt: new Date().toISOString() };
  try {
    localStorage.setItem(referenceStorageKey, JSON.stringify(reference));
  } catch (error) {
    debug("reference-persist-failed", { message: error.message });
  }
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  const norms = Math.sqrt(normA) * Math.sqrt(normB);
  return norms === 0 ? 0 : dot / norms;
}

// Vosk emits one x-vector per completed utterance segment; a recording with
// pauses yields several. Average them weighted by the number of frames each
// vector was computed from, so a short trailing fragment cannot dominate.
function averageXVector(segments) {
  if (segments.length === 0) {
    return undefined;
  }
  const size = segments[0].vector.length;
  const mean = new Array(size).fill(0);
  let totalFrames = 0;
  for (const { vector, frames } of segments) {
    totalFrames += frames;
    for (let index = 0; index < size; index += 1) {
      mean[index] += vector[index] * frames;
    }
  }
  for (let index = 0; index < size; index += 1) {
    mean[index] /= totalFrames;
  }
  return { vector: mean, frames: totalFrames };
}

function updateIdleUi() {
  const idle = Boolean(session && spkSession) && !preparing && !recording && !processing;
  enrollButton.disabled = !idle;
  startButton.disabled = !(idle && reference);
  referenceText.hidden = Boolean(reference) && mode !== "enroll";
  if (reference) {
    referenceState.textContent = "Referencia guardada";
    enrollButton.textContent = "Volver a grabar referencia";
  } else {
    referenceState.textContent = "Sin registrar: lee el texto en voz alta para guardar tu voz";
    enrollButton.textContent = "Grabar voz de referencia";
  }
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
    await createAudioContext();
    microphoneNode = audioContext.createMediaStreamSource(stream);
    transferer = await withTimeout(
      engine.createTransferer(audioContext, 128 * 15),
      "La captura de audio no respondió al iniciar."
    );
    monitor = createSpeechMonitor({
      speechThreshold: recordingOptions.speechThreshold,
      stopAfterSpoken:
        mode === "enroll" ? enrollmentStopAfterSpoken : recordingOptions.stopAfterSpoken,
      onSpeechStart: (rms) => {
        debug("speech-detected", { rms, threshold: recordingOptions.speechThreshold });
      },
      onAutoStop: (blocks, { silentMilliseconds }) => {
        debug("recording-auto-stop", { silentMilliseconds: Math.round(silentMilliseconds) });
        void finishRecording(blocks);
      }
    });
    transferer.port.onmessage = (audioEvent) => monitor.push(audioEvent.data);
    microphoneNode.connect(transferer);
    recording = true;
    debug("recording-started", { mode, sampleRate: audioContext.sampleRate });
    stopButton.disabled = false;
    recordingState.textContent =
      mode === "enroll" ? "Grabando: lee el texto de referencia" : "Grabando";
  } catch (error) {
    console.error("[Vosklet Challenge x-vector] microphone-request-failed", error);
    disconnectMicrophone();
    recordingState.textContent = "No fue posible acceder al micrófono";
    status.textContent = error.message;
    mode = "challenge";
    updateIdleUi();
  } finally {
    preparing = false;
  }
}

function finishEnrollment(text, xVector) {
  transcript.textContent = text || "No se reconoció la lectura.";
  if (!xVector) {
    transcript.classList.add("is-incorrect");
    recordingState.textContent =
      "No se obtuvo una huella de voz: habla más tiempo e intenta de nuevo.";
    return;
  }
  saveReference(xVector.vector, xVector.frames);
  debug("enrollment-saved", { frames: xVector.frames, recognized: text });
  transcript.classList.add("is-correct");
  recordingState.textContent = `Referencia guardada (${xVector.frames} cuadros de voz)`;
}

function finishChallenge(text, xVector) {
  const matchesChallenge = setTranscript(text);
  if (!matchesChallenge || !reference) {
    return;
  }
  if (!xVector) {
    similarity.hidden = false;
    similarity.textContent = "No se obtuvo una huella de voz de esta grabación.";
    similarity.classList.remove("is-similar", "is-different");
    return;
  }
  const score = cosineSimilarity(reference.vector, xVector.vector);
  const match = score >= matchThreshold;
  const percent = Math.round(score * 100);
  debug("voice-compared", {
    cosineSimilarity: Number(score.toFixed(3)),
    cosineDistance: Number((1 - score).toFixed(3)),
    matchThreshold,
    match
  });
  similarity.hidden = false;
  if (match) {
    similarity.textContent = `Similitud x-vector: ${percent}% (umbral ${Math.round(matchThreshold * 100)}%): parece la misma persona.`;
    similarity.classList.remove("is-different");
    similarity.classList.add("is-similar");
    recordingState.textContent = "Respuesta correcta y voz identificada";
  } else {
    similarity.textContent = `Similitud x-vector: ${percent}% (umbral ${Math.round(matchThreshold * 100)}%): no parece la misma persona.`;
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
    // Recognition and x-vector extraction run inside the Web Worker; the UI
    // thread only receives progress messages and the final result.
    const { text, speakerVectors } = await session.transcribe(capturedAudio, {
      sampleRate: audioContext.sampleRate,
      speakerModel: spkSession,
      onSegment: (segment) => debug("recognizer-result", { result: segment }),
      onProgress: (fraction) => {
        recordingState.textContent = `Procesando audio... ${Math.round(fraction * 100)}%`;
      }
    });
    const xVector = averageXVector(speakerVectors ?? []);
    debug("transcription-finished", {
      text,
      utterances: speakerVectors?.length ?? 0,
      hasXVector: Boolean(xVector)
    });
    if (mode === "enroll") {
      finishEnrollment(text, xVector);
    } else {
      finishChallenge(text, xVector);
    }
  } catch (error) {
    console.error("[Vosklet Challenge x-vector] recording-processing-failed", error);
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
    debug("module-loading", { modelUrl, spkModelUrl });
    engine = await createVoskletMonoWorker();
    debug("module-loaded", { runtime: engine.runtime, host: engine.host });
    status.textContent = "Cargando el modelo español local...";
    session = await engine.loadModel({
      url: modelUrl,
      id: modelId,
      storagePath: modelStorePath
    });
    debug("model-loaded", { modelId, modelStorePath });
    status.textContent = "Cargando el modelo de hablante (x-vector)...";
    // Same archive pipeline as the speech model: local USTAR TAR, cached in
    // Cache Storage under the given id, loaded inside the worker.
    spkSession = await engine.loadSpkModel({
      url: spkModelUrl,
      id: spkModelId,
      storagePath: spkModelStorePath
    });
    debug("spk-model-loaded", { spkModelId, spkModelStorePath });
    status.textContent = "Modelos listos (español + x-vector nativo de Vosk)";
    updateIdleUi();
  } catch (error) {
    console.error("[Vosklet Challenge x-vector] initialization-failed", error);
    status.textContent = error.message;
    recordingState.textContent = "El modelo no pudo cargarse";
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
// Cache FAB: wipes every Cache Storage bucket (both model archives) and
// reloads. The enrolled x-vector lives in localStorage and is left untouched.
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
    console.error("[Vosklet Challenge x-vector] cache-clear-failed", error);
  }
  location.reload();
});

initialize();
