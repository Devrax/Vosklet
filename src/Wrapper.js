/**
 * @fileoverview
 * @suppress {undefinedVars|checkTypes}
 */

if (ENVIRONMENT_IS_WEB) {

  // 'var' to expose this outside the if
  var objs = [];
  var events = ['status', 'partialResult', 'result'];
  let _cache = caches.open('Vosklet');
  let gzipMagic = [0x1f, 0x8b];
  let ustarMagic = [0x75, 0x73, 0x74, 0x61, 0x72];
  let hasGzipMagic = bytes => bytes.length > 1 && bytes[0] == gzipMagic[0] && bytes[1] == gzipMagic[1];
  let isUstarTar = bytes => bytes.length >= 262 && ustarMagic.every((b, idx) => bytes[257 + idx] == b);
  let toTarBytes = async (bytes, url) => {
    if (isUstarTar(bytes)) return bytes;
    if (typeof DecompressionStream == 'undefined') {
      if (hasGzipMagic(bytes))
        throw new Error('Model fetch succeeded but gzip decompression is unavailable in this browser (missing DecompressionStream).');
      throw new Error('Fetched model bytes from ' + url + ' are invalid: expected a USTAR tar archive or gzip-compressed USTAR tar archive.');
    }
    try {
      let stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      let decompressed = new Uint8Array(await new Response(stream).arrayBuffer());
      if (!isUstarTar(decompressed))
        throw new Error('decompressed bytes are not a USTAR tar archive');
      return decompressed;
    } catch (err) {
      throw new Error('Unable to decode model as gzip-compressed USTAR tar archive from ' + url + ': ' + (err?.message || err));
    }
  };
  let processorURL = URL.createObjectURL(new Blob(['(', (() => {
    registerProcessor('VoskletTransferer', class extends AudioWorkletProcessor {
      constructor(opts) {
        super();
        this.filled = 0;
        this.bufSize = opts.processorOptions[0];
        this.buf = new Float32Array(this.bufSize);
      }
      process(inputs) {
        if (inputs[0][0]) {
          this.buf.set(inputs[0][0], this.filled);
          this.filled += 128;
          if (this.filled >= this.bufSize) {
            this.filled = 0;
            this.port.postMessage(this.buf, [this.buf.buffer]);
            this.buf = new Float32Array(this.bufSize);
          }
        }
        return true;
      }
    })
  }).toString(), ')()'], { type: 'text/javascript' }));
  class CommonModel extends EventTarget {
    constructor() {
      super();
      objs.push(this);
    }
    delete() {
      this.obj.delete();
    }
    static async mk(url, storepath, id, normalMdl) {
      let mdl = new CommonModel();
      let result = new Promise((resolve, reject) => {
        mdl.addEventListener('', ev => {
          if (!ev.detail) {
            if (normalMdl) mdl['findWord'] = word => mdl.obj['findWord'](word);
            resolve(mdl);
          }
          else reject(ev.detail);
        }, { once: true });
      });
      let cache = await caches.open('Vosklet');
      let req = (await cache.keys(storepath, { ignoreSearch: true }))[0];
      let res;
      if (typeof req == 'undefined' || req.url.split('?')[1] != id) {

        // Caching already handled explicitly 
        res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw 'Unable to fetch model, status: ' + res.status;
        res = new Response(await toTarBytes(new Uint8Array(await res.arrayBuffer()), url));
        await cache.put(storepath + '?' + id, res.clone());
      }
      else res = await cache.match(req);
      let tar = await res.arrayBuffer();
      let tarStart = _malloc(tar.byteLength);
      HEAPU8.set(new Uint8Array(tar), tarStart);
      mdl.obj = new Module['CommonModel'](objs.length - 1, normalMdl, tarStart, tar.byteLength);
      return result;
    }
  }
  class Recognizer extends EventTarget {
    constructor() {
      super();
      objs.push(this);
    }
    acceptWaveform(audioData) {
      let start = _malloc(audioData.length * 4);
      HEAPF32.set(audioData, start / 4);
      return UTF8ToString(this.obj['acceptWaveform'](start, audioData.length));
    }
    finalResult() {
      return UTF8ToString(this.obj['finalResult']());
    }
    delete() {
      this.obj.delete();
    }
    static async mk(model, sampleRate, mode, grammar, spkModel) {
      let rec = new Recognizer();
      let result = new Promise((resolve, reject) => {
        rec.addEventListener('', ev => {
          if (!ev.detail) resolve(rec);
          else reject(ev.detail);
        }, { once: true });
      })
      switch (mode) {
        case 1:
          rec.obj = new Module['Recognizer'](objs.length - 1, sampleRate, model);
          break;
        case 2:
          rec.obj = new Module['Recognizer'](objs.length - 1, sampleRate, model, spkModel);
          break;
        default:
          rec.obj = new Module['Recognizer'](objs.length - 1, sampleRate, model, grammar, 0);
      }
      return result;
    }
  }
  Module = {
    'getModelCache': () => _cache,

    'cleanUp': async () => {
      for (let obj of objs) await obj.delete();
      URL.revokeObjectURL(processorURL);
    },

    'createTransferer': async (ctx, bufSize) => {
      await ctx.audioWorklet.addModule(processorURL);
      return new AudioWorkletNode(ctx, 'VoskletTransferer', {
        channelCountMode: 'explicit',
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
        processorOptions: [bufSize]
      });
    },

    'createModel': (url, storepath, id) =>
      CommonModel.mk(url, storepath, id, true),

    'createSpkModel': (url, storepath, id) =>
      CommonModel.mk(url, storepath, id, false),

    'createRecognizer': (model, sampleRate) =>
      Recognizer.mk(model.obj, sampleRate, 1),

    'createRecognizerWithGrm': (model, sampleRate, grammar) =>
      Recognizer.mk(model.obj, sampleRate, 3, grammar, null),

    'createRecognizerWithSpkModel': (model, sampleRate, spkModel) =>
      Recognizer.mk(model.obj, sampleRate, 2, null, spkModel.obj)
  }

}