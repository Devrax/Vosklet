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
const recognizers = new Map();

function parseSegment(raw) {
  try {
    const parsed = JSON.parse(raw);
    return ((parsed.text ?? parsed.partial) ?? "").trim();
  } catch {
    return (raw ?? "").trim();
  }
}

function getModel(modelId) {
  const model = models.get(modelId);
  if (!model) {
    throw new Error("Model was unloaded. Call loadModel() again.");
  }
  return model;
}

function getRecognizerEntry(recognizerId) {
  const entry = recognizers.get(recognizerId);
  if (!entry) {
    throw new Error("Recognizer already finished. Create a new one.");
  }
  return entry;
}

async function makeRecognizer(modelId, sampleRate, grammar) {
  const model = getModel(modelId);
  return grammar
    ? module.createRecognizerWithGrm(model, grammar, sampleRate)
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

  async transcribe({ callId, modelId, blocks, sampleRate, grammar, progressEveryBlocks }) {
    const recognizer = await makeRecognizer(modelId, sampleRate, grammar);
    const segments = [];
    try {
      for (let index = 0; index < blocks.length; index += 1) {
        const segment = parseSegment(recognizer.acceptWaveform(blocks[index]));
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
      const finalSegment = parseSegment(recognizer.finalResult());
      if (finalSegment) {
        segments.push(finalSegment);
      }
    } finally {
      await recognizer.delete();
    }
    self.postMessage({ type: "progress", callId, fraction: 1 });
    return { text: joinSegments(segments), segments };
  },

  async createRecognizer({ modelId, sampleRate, grammar }) {
    const recognizer = await makeRecognizer(modelId, sampleRate, grammar);
    const recognizerId = nextId++;
    recognizers.set(recognizerId, { recognizer, segments: [] });
    return { recognizerId };
  },

  async accept({ recognizerId, block }) {
    const entry = getRecognizerEntry(recognizerId);
    const segment = parseSegment(entry.recognizer.acceptWaveform(block));
    if (segment) {
      entry.segments.push(segment);
    }
    return { segment };
  },

  async finishRecognizer({ recognizerId }) {
    const entry = getRecognizerEntry(recognizerId);
    recognizers.delete(recognizerId);
    try {
      const segment = parseSegment(entry.recognizer.finalResult());
      if (segment) {
        entry.segments.push(segment);
      }
    } finally {
      await entry.recognizer.delete();
    }
    return { text: joinSegments(entry.segments), segments: entry.segments };
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
