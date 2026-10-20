#!/usr/bin/env bash
# Installer: build the single-file bundle, register this package with pi, and retire
# the stock ~/.pi/agent/extensions/sgai-subagentx.ts so pi never double-loads it.
set -euo pipefail
cd "$(dirname "$0")"
PKG="$PWD"

bash build.sh
bash ../install.sh

EXT="$HOME/.pi/agent/extensions/sgai-subagentx.ts"
if [ -f "$EXT" ] && [ ! -f "$EXT.disabled" ]; then
  mv "$EXT" "$EXT.disabled"
  echo "retired stock extension -> $EXT.disabled"
fi

if ! pi install "$PKG" 2>/dev/null; then
  python3 - "$PKG" <<'PY'
import json, os, sys
p = os.path.expanduser("~/.pi/agent/settings.json")
s = json.load(open(p))
pkgs = s.setdefault("packages", [])
base = os.path.dirname(p)
def norm(e):
    e = e if isinstance(e, str) else e.get("source", "")
    e = os.path.expanduser(e)
    return os.path.normpath(e if os.path.isabs(e) else os.path.join(base, e))
tgt = norm(sys.argv[1])
if not any(norm(e) == tgt for e in pkgs):
    pkgs.append(sys.argv[1])
    json.dump(s, open(p, "w"), indent=2)
PY
fi

echo "installed: $PKG (run /reload in pi)"
