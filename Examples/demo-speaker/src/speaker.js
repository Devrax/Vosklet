/**
 * Speaker verification on top of @jaehyun-ko/speaker-verification
 * (NeXt-TDNN via onnxruntime-web). Everything runs in the WebView with
 * single-threaded wasm — no SharedArrayBuffer, COOP, or COEP.
 *
 * Responsibilities of this module:
 * - Configure onnxruntime-web for non-isolated environments (1 thread) and
 *   point it at bundled wasm binaries so inference works offline.
 * - Download the ONNX speaker model once and keep it in Cache Storage (the
 *   library's own "cache" is an in-memory Map that dies with the page), with
 *   the same probe-and-fallback the Vosk models use so iOS custom schemes
 *   degrade to plain fetches instead of throwing.
 * - Turn captured PCM blocks into a WAV blob. The library only resamples on
 *   its File/Blob decode path — raw Float32Array input is assumed to already
 *   be 16 kHz — so WAV is the format-proof way in from a 44.1/48 kHz mic.
 * - Persist the reference (enrollment) embedding in localStorage and compare
 *   later recordings against it.
 */
import * as ort from "onnxruntime-web";
import { SpeakerVerification } from "@jaehyun-ko/speaker-verification";

// One deliberate model choice for the whole demo: 7.5 MB, good balance for
// mobile. Embeddings are only comparable within one model, so the model id is
// part of the storage key.
const MODEL_ALIAS = "standard-128";
const MODEL_FILE = "NeXt_TDNN_C128_B3_K65_7.onnx";
const MODEL_URL = `https://huggingface.co/jaehyun-ko/next-tdnn-onnx/resolve/main/${MODEL_FILE}`;
const REFERENCE_STORAGE_KEY = `vosklet-speaker-reference:${MODEL_ALIAS}`;

ort.env.wasm.numThreads = 1; // no SharedArrayBuffer in WebView
// The wasm binaries are served/copied under ort/ by the vite config (the
// onnxruntime-web exports map hides them from bundlers); resolve against the
// page URL so it works on http://, https://, and capacitor:// alike.
ort.env.wasm.wasmPaths = new URL("ort/", document.baseURI).href;

let verifierPromise;

async function openUsableCache() {
  // Cache API rejects non-HTTP(S) request URLs (e.g. capacitor://localhost
  // on iOS); probe once and fall back to uncached fetches.
  try {
    const cache = await caches.open("VoskletSpeaker");
    await cache.keys("speaker-cache-probe", { ignoreSearch: true });
    return cache;
  } catch {
    return null;
  }
}

async function fetchModelData(onStatus) {
  const cache = await openUsableCache();
  if (cache) {
    const cached = await cache.match(MODEL_FILE);
    if (cached) {
      onStatus?.("cache");
      return cached.arrayBuffer();
    }
  }
  onStatus?.("network");
  const response = await fetch(MODEL_URL);
  if (!response.ok) {
    throw new Error(`No fue posible descargar el modelo de voz (${response.status}).`);
  }
  const data = await response.arrayBuffer();
  if (cache) {
    try {
      await cache.put(MODEL_FILE, new Response(data.slice(0)));
    } catch {
      // A failed cache write (quota, private mode) must not block loading.
    }
  }
  return data;
}

/**
 * Loads the speaker verifier once; safe to call repeatedly.
 * `onStatus("cache" | "network")` reports where the model came from.
 */
export function initSpeakerVerifier(onStatus) {
  verifierPromise ??= (async () => {
    const modelData = await fetchModelData(onStatus);
    const verifier = new SpeakerVerification();
    // cacheModel:false — its cache is an in-memory Map; Cache Storage above
    // already persists the bytes across launches.
    await verifier.initialize(MODEL_ALIAS, { modelData, cacheModel: false });
    return verifier;
  })();
  verifierPromise.catch(() => {
    verifierPromise = undefined; // allow retry after a failed download
  });
  return verifierPromise;
}

/** Encodes mono Float32Array PCM blocks as a 16-bit WAV blob. */
export function encodeWav(blocks, sampleRate) {
  const totalSamples = blocks.reduce((count, block) => count + block.length, 0);
  const buffer = new ArrayBuffer(44 + totalSamples * 2);
  const view = new DataView(buffer);
  const writeAscii = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + totalSamples * 2, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, totalSamples * 2, true);
  let offset = 44;
  for (const block of blocks) {
    for (const sample of block) {
      const clamped = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/**
 * Computes the speaker embedding of a WAV blob (see encodeWav). Encode the
 * WAV BEFORE vosklet-mono's transcribe(): transcribe transfers the block
 * buffers to the worker, neutering them on this thread — the blob keeps its
 * own copy of the audio.
 */
export async function embedWav(wav) {
  const verifier = await initSpeakerVerifier();
  const { embedding } = await verifier.getEmbedding(wav);
  return embedding;
}

/** Cosine similarity (0..1) between two embeddings from this model. */
export async function compareEmbeddings(a, b) {
  const verifier = await initSpeakerVerifier();
  return verifier.compareEmbeddings(a, b);
}

export function saveReferenceEmbedding(embedding) {
  localStorage.setItem(REFERENCE_STORAGE_KEY, JSON.stringify(Array.from(embedding)));
}

export function loadReferenceEmbedding() {
  const raw = localStorage.getItem(REFERENCE_STORAGE_KEY);
  if (!raw) {
    return null;
  }
  try {
    return new Float32Array(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function clearReferenceEmbedding() {
  localStorage.removeItem(REFERENCE_STORAGE_KEY);
}
