#!/usr/bin/env bash
# Build every extension package, then deploy the self-contained bundles as
# package folders under $PI_CODING_AGENT_DIR/extensions/<name>/.
set -euo pipefail

source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
packages=(tool-bash tool-python sgai-formatter util-compaction tool-search)

bash "$source_dir/scripts/build-all.sh"

install -d "$agent_dir/extensions"
rm -f "$agent_dir/lib/extension-settings.mjs"   # settings helper is inlined into every bundle

# Clean up retired pre-migration folders so pi does not load obsolete duplicates.
rm -rf "$agent_dir/extensions/smartbash" "$agent_dir/extensions/smartpython" "$agent_dir/extensions/openai-settings" "$agent_dir/extensions/fallback-compaction" "$agent_dir/extensions/search-tools"

for package in "${packages[@]}"; do
  target="$agent_dir/extensions/$package"
  install -d "$target"
  install -v -m 644 "$source_dir/$package/package.json" "$target/package.json"
  rm -rf "$target/build"
  cp -a "$source_dir/$package/build" "$target/build"
  # Purge stale bundles from earlier package names so only the manifest entry remains.
  entry="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["pi"]["extensions"][0])' "$target/package.json")"
  find "$target/build" -maxdepth 1 -type f ! -name "$(basename -- "$entry")" -print -delete
  # Retire artifacts from the pre-package layout, which pi would load twice.
  rm -f "$agent_dir/extensions/$package.ts" "$target/index.ts" "$target/index.js"
done

printf 'Extensions installed in %s/extensions. Run /reload in existing Pi sessions to activate.\n' "$agent_dir"
printf 'Packages tool-query and tool-subagentx register themselves: python3 tool-query/reinstall.py, bash tool-subagentx/install.sh.\n'
