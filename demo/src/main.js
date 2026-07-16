import { loadVosklet } from "vosklet/singlethread";
import "./style.css";

const modelUrl = new URL("/models/es-small.tar.gz", window.location.origin).href;
const modelStorePath = "Spanish";
const modelId = "vosk-model-small-es-0.42";

const challengeText = document.querySelector("#challengeText");
const recordButton = document.querySelector("#recordButton");
const recordingState = document.querySelector("#recordingState");
const status = document.querySelector("#status");
const transcript = document.querySelector("#transcript");

let audioContext;
let module;
let model;
let recorder;
let stream;
let chunks = [];
let processing = false;

function parseResult(detail) {
  try {
    return (JSON.parse(detail).text || "").trim();
  } catch {
    return (detail || "").trim();
  }
}

function toMono(audioBuffer) {
  if (audioBuffer.numberOfChannels === 1) {
    return audioBuffer.getChannelData(0);
  }

  const output = new Float32Array(audioBuffer.length);
  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
    const input = audioBuffer.getChannelData(channel);
    for (let index = 0; index < output.length; index += 1) {
      output[index] += input[index] / audioBuffer.numberOfChannels;
    }
  }
  return output;
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
  transcript.textContent = text || "No se reconoció una respuesta.";
  transcript.classList.toggle("is-correct", Boolean(text) && matchesChallenge);
  transcript.classList.toggle("is-incorrect", Boolean(text) && !matchesChallenge);
  recordingState.textContent = matchesChallenge ? "Respuesta correcta" : "La respuesta no coincide";
}

async function transcribeBlob(blob) {
  if (!audioContext) {
    audioContext = new AudioContext({ sinkId: { type: "none" } });
  }

  const audioBuffer = await audioContext.decodeAudioData(await blob.arrayBuffer());
  const samples = toMono(audioBuffer);
  const recognizer = await module.createRecognizer(model, audioBuffer.sampleRate);
  const finalized = [];
  const chunkSize = audioBuffer.sampleRate * 2;

  for (let offset = 0; offset < samples.length; offset += chunkSize) {
    const result = parseResult(
      recognizer.acceptWaveform(samples.subarray(offset, Math.min(samples.length, offset + chunkSize)))
    );
    if (result) {
      finalized.push(result);
    }
  }

  const tail = parseResult(recognizer.finalResult());
  if (tail) {
    finalized.push(tail);
  }

  await recognizer.delete();
  return finalized.join(" ").replace(/\s+/g, " ").trim();
}

async function startRecording(event) {
  if (processing || recorder?.state === "recording") {
    return;
  }

  event.preventDefault();
  recordButton.setPointerCapture(event.pointerId);
  transcript.classList.remove("is-correct", "is-incorrect");

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true
      }
    });
    chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.addEventListener("dataavailable", (recordingEvent) => {
      if (recordingEvent.data.size > 0) {
        chunks.push(recordingEvent.data);
      }
    });
    recorder.addEventListener("stop", finishRecording, { once: true });
    recorder.start();
    recordButton.classList.add("is-recording");
    recordingState.textContent = "Grabando";
  } catch (error) {
    recordingState.textContent = "No fue posible acceder al micrófono";
    status.textContent = error.message;
  }
}

function stopRecording(event) {
  if (event?.pointerId !== undefined && recordButton.hasPointerCapture(event.pointerId)) {
    recordButton.releasePointerCapture(event.pointerId);
  }
  if (recorder?.state === "recording") {
    recorder.stop();
  }
}

async function finishRecording() {
  recordButton.classList.remove("is-recording");
  stream?.getTracks().forEach((track) => track.stop());
  processing = true;
  recordButton.disabled = true;
  recordingState.textContent = "Comparando la respuesta...";

  try {
    const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
    setTranscript(await transcribeBlob(blob));
  } catch (error) {
    transcript.textContent = "No fue posible procesar la grabación.";
    transcript.classList.add("is-incorrect");
    recordingState.textContent = "Error al procesar el audio";
    status.textContent = error.message;
  } finally {
    processing = false;
    recordButton.disabled = false;
  }
}

async function initialize() {
  try {
    module = await loadVosklet();
    status.textContent = "Cargando el modelo español local...";
    model = await module.createModel(modelUrl, modelStorePath, modelId);
    status.textContent = "Modelo español local";
    recordButton.disabled = false;
  } catch (error) {
    status.textContent = error.message;
    recordingState.textContent = "El modelo no pudo cargarse";
  }
}

recordButton.addEventListener("pointerdown", startRecording);
recordButton.addEventListener("pointerup", stopRecording);
recordButton.addEventListener("pointercancel", stopRecording);
recordButton.addEventListener("lostpointercapture", stopRecording);

initialize();