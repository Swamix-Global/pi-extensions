#!/usr/bin/env bash
# Build every extension package, then deploy the self-contained bundles as
# package folders under $PI_CODING_AGENT_DIR/extensions/<name>/.
set -euo pipefail

source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
packages=(smartbash sgai-formatter openai-settings fallback-compaction search-tools)

bash "$source_dir/scripts/build-all.sh"

install -d "$agent_dir/extensions"
rm -f "$agent_dir/lib/extension-settings.mjs"   # settings helper is inlined into every bundle

for package in "${packages[@]}"; do
  target="$agent_dir/extensions/$package"
  install -d "$target"
  install -v -m 644 "$source_dir/$package/package.json" "$target/package.json"
  rm -rf "$target/build"
  cp -a "$source_dir/$package/build" "$target/build"
  # Retire artifacts from the pre-package layout, which pi would load twice.
  rm -f "$agent_dir/extensions/$package.ts" "$target/index.ts" "$target/index.js"
done

printf 'Extensions installed in %s/extensions. Run /reload in existing Pi sessions to activate.\n' "$agent_dir"
printf 'Packages query-engine and subagentx register themselves: python3 query-engine/reinstall.py, bash subagentx/install.sh.\n'
