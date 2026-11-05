#!/usr/bin/env bash
# Build every extension package's single-file bundle under its build/ directory.
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
for package in tool-scripting sgai-formatter util-compaction tool-search questionnaire; do
  bash "$root/scripts/build-extension.sh" "$package"
done
bash "$root/tool-filemap/build.sh"
bash "$root/tool-subagentx/build.sh"
