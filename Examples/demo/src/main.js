import { createVoskletMono, createSpeechMonitor } from "vosklet-mono/singlethread";
import "./style.css";

const modelUrl = new URL("/models/es-small.tar", window.location.origin).href;
const modelStorePath = "Spanish";
const modelId = "vosk-model-small-es-0.42";
const recordingOptions = {
  stopAfterSpoken: 2_000,
  speechThreshold: 0.015
};

const challengeText = document.querySelector("#challengeText");
const startButton = document.querySelector("#startButton");
const stopButton = document.querySelector("#stopButton");
const recordingState = document.querySelector("#recordingState");
const status = document.querySelector("#status");
const transcript = document.querySelector("#transcript");

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

function debug(event, details = {}) {
  console.info("[Vosklet Challenge]", event, details);
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
    microphoneNode = audioContext.createMediaStreamSource(stream);
    debug("transferer-creating");
    transferer = await withTimeout(
      engine.createTransferer(audioContext, 128 * 15),
      "La captura de audio no respondió al iniciar."
    );
    debug("transferer-ready");
    monitor = createSpeechMonitor({
      ...recordingOptions,
      onSpeechStart: (rms) => {
        debug("speech-detected", { rms, threshold: recordingOptions.speechThreshold });
      },
      onAutoStop: (blocks, { silentMilliseconds }) => {
        debug("recording-auto-stop", {
          silentMilliseconds: Math.round(silentMilliseconds),
          stopAfterSpoken: recordingOptions.stopAfterSpoken
        });
        void finishRecording(blocks);
      }
    });
    transferer.port.onmessage = (audioEvent) => monitor.push(audioEvent.data);
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
    recordingState.textContent = "No fue posible acceder al micrófono";
    status.textContent = error.message;
    startButton.disabled = false;
  } finally {
    preparing = false;
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
  debug("recording-stopped", { chunks: capturedAudio.length });

  try {
    const { text } = await session.transcribe(capturedAudio, {
      sampleRate: audioContext.sampleRate,
      onSegment: (segment) => debug("recognizer-result", { result: segment }),
      onProgress: (fraction) => {
        recordingState.textContent = `Procesando audio... ${Math.round(fraction * 100)}%`;
      }
    });
    debug("transcription-finished", { text });
    setTranscript(text);
  } catch (error) {
    console.error("[Vosklet Challenge] recording-processing-failed", error);
    transcript.textContent = "No fue posible procesar la grabación.";
    transcript.classList.add("is-incorrect");
    recordingState.textContent = "Error al procesar el audio";
    status.textContent = error.message;
  } finally {
    monitor = undefined;
    processing = false;
    startButton.disabled = false;
  }
}

async function initialize() {
  try {
    debug("module-loading", { modelUrl });
    engine = await createVoskletMono();
    debug("module-loaded", { runtime: engine.runtime });
    status.textContent = "Cargando el modelo español local...";
    session = await engine.loadModel({
      url: modelUrl,
      id: modelId,
      storagePath: modelStorePath
    });
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

// Cache FAB: wipes every Cache Storage bucket (the downloaded models) and
// reloads, so the next launch re-downloads from scratch.
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
    console.error("[Vosklet Challenge] cache-clear-failed", error);
  }
  location.reload();
});

initialize();
