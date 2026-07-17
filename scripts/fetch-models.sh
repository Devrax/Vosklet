#!/usr/bin/env bash
# Downloads the models the example apps consume. They are deliberately not
# committed to the repository — run this once after cloning (or let
# `pnpm run setup` do it). Idempotent: files already present are kept.
# Requirements: curl, unzip, tar.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"

vosk_id="vosk-model-small-es-0.42"
# Served from the demo app's public/ for every example page.
vosk_tar="$root/Examples/demo/public/models/es-small.tar"
onnx_file="NeXt_TDNN_C384_B1_K65_7.onnx"
onnx_target="$root/Examples/demo/models/$onnx_file"

# --- Vosk Spanish model (speech recognition; every example page) -----------
if [ -f "$vosk_tar" ]; then
  echo "- $(basename "$vosk_tar") already present, skipping"
else
  echo "- Downloading $vosk_id (~39 MB) from alphacephei.com..."
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fL --progress-bar -o "$tmp/model.zip" \
    "https://alphacephei.com/vosk/models/$vosk_id.zip"
  unzip -q "$tmp/model.zip" -d "$tmp"
  mkdir -p "$(dirname "$vosk_tar")"
  # USTAR TAR with the model files directly below the archive root — the
  # layout the engine expects. Gzip-compressed (the engine detects the format
  # by bytes) but named .tar: a .gz extension would make Android's asset
  # packager strip it from the app bundle and static servers add
  # Content-Encoding: gzip, both of which break model loading.
  (cd "$tmp/$vosk_id" && tar --format=ustar -czf "$vosk_tar" .)
  echo "  wrote $vosk_tar"
fi

# --- NeXt-TDNN speaker model (verification; the speaker example) -----------
if [ -f "$onnx_target" ]; then
  echo "- $onnx_file already present, skipping"
else
  echo "- Downloading $onnx_file (~27 MB) from Hugging Face..."
  curl -fL --progress-bar --create-dirs -o "$onnx_target" \
    "https://huggingface.co/jaehyun-ko/next-tdnn-onnx/resolve/main/$onnx_file"
  echo "  wrote $onnx_target"
fi

echo "All demo models are in place."
