/**
 * Runs the single-thread Vosklet runtime inside a dedicated Web Worker so
 * recognition never blocks the UI thread. Dedicated workers need no
 * SharedArrayBuffer, COOP, or COEP, so this works in Android WebView,
 * Capacitor, and iOS WKWebView — the same environments as the main-thread
 * single-thread runtime.
 *
 * Written as a classic worker script on purpose: importScripts() is the one
 * loading mechanism that can execute the Emscripten glue (a classic script
 * exposing the global `loadVosklet`), and classic workers run in every
 * WebView that has workers at all. Keep this file free of import/export.
 */
"use strict";

/* global loadVosklet */

let module;
let nextId = 1;
const models = new Map();
const spkModels = new Map();
const recognizers = new Map();

function parseSegment(raw) {
  try {
    const parsed = JSON.parse(raw);
    return ((parsed.text ?? parsed.partial) ?? "").trim();
  } catch {
    return (raw ?? "").trim();
  }
}

// Parses one recognizer result, extracting the speaker x-vector Vosk adds to
// final results when a speaker model is attached to the recognizer.
function parseSpeakerVector(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.spk) && parsed.spk.length > 0) {
      return { vector: parsed.spk, frames: parsed.spk_frames || 1 };
    }
  } catch {
    // Non-JSON payloads carry no x-vector.
  }
  return undefined;
}

function getModel(modelId) {
  const model = models.get(modelId);
  if (!model) {
    throw new Error("Model was unloaded. Call loadModel() again.");
  }
  return model;
}

function getSpkModel(spkModelId) {
  const spkModel = spkModels.get(spkModelId);
  if (!spkModel) {
    throw new Error("Speaker model was unloaded. Call loadSpkModel() again.");
  }
  return spkModel;
}

function getRecognizerEntry(recognizerId) {
  const entry = recognizers.get(recognizerId);
  if (!entry) {
    throw new Error("Recognizer already finished. Create a new one.");
  }
  return entry;
}

async function makeRecognizer(modelId, sampleRate, grammar, spkModelId) {
  const model = getModel(modelId);
  if (spkModelId != null) {
    if (grammar) {
      throw new Error("A grammar cannot be combined with a speaker model.");
    }
    return module.createRecognizerWithSpkModel(
      model,
      sampleRate,
      getSpkModel(spkModelId)
    );
  }
  return grammar
    ? module.createRecognizerWithGrm(model, sampleRate, grammar)
    : module.createRecognizer(model, sampleRate);
}

function joinSegments(segments) {
  return segments.join(" ").replace(/\s+/g, " ").trim();
}

