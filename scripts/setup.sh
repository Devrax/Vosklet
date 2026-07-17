#!/usr/bin/env bash
# One-shot setup after cloning: workspace install, library builds, the
# speaklet tarball the demo consumes, and the demo models.
# Requirements: pnpm, node, curl, unzip, tar.
set -euo pipefail
cd "$(dirname "$0")/.."

monosklet_version="$(node -p "require('./monosklet/package.json').version")"
monosklet_tgz="monosklet/monosklet-$monosklet_version.tgz"
speaklet_version="$(node -p "require('./speaklet/package.json').version")"
speaklet_tgz="speaklet/speaklet-$speaklet_version.tgz"

# The demo app consumes both libraries as packed tarballs, and pnpm cannot
# install the workspace while either file is missing. Bootstrap each missing
# archive with a minimal package; the real packs below overwrite them and the
# final install re-extracts them.
bootstrap_package() {
  package_name="$1"
  package_version="$2"
  package_tgz="$3"
  if [ ! -f "$package_tgz" ]; then
    echo "- Creating bootstrap stub for $package_tgz"
    bootstrap_dir="$(mktemp -d)"
    mkdir "$bootstrap_dir/package"
    printf '{"name":"%s","version":"%s"}\n' \
      "$package_name" "$package_version" > "$bootstrap_dir/package/package.json"
    tar -czf "$package_tgz" -C "$bootstrap_dir" package
    rm -rf "$bootstrap_dir"
  fi
}

bootstrap_package "monosklet" "$monosklet_version" "$monosklet_tgz"
bootstrap_package "speaklet" "$speaklet_version" "$speaklet_tgz"

echo "- Installing the workspace"
pnpm install

echo "- Packing monosklet and speaklet"
pnpm --filter monosklet exec npm pack
pnpm --filter speaklet exec npm pack

echo "- Reinstalling so the demo picks up the real tarball"
pnpm install

bash scripts/fetch-models.sh

echo
echo "Setup complete. Try:"
echo "  pnpm run demo         # dev server: home page routing to every example"
echo "  pnpm run demo:build   # production build"
