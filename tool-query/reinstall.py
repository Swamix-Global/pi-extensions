"""Reinstall the local Pi package and retain its declaration as an absolute path."""
import json
import os
import subprocess
import tempfile
from pathlib import Path


def reinstall():
    """Use Pi's supported installer, preserving other settings and resource filters."""
    package = Path(__file__).resolve().parent
    agent = Path(os.environ.get("PI_CODING_AGENT_DIR", str(Path.home() / ".pi" / "agent")))
    if not agent.is_absolute():
        raise ValueError("PI_CODING_AGENT_DIR must be absolute")
    subprocess.run(["pi", "install", str(package)], check=True)
    settings = agent / "settings.json"
    if settings.is_symlink():
        raise RuntimeError(f"Refusing symlinked settings: {settings}")
    before = settings.read_bytes()
    state = json.loads(before)
    found = False
    for i, entry in enumerate(state.get("packages", [])):
        source = entry.get("source") if isinstance(entry, dict) else entry
        if not isinstance(source, str) or source.startswith(("npm:", "git:", "http:", "https:")):
            continue
        if (agent / source).resolve() != package:
            continue
        if isinstance(entry, dict):
            entry["source"] = str(package)
        else:
            state["packages"][i] = str(package)
        found = True
    if not found:
        raise RuntimeError(f"Pi did not register package: {package}")
    fd, temporary = tempfile.mkstemp(prefix=".query-install-", dir=agent)
    try:
        with os.fdopen(fd, "w") as handle:
            os.chmod(temporary, settings.stat().st_mode & 0o777)
            json.dump(state, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        if settings.read_bytes() != before:
            raise RuntimeError("Settings changed during reinstall; rerun instead of overwriting them")
        os.replace(temporary, settings)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print(f"Installed absolute package: {package}\nRun /reload to load the updated evidence tool.")


if __name__ == "__main__":
    reinstall()
