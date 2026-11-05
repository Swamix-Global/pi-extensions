#!/usr/bin/env bash
# Build tool-filemap: release Rust binary + single-file JS bundle, binary placed
# beside the bundle (build/filemap + build/tool-filemap.js).
set -euo pipefail
cd "$(dirname "$0")"

BUN="${BUN:-$(command -v bun || echo "$HOME/.bun/bin/bun")}"
CARGO="${CARGO:-$(command -v cargo || echo "$HOME/.cargo/bin/cargo")}"
NODE_MODULES_SRC="${PI_AGENT_NODE_MODULES:-$HOME/.pi/agent/node_modules}"

[ -e node_modules ] || ln -s "$NODE_MODULES_SRC" node_modules

"$CARGO" build --release --manifest-path native/Cargo.toml --offline \
  || "$CARGO" build --release --manifest-path native/Cargo.toml

mkdir -p build
cp native/target/release/filemap build/filemap

"$BUN" build src/index.ts \
  --outfile build/tool-filemap.js \
  --target=node \
  --format=esm \
  --external "@earendil-works/pi-coding-agent" \
  --external "@earendil-works/pi-tui" \
  --external "typebox"

printf 'tool-filemap: bundle %s bytes, binary %s bytes\n' \
  "$(wc -c < build/tool-filemap.js)" "$(wc -c < build/filemap)"