const handlers = {
  async init({ glueUrl, wasmUrl, logLevel }) {
    importScripts(glueUrl);
    if (typeof loadVosklet !== "function") {
      throw new Error("Vosklet glue did not expose loadVosklet.");
    }
    module = await loadVosklet({
      locateFile: (path, prefix) =>
        path.endsWith(".wasm") ? wasmUrl : prefix + path
    });
    if (typeof logLevel === "number") {
      module.setLogLevel(logLevel);
    }
    return {};
  },

  async loadModel({ url, id, storagePath }) {
    const model = await module.createModel(url, storagePath, id);
    const modelId = nextId++;
    models.set(modelId, model);
    return { modelId };
  },

  async unloadModel({ modelId }) {
    getModel(modelId).delete();
    models.delete(modelId);
    return {};
  },

  async loadSpkModel({ url, id, storagePath }) {
    const spkModel = await module.createSpkModel(url, storagePath, id);
    const spkModelId = nextId++;
    spkModels.set(spkModelId, spkModel);
    return { spkModelId };
  },

  async unloadSpkModel({ spkModelId }) {
    getSpkModel(spkModelId).delete();
    spkModels.delete(spkModelId);
    return {};
  },

  async transcribe({ callId, modelId, blocks, sampleRate, grammar, spkModelId, progressEveryBlocks }) {
    const recognizer = await makeRecognizer(modelId, sampleRate, grammar, spkModelId);
    const segments = [];
    const speakerVectors = [];
    const collectSpeaker = (raw) => {
      if (spkModelId == null) {
        return;
      }
      const speakerVector = parseSpeakerVector(raw);
      if (speakerVector) {
        speakerVectors.push(speakerVector);
      }
    };
    try {
      for (let index = 0; index < blocks.length; index += 1) {
        const raw = recognizer.acceptWaveform(blocks[index]);
        collectSpeaker(raw);
        const segment = parseSegment(raw);
        if (segment) {
          segments.push(segment);
          self.postMessage({ type: "segment", callId, segment });
        }
        if (progressEveryBlocks > 0 && index % progressEveryBlocks === 0) {
          self.postMessage({
            type: "progress",
            callId,
            fraction: (index + 1) / blocks.length
          });
        }
      }
      const rawFinal = recognizer.finalResult();
      collectSpeaker(rawFinal);
      const finalSegment = parseSegment(rawFinal);
      if (finalSegment) {
        segments.push(finalSegment);
      }
    } finally {
      await recognizer.delete();
    }
    self.postMessage({ type: "progress", callId, fraction: 1 });
    const result = { text: joinSegments(segments), segments };
    if (spkModelId != null) {
      result.speakerVectors = speakerVectors;
    }
    return result;
  },

  async createRecognizer({ modelId, sampleRate, grammar, spkModelId }) {
    const recognizer = await makeRecognizer(modelId, sampleRate, grammar, spkModelId);
    const recognizerId = nextId++;
    recognizers.set(recognizerId, {
      recognizer,
      segments: [],
      spkModelId,
      speakerVectors: []
    });
    return { recognizerId };
  },

  async accept({ recognizerId, block }) {
    const entry = getRecognizerEntry(recognizerId);
    const raw = entry.recognizer.acceptWaveform(block);
    if (entry.spkModelId != null) {
      const speakerVector = parseSpeakerVector(raw);
      if (speakerVector) {
        entry.speakerVectors.push(speakerVector);
      }
    }
    const segment = parseSegment(raw);
    if (segment) {
      entry.segments.push(segment);
    }
    return { segment };
  },

  async finishRecognizer({ recognizerId }) {
    const entry = getRecognizerEntry(recognizerId);
    recognizers.delete(recognizerId);
    try {
      const raw = entry.recognizer.finalResult();
      if (entry.spkModelId != null) {
        const speakerVector = parseSpeakerVector(raw);
        if (speakerVector) {
          entry.speakerVectors.push(speakerVector);
        }
      }
      const segment = parseSegment(raw);
      if (segment) {
        entry.segments.push(segment);
      }
    } finally {
      await entry.recognizer.delete();
    }
    const result = { text: joinSegments(entry.segments), segments: entry.segments };
    if (entry.spkModelId != null) {
      result.speakerVectors = entry.speakerVectors;
    }
    return result;
  },

  async cancelRecognizer({ recognizerId }) {
    const entry = recognizers.get(recognizerId);
    if (entry) {
      recognizers.delete(recognizerId);
      await entry.recognizer.delete();
    }
    return {};
  },

  async setLogLevel({ level }) {
    module.setLogLevel(level);
    return {};
  },

  async dispose() {
    await module.cleanUp();
    models.clear();
    spkModels.clear();
    recognizers.clear();
    return {};
  }
};

self.onmessage = async (event) => {
  const { type, callId } = event.data;
  try {
    const handler = handlers[type];
    if (!handler) {
      throw new Error("Unknown message type: " + type);
    }
    if (type !== "init" && !module) {
      throw new Error("Worker engine is not initialized.");
    }
    const result = await handler(event.data);
    self.postMessage({ type: "result", callId, result });
  } catch (error) {
    self.postMessage({
      type: "error",
      callId,
      message: error && error.message ? error.message : String(error)
    });
  }
};
