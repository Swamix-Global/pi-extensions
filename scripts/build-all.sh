#!/usr/bin/env bash
# Build every extension package's single-file bundle under its build/ directory.
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
for package in smartbash sgai-formatter openai-settings fallback-compaction search-tools query-engine; do
  bash "$root/scripts/build-extension.sh" "$package"
done
bash "$root/subagentx/build.sh"
