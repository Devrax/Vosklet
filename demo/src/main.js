import { loadVosklet } from "vosklet/singlethread";
import "./style.css";

const modelUrl = new URL("/models/es-small.tar", window.location.origin).href;
const modelStorePath = "Spanish";
const modelId = "vosk-model-small-es-0.42";
const recordingOptions = {
  stopAfterSpoken: 1_500,
  speechThreshold: 0.015
};

const challengeText = document.querySelector("#challengeText");
const startButton = document.querySelector("#startButton");
const stopButton = document.querySelector("#stopButton");
const recordingState = document.querySelector("#recordingState");
const status = document.querySelector("#status");
const transcript = document.querySelector("#transcript");

let audioContext;
let module;
let model;
let stream;
let microphoneNode;
let transferer;
let recognizer;
let capturedAudio = [];
let preparing = false;
let recording = false;
let processing = false;
let hasSpoken = false;
let lastSpeechAt = 0;

function debug(event, details = {}) {
  console.info("[Vosklet Challenge]", event, details);
}

function parseResult(detail) {
  try {
    return (JSON.parse(detail).text || "").trim();
  } catch {
    return (detail || "").trim();
  }
}

function getRootMeanSquare(samples) {
  let sumOfSquares = 0;
  for (const sample of samples) {
    sumOfSquares += sample * sample;
  }
  return Math.sqrt(sumOfSquares / samples.length);
}

function getAutoStopDelay() {
  const { stopAfterSpoken } = recordingOptions;
  return Number.isFinite(stopAfterSpoken) && stopAfterSpoken >= 0
    ? stopAfterSpoken
    : undefined;
}

function captureAudio(samples) {
  if (!recording) {
    return;
  }

  capturedAudio.push(samples);
  const rms = getRootMeanSquare(samples);
  const now = performance.now();

  if (rms >= recordingOptions.speechThreshold) {
    if (!hasSpoken) {
      debug("speech-detected", { rms, threshold: recordingOptions.speechThreshold });
    }
    hasSpoken = true;
    lastSpeechAt = now;
    return;
  }

  const autoStopDelay = getAutoStopDelay();
  if (hasSpoken && autoStopDelay !== undefined && now - lastSpeechAt >= autoStopDelay) {
    debug("recording-auto-stop", {
      silentMilliseconds: Math.round(now - lastSpeechAt),
      stopAfterSpoken: autoStopDelay
    });
    void finishRecording();
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
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es-ES")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
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

async function deleteRecognizer() {
  const activeRecognizer = recognizer;
  recognizer = undefined;
  if (activeRecognizer) {
    await activeRecognizer.delete();
  }
}

async function startRecording() {
  if (preparing || processing || recording) {
    debug("recording-start-ignored", { preparing, processing, recording });
    return;
  }

  preparing = true;
  startButton.disabled = true;
  stopButton.disabled = true;
  transcript.classList.remove("is-correct", "is-incorrect");
  recordingState.textContent = "Preparando micrófono...";
  debug("microphone-requested");

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
    debug("recognizer-creating", { sampleRate: audioContext.sampleRate });
    recognizer = await withTimeout(
      module.createRecognizer(model, audioContext.sampleRate),
      "El reconocedor no respondió al iniciar."
    );
    debug("recognizer-ready");
    microphoneNode = audioContext.createMediaStreamSource(stream);
    debug("transferer-creating");
    transferer = await withTimeout(
      module.createTransferer(audioContext, 128 * 15),
      "La captura de audio no respondió al iniciar."
    );
    debug("transferer-ready");
    capturedAudio = [];
    hasSpoken = false;
    lastSpeechAt = 0;
    transferer.port.onmessage = (audioEvent) => captureAudio(audioEvent.data);
    microphoneNode.connect(transferer);
    recording = true;
    debug("recording-started", {
      sampleRate: audioContext.sampleRate,
      transferBufferSamples: 128 * 15
    });
    stopButton.disabled = false;
    recordingState.textContent = "Grabando";
  } catch (error) {
    console.error("[Vosklet Challenge] microphone-request-failed", error);
    disconnectMicrophone();
    await deleteRecognizer();
    recordingState.textContent = "No fue posible acceder al micrófono";
    status.textContent = error.message;
    startButton.disabled = false;
  } finally {
    preparing = false;
  }
}

async function finishRecording() {
  if (!recording || processing) {
    return;
  }

  recording = false;
  processing = true;
  startButton.disabled = true;
  stopButton.disabled = true;
  transferer.port.onmessage = null;
  disconnectMicrophone();
  recordingState.textContent = "Procesando audio...";
  debug("recording-stopped", { chunks: capturedAudio.length });

  try {
    const recognizedParts = [];
    for (let index = 0; index < capturedAudio.length; index += 1) {
      const result = parseResult(recognizer.acceptWaveform(capturedAudio[index]));
      if (result) {
        recognizedParts.push(result);
        debug("recognizer-result", { result });
      }
      if (index % 12 === 0) {
        const progress = Math.round(((index + 1) / capturedAudio.length) * 100);
        recordingState.textContent = `Procesando audio... ${progress}%`;
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
    }
    const tail = parseResult(recognizer.finalResult());
    if (tail) {
      recognizedParts.push(tail);
      debug("recognizer-final-result", { result: tail });
    }
    const text = recognizedParts.join(" ").replace(/\s+/g, " ").trim();
    debug("transcription-finished", { text });
    setTranscript(text);
  } catch (error) {
    console.error("[Vosklet Challenge] recording-processing-failed", error);
    transcript.textContent = "No fue posible procesar la grabación.";
    transcript.classList.add("is-incorrect");
    recordingState.textContent = "Error al procesar el audio";
    status.textContent = error.message;
  } finally {
    await deleteRecognizer();
    capturedAudio = [];
    processing = false;
    startButton.disabled = false;
  }
}

async function initialize() {
  try {
    debug("module-loading", { modelUrl });
    module = await loadVosklet();
    debug("module-loaded");
    status.textContent = "Cargando el modelo español local...";
    model = await module.createModel(modelUrl, modelStorePath, modelId);
    debug("model-loaded", { modelId, modelStorePath });
    status.textContent = "Modelo español local";
    startButton.disabled = false;
  } catch (error) {
    console.error("[Vosklet Challenge] initialization-failed", error);
    status.textContent = error.message;
    recordingState.textContent = "El modelo no pudo cargarse";
  }
}

startButton.addEventListener("click", () => void startRecording());
stopButton.addEventListener("click", () => {
  debug("recording-stop-requested");
  void finishRecording();
});

initialize();