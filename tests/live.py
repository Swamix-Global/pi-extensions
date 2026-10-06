"""Live local indexing; remote decisions run only when a key is supplied."""
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from query_engine import plan_project, query_project

with tempfile.TemporaryDirectory(prefix="query-live-") as tmp:
    root = Path(tmp) / "source"
    root.mkdir()
    store = Path(tmp) / "store"
    (root / "math.py").write_text("def add(a, b):\n    return a + b\n")
    preview = plan_project(str(root), str(store))
    assert preview["pending"]["added"] == ["math.py"]
    assert not store.exists()
    first = query_project(str(root), index_only=True, store_dir=str(store), progress=print)
    assert first["indexed"] == 1 and first["sync"]["updated"] == 1
    assert "add" in first["parts"][0]["files"][0]["summary"].lower()
    second = query_project(str(root), index_only=True, store_dir=str(store))
    assert second["sync"]["unchanged"] == 1
    (root / "math.py").unlink()
    (root / "subtract.py").write_text("def subtract(a, b):\n    return a - b\n")
    third = query_project(str(root), index_only=True, store_dir=str(store), progress=print)
    assert third["sync"] == {"updated": 1, "deleted": 1, "unchanged": 0}
    if os.environ.get("OPENROUTER_API_KEY"):
        answer = query_project(str(root), "Where is subtraction implemented?", store_dir=str(store))
        assert any(file["path"] == "subtract.py" for file in answer["files"])
        print("LIVE OpenRouter decision passed")
    else:
        print("SKIP live OpenRouter decision: OPENROUTER_API_KEY not set")
    print("LIVE SGLang indexing, incremental sync, and offline preview passed")
