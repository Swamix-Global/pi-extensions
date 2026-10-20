#!/usr/bin/env bash
# Build one extension package to the single-file entry declared in its pi manifest.
set -euo pipefail
[ $# -eq 1 ] || { echo "usage: build-extension.sh <package-dir>" >&2; exit 2; }
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
package="$root/$1"
[ -f "$package/package.json" ] || { echo "not an extension package: $package" >&2; exit 2; }

entry="$(node -e 'const m = require(process.argv[1]); const e = m.pi?.extensions?.[0]; if (!e) { console.error("missing pi.extensions[0]: " + process.argv[1]); process.exit(1); } process.stdout.write(e);' "$package/package.json")"
BUN="${BUN:-$(command -v bun || echo "$HOME/.bun/bin/bun")}"

mkdir -p "$package/$(dirname "$entry")"
"$BUN" build "$package/src/index.ts" \
  --outfile "$package/$entry" \
  --target=node \
  --format=esm \
  --external "@earendil-works/pi-coding-agent" \
  --external "@earendil-works/pi-tui" \
  --external "@earendil-works/pi-ai" \
  --external "typebox"
# Keep only the manifest entry: bundles from earlier package names would otherwise linger
# in build/ and load twice for packages Pi registers by path.
find "$package/$(dirname "$entry")" -maxdepth 1 -type f ! -name "$(basename -- "$entry")" -delete
printf '%s/%s %s bytes\n' "${package#"$root/"}" "$entry" "$(wc -c < "$package/$entry")"
