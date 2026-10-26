#!/usr/bin/env bash
# Build every extension package's single-file bundle under its build/ directory.
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
for package in tool-bash tool-python sgai-formatter util-compaction tool-search tool-query; do
  bash "$root/scripts/build-extension.sh" "$package"
done
bash "$root/tool-subagentx/build.sh"
