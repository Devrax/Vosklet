/**
 * Speaker verification on top of @jaehyun-ko/speaker-verification
 * (NeXt-TDNN via onnxruntime-web). Everything runs in the page with
 * single-threaded wasm by default — no SharedArrayBuffer, COOP, or COEP —
 * so it works in Android WebView, Capacitor, and iOS WKWebView.
 *
 * Responsibilities of this module:
 * - Configure onnxruntime-web for non-isolated environments and point it at
 *   locally served wasm binaries so inference works offline.
 * - Download the ONNX speaker model once and keep it in Cache Storage (the
 *   underlying library's own "cache" is an in-memory Map that dies with the
 *   page), with a probe-and-fallback so non-HTTP(S) origins like iOS
 *   capacitor:// degrade to plain fetches instead of throwing.
 * - Persist reference (enrollment) embeddings through a pluggable store,
 *   localStorage by default — one entry per speaker id, so a single verifier
 *   (and a single ONNX model instance) serves any number of speakers, and
 *   identify() can tell who is talking.
 */
import * as ort from "onnxruntime-web";
import { SpeakerVerification } from "@jaehyun-ko/speaker-verification";
import { encodeWav } from "./wav.js";

/** Same-speaker decision threshold recommended by the verification library. */
export const DEFAULT_SAME_SPEAKER_THRESHOLD = 0.5;

/** Speaker id used when enroll()/verify() are called without one. */
export const DEFAULT_SPEAKER_ID = "default";

/** Multi-speaker reference-embedding store backed by localStorage. */
export function createLocalStorageReferenceStore(key) {
  function read() {
    const raw = localStorage.getItem(key);
    if (!raw) {
      return {};
    }
    try {
      const parsed = JSON.parse(raw);
      // Legacy single-reference layout (a bare embedding array): migrate it
      // to the default speaker so pre-multi-speaker enrollments survive.
      if (Array.isArray(parsed)) {
        return { [DEFAULT_SPEAKER_ID]: { embedding: parsed } };
      }
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  function write(entries) {
    if (Object.keys(entries).length === 0) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify(entries));
    }
  }
  return {
    load(id) {
      const entry = read()[id];
      return entry ? new Float32Array(entry.embedding) : null;
    },
    save(id, embedding, label) {
      const entries = read();
      // Re-enrolling without a label keeps the speaker's existing one.
      label ??= entries[id]?.label;
      entries[id] = {
        embedding: Array.from(embedding),
        ...(label != null && { label })
      };
      write(entries);
    },
    clear(id) {
      const entries = read();
      delete entries[id];
      write(entries);
    },
    clearAll() {
      localStorage.removeItem(key);
    },
    list() {
      return Object.entries(read()).map(([id, { label }]) => ({
        id,
        ...(label != null && { label })
      }));
    }
  };
}

function defaultModelUrl(model) {
  const info = SpeakerVerification.MODELS?.[model];
  if (!info) {
    throw new TypeError(
      `Unknown speaker model "${model}"; pick one of ` +
        `${Object.keys(SpeakerVerification.MODELS ?? {}).join(", ")} ` +
        `or pass modelUrl explicitly.`
    );
  }
  return `https://huggingface.co/jaehyun-ko/next-tdnn-onnx/resolve/main/${info.id}.onnx`;
}

async function openUsableCache(cacheName) {
  // Cache API rejects non-HTTP(S) request URLs (e.g. capacitor://localhost
  // on iOS); probe once and fall back to uncached fetches.
  try {
    const cache = await caches.open(cacheName);
    await cache.keys("speaker-cache-probe", { ignoreSearch: true });
    return cache;
  } catch {
    return null;
  }
}

/**
 * Creates a speaker verifier. Cheap to call — the ONNX model is downloaded
 * and the inference session created on the first init()/embed()/verify().
 */
