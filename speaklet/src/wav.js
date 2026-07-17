/**
 * Encodes mono Float32Array PCM blocks as a 16-bit WAV blob.
 *
 * WAV is the format-proof way into the speaker-verification library: its
 * File/Blob decode path resamples to the model's 16 kHz, while raw
 * Float32Array input is assumed to already be 16 kHz — which a 44.1/48 kHz
 * microphone capture never is.
 */
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
