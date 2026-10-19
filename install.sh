#!/usr/bin/env bash
set -euo pipefail

source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"

install -d "$agent_dir/extensions/search-tools" "$agent_dir/lib" "$agent_dir/tests"
install -v -m 644 "$source_dir/lib/extension-settings.mjs" "$agent_dir/lib/extension-settings.mjs"
install -v -m 644 "$source_dir"/smartbash.ts "$source_dir"/sgai-formatter.ts \
  "$source_dir"/openai-settings.ts "$source_dir"/fallback-compaction.ts "$agent_dir/extensions/"
install -v -m 644 "$source_dir/search-tools/index.ts" "$agent_dir/extensions/search-tools/index.ts"
install -v -m 644 "$source_dir"/tests/*.mjs "$agent_dir/tests/"
printf 'Extensions installed in %s. Run /reload in existing Pi sessions to activate.\n' "$agent_dir"