export function createSpeakerVerifier(options = {}) {
  const {
    model = "standard-384",
    modelUrl = defaultModelUrl(model),
    cacheName = "VoskletSpeaker",
    numThreads = 1,
    wasmPaths,
    referenceStore = createLocalStorageReferenceStore(
      // Embeddings are only comparable within one model, so the model id is
      // part of the storage key — switching models forces re-enrollment.
      `speaklet-reference:${model}`
    )
  } = options;

  // Cache under the file name (not the full URL) so deployments that migrate
  // from a self-built integration keep their already-downloaded model.
  const cacheKey = modelUrl.split("/").pop();
  let verifierPromise;

  async function fetchModelData(onStatus) {
    const cache = await openUsableCache(cacheName);
    if (cache) {
      const cached = await cache.match(cacheKey);
      if (cached) {
        onStatus?.("cache");
        return cached.arrayBuffer();
      }
    }
    onStatus?.("network");
    const response = await fetch(modelUrl);
    if (!response.ok) {
      throw new Error(`Failed to download the speaker model (${response.status}).`);
    }
    const data = await response.arrayBuffer();
    if (cache) {
      try {
        await cache.put(cacheKey, new Response(data.slice(0)));
      } catch {
        // A failed cache write (quota, private mode) must not block loading.
      }
    }
    return data;
  }

  /**
   * Loads the ONNX model and inference session once; safe to call
   * repeatedly, and retried on the next call after a failed download.
   * `onStatus("cache" | "network")` reports where the model came from.
   */
  function init(onStatus) {
    verifierPromise ??= (async () => {
      ort.env.wasm.numThreads = numThreads;
      ort.env.wasm.wasmPaths =
        wasmPaths ??
        new URL("ort/", globalThis.document?.baseURI ?? globalThis.location.href).href;
      const modelData = await fetchModelData(onStatus);
      const verifier = new SpeakerVerification();
      // cacheModel:false — its cache is an in-memory Map; Cache Storage above
      // already persists the bytes across launches.
      await verifier.initialize(model, { modelData, cacheModel: false });
      return verifier;
    })();
    verifierPromise.catch(() => {
      verifierPromise = undefined; // allow retry after a failed download
    });
    return verifierPromise;
  }

  function toModelInput(audio) {
    if (audio && typeof audio === "object" && Array.isArray(audio.blocks)) {
      return encodeWav(audio.blocks, audio.sampleRate);
    }
    return audio; // Blob | File | ArrayBuffer | Float32Array (16 kHz!)
  }

  // --- Optional enrollment-audio persistence (enroll({ persist: true })) ---
  // The WAV goes into the same Cache Storage bucket as the model, so it
  // survives page reloads. Best-effort by design: where the Cache API is
  // unusable (e.g. iOS capacitor://), enrollment still succeeds and
  // loadEnrollmentAudio() returns null.

  function enrollmentKey(id) {
    return `speaklet-enrollment/${encodeURIComponent(id)}`;
  }

  function toPersistableBlob(audio) {
    const input = toModelInput(audio);
    if (input instanceof Blob) {
      return input; // includes File
    }
    if (input instanceof ArrayBuffer) {
      return new Blob([input], { type: "application/octet-stream" });
    }
    if (input instanceof Float32Array) {
      return encodeWav([input], 16000); // raw PCM is 16 kHz by contract
    }
    return null;
  }

  async function persistEnrollmentAudio(id, audio) {
    const cache = await openUsableCache(cacheName);
    const blob = cache && toPersistableBlob(audio);
    if (!blob) {
      return false;
    }
    try {
      await cache.put(enrollmentKey(id), new Response(blob));
      return true;
    } catch {
      return false; // quota, private mode — never block the enrollment
    }
  }

  async function deleteEnrollmentAudio(id) {
    const cache = await openUsableCache(cacheName);
    if (cache) {
      await cache.delete(enrollmentKey(id)).catch(() => {});
    }
  }

  async function embed(audio) {
    const verifier = await init();
    const { embedding } = await verifier.getEmbedding(toModelInput(audio));
    return embedding;
  }

  function labelOf(id) {
    return referenceStore.list().find((speaker) => speaker.id === id)?.label;
  }

  return {
    model,
    modelUrl,
    init,
    embed,
    /** Cosine similarity (0..1) between two embeddings from this model. */
    async compare(a, b) {
      const verifier = await init();
      return verifier.compareEmbeddings(a, b);
    },
    /**
     * Embeds the audio and stores it as the reference voice for `id`
     * (`"default"` when omitted). `label` is a display name kept alongside —
     * re-enrolling without one preserves the previous label. With
     * `persist: true` the enrollment audio itself is also kept in Cache
     * Storage (best-effort) and retrievable via loadEnrollmentAudio(id).
     */
    async enroll(audio, { id = DEFAULT_SPEAKER_ID, label, persist = false } = {}) {
      const embedding = await embed(audio);
      referenceStore.save(id, embedding, label);
      if (persist) {
        await persistEnrollmentAudio(id, audio);
      }
      return embedding;
    },
    /** Compares the audio against one enrolled speaker's reference voice. */
    async verify(
      audio,
      { id = DEFAULT_SPEAKER_ID, threshold = DEFAULT_SAME_SPEAKER_THRESHOLD } = {}
    ) {
      const reference = referenceStore.load(id);
      if (!reference) {
        throw new Error(`No reference voice enrolled for speaker "${id}"; call enroll() first.`);
      }
      const verifier = await init();
      const score = verifier.compareEmbeddings(reference, await embed(audio));
      const label = labelOf(id);
      return {
        id,
        ...(label != null && { label }),
        score,
        match: score >= threshold,
        threshold
      };
    },
    /**
     * Compares the audio against every enrolled speaker and answers who is
     * talking: the best-scoring speaker spread at the top level, `match`
     * telling whether that best score clears the threshold, and `scores`
     * carrying the full ranking (best first).
     */
    async identify(audio, { threshold = DEFAULT_SAME_SPEAKER_THRESHOLD } = {}) {
      const speakers = referenceStore.list();
      if (speakers.length === 0) {
        throw new Error("No speakers enrolled; call enroll() first.");
      }
      const verifier = await init();
      const probe = await embed(audio);
      const scores = speakers
        .map(({ id, label }) => ({
          id,
          ...(label != null && { label }),
          score: verifier.compareEmbeddings(referenceStore.load(id), probe)
        }))
        .sort((a, b) => b.score - a.score);
      const best = scores[0];
      return { ...best, match: best.score >= threshold, threshold, scores };
    },
    /**
     * The enrollment audio persisted by enroll({ persist: true }), as a
     * Blob — or null when none was persisted (or the Cache API is unusable
     * on this origin).
     */
    async loadEnrollmentAudio(id = DEFAULT_SPEAKER_ID) {
      const cache = await openUsableCache(cacheName);
      const hit = cache && (await cache.match(enrollmentKey(id)));
      return hit ? hit.blob() : null;
    },
    /** Deletes one speaker's persisted enrollment audio (reference stays). */
    clearEnrollmentAudio: (id = DEFAULT_SPEAKER_ID) => deleteEnrollmentAudio(id),
    /** Enrolled speakers as `{ id, label? }`, in storage order. */
    listSpeakers: () => referenceStore.list(),
    hasReference: (id = DEFAULT_SPEAKER_ID) => referenceStore.load(id) !== null,
    loadReference: (id = DEFAULT_SPEAKER_ID) => referenceStore.load(id),
    saveReference: (embedding, { id = DEFAULT_SPEAKER_ID, label } = {}) =>
      referenceStore.save(id, embedding, label),
    clearReference(id = DEFAULT_SPEAKER_ID) {
      referenceStore.clear(id);
      void deleteEnrollmentAudio(id);
    },
    clearAllReferences() {
      for (const { id } of referenceStore.list()) {
        void deleteEnrollmentAudio(id);
      }
      referenceStore.clearAll();
    }
  };
}
