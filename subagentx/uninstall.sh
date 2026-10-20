#!/usr/bin/env bash
# Uninstaller: unregister this package from pi and restore the stock extension source.
set -euo pipefail
cd "$(dirname "$0")"
PKG="$PWD"

pi remove "$PKG" 2>/dev/null || python3 - "$PKG" <<'PY'
import json, os, sys
p = os.path.expanduser("~/.pi/agent/settings.json")
s = json.load(open(p))
pkgs = s.get("packages", [])
base = os.path.dirname(p)
def norm(e):
    e = e if isinstance(e, str) else e.get("source", "")
    e = os.path.expanduser(e)
    return os.path.normpath(e if os.path.isabs(e) else os.path.join(base, e))
tgt = norm(sys.argv[1])
kept = [e for e in pkgs if norm(e) != tgt]
if len(kept) != len(pkgs):
    s["packages"] = kept
    json.dump(s, open(p, "w"), indent=2)
PY

EXT="$HOME/.pi/agent/extensions/sgai-subagentx.ts.disabled"
if [ -f "$EXT" ] && [ ! -f "${EXT%.disabled}" ]; then
  mv "$EXT" "${EXT%.disabled}"
  echo "restored stock extension -> ${EXT%.disabled}"
fi

echo "uninstalled: $PKG (run /reload in pi)"
