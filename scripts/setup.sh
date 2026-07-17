#!/usr/bin/env bash
# One-shot setup after cloning: workspace install, library builds, the
# vosklet-speaker tarball the demo consumes, and the demo models.
# Requirements: pnpm, node, curl, unzip, tar.
set -euo pipefail
cd "$(dirname "$0")/.."

speaker_version="$(node -p "require('./vosklet-speaker/package.json').version")"
speaker_tgz="vosklet-speaker/vosklet-speaker-$speaker_version.tgz"

# demo-speaker consumes vosklet-speaker as a packed tarball, and pnpm cannot
# even install the workspace while that file is missing. Bootstrap with a
# minimal stub tarball; the real pack below overwrites it and the final
# install re-extracts it (pnpm notices the changed integrity).
if [ ! -f "$speaker_tgz" ]; then
  echo "- Creating bootstrap stub for $speaker_tgz"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  mkdir "$tmp/package"
  printf '{"name":"vosklet-speaker","version":"%s"}\n' "$speaker_version" \
    > "$tmp/package/package.json"
  tar -czf "$speaker_tgz" -C "$tmp" package
fi

echo "- Installing the workspace"
pnpm install

echo "- Building vosklet-mono and packing vosklet-speaker"
pnpm --filter vosklet-mono build
pnpm --filter vosklet-speaker exec npm pack

echo "- Reinstalling so the demo picks up the real tarball"
pnpm install

bash scripts/fetch-models.sh

echo
echo "Setup complete. Try:"
echo "  pnpm run demo:speaker         # speaker-verification demo (dev server)"
echo "  pnpm run demo:speaker:build   # production build"
