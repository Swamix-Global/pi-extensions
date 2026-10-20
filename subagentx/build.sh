#!/usr/bin/env bash
# Single-file optimized build: extension source + third-party deps inlined,
# host-provided pi packages left external.
set -euo pipefail
cd "$(dirname "$0")"

BUN="${BUN:-$(command -v bun || echo "$HOME/.bun/bin/bun")}"
NODE_MODULES_SRC="${PI_AGENT_NODE_MODULES:-$HOME/.pi/agent/node_modules}"

# Build-time dependency resolution against the versions the agent runtime uses.
[ -e node_modules ] || ln -s "$NODE_MODULES_SRC" node_modules

mkdir -p build
"$BUN" build src/sgai-subagentx.ts \
  --outfile build/sgai-subagentx.js \
  --target=node \
  --format=esm \
  --minify \
  --external "@earendil-works/pi-coding-agent" \
  --external "@earendil-works/pi-tui" \
  --external "typebox"

wc -c build/sgai-subagentx.js
