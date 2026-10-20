"""Offline fanout validation tests: no network, no inference, no store writes.

Covers the material risk this layer exists for: citations must map to real
file lines with quotes rebuilt from disk, never from model output. Run:
``python3 -B tests/fanout_unit.py`` (from the repository root).
"""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from query_engine import fanout


def test_parse_content_strips_fences_and_control_chars():
    parsed = fanout._parse_content('```json\n{"findings": [], "unknowns": ["x"]}\n```')
    assert parsed == {"findings": [], "unknowns": ["x"]}
    # Raw newline inside a JSON string is tolerated (strict=False).
    parsed = fanout._parse_content('{"findings": [], "unknowns": ["two\nlines"]}')
    assert parsed["unknowns"] == ["two\nlines"]
    parsed = fanout._parse_content('prefix {"a": 1} suffix')
    assert parsed == {"a": 1}


def test_validate_maps_window_relative_ranges():
    file_lines = [f"line{i}" for i in range(1, 201)]
    window = {"path": "src.ts", "start": 101, "end": 125, "score": 1.0}
    parsed = {
        "findings": [
            {"startLine": 5, "endLine": 7, "claim": "Lines five to seven decide the payload path."},
            {"startLine": 130, "endLine": 140, "claim": "Out-of-window tail is clamped, not trusted."},
            {"startLine": 9, "endLine": 3, "claim": "Reversed ranges are rejected."},
            {"startLine": 2, "endLine": 2, "claim": ""},
            {"startLine": 2, "endLine": 2, "claim": "It is not shown in this window what happens."},
        ],
        "unknowns": ["callers not shown", "", "y" * 241, "ok gap"],
    }
    findings, rejected, unknowns = fanout.validate_findings(parsed, window, file_lines)
    assert rejected == 3  # reversed range, empty claim, absence statement
    assert len(findings) == 2
    assert findings[0]["startLine"] == 105 and findings[0]["endLine"] == 107
    assert findings[0]["quote"] == "line105\nline106\nline107"  # rebuilt from disk
    assert findings[1]["startLine"] == 125 and findings[1]["endLine"] == 125  # clamped to window
    assert unknowns == ["callers not shown", "ok gap"]


def test_validate_caps_span_length():
    file_lines = [f"l{i}" for i in range(1, 301)]
    window = {"path": "a.ts", "start": 1, "end": 125, "score": 1.0}
    parsed = {"findings": [{"startLine": 1, "endLine": 125, "claim": "Whole-window spans are capped."}],
              "unknowns": []}
    findings, _, _ = fanout.validate_findings(parsed, window, file_lines)
    assert findings[0]["endLine"] - findings[0]["startLine"] + 1 == fanout.MAX_SPAN_LINES


def test_select_windows_idf_and_caps():
    with tempfile.TemporaryDirectory(prefix="fanout-windows-") as tmp:
        root = Path(tmp)
        (root / "router.ts").write_text("service tier payload\n" + "filler\n" * 300 + "service tier again\n")
        (root / "noise.py").write_text("unrelated content\n" * 100)
        files = {
            str(root / "router.ts"): {"content": (root / "router.ts").read_text(), "content_hash": "a"},
            str(root / "noise.py"): {"content": (root / "noise.py").read_text(), "content_hash": "b"},
        }
        windows = fanout.select_windows(files, "where is the service tier payload applied", limit=5)
        assert all(w["path"] == str(root / "router.ts") for w in windows)
        assert len(windows) <= fanout.MAX_WINDOWS_PER_FILE
        assert windows[0]["start"] == 1  # first chapter holds both hits
        # Joined identifier forms add rare high-signal terms.
        terms = fanout.question_terms("how does formattedMarkdown handle the reply callback")
        assert "formattedmarkdown" in terms
        try:
            fanout.select_windows(files, "the and of", limit=5)
            raise AssertionError("stopword-only question must fail")
        except ValueError:
            pass


def test_assemble_packet_merges_and_truncates():
    files = {"src.ts": {"content": "\n".join(f"line{i}" for i in range(1, 41)), "content_hash": "h"}}
    windows = [{"path": "src.ts", "start": 1, "end": 40, "score": 1.0}]
    results = [{"findings": [
        {"startLine": 3, "endLine": 4, "quote": "line3\nline4", "claim": "A"},
        {"startLine": 6, "endLine": 6, "quote": "line6", "claim": "A"},  # duplicate claim
        {"startLine": 7, "endLine": 7, "quote": "line7", "claim": "B"},
        {"startLine": 30, "endLine": 30, "quote": "line30", "claim": "C"},
    ], "rejected": 1, "unknowns": ["u1", "u1", "u2"]}]
    packet = fanout.assemble_packet("/src", "q", "m", windows, results, files)
    spans = packet["evidence"][0]["spans"]
    assert [s["lines"] for s in spans] == ["3-7", "30-30"]  # gap <=3 lines merges
    assert spans[0]["quote"].startswith("line3") and "line7" in spans[0]["quote"]
    assert spans[0]["claims"] == ["A", "B"]
    assert packet["unknowns"] == ["u1", "u2"]
    assert packet["stats"] == {"findingsAccepted": 4, "findingsRejected": 1,
                              "windowsFailed": 0, "windowErrors": []}
    # Long spans are truncated with an explicit marker.
    results[0]["findings"].append({"startLine": 10, "endLine": 10 + fanout.QUOTE_MAX_LINES + 4,
                                   "quote": "x", "claim": "long"})
    packet = fanout.assemble_packet("/src", "q", "m", windows, results, files)
    long_spans = [s for s in packet["evidence"][0]["spans"] if s["truncated"]]
    assert long_spans and long_spans[0]["quote"].endswith("…")


def test_failed_window_counted_not_fatal():
    files = {"a.ts": {"content": "one\ntwo", "content_hash": "h"},
             "b.ts": {"content": "three", "content_hash": "i"}}
    windows = [{"path": "a.ts", "start": 1, "end": 2, "score": 1.0},
               {"path": "b.ts", "start": 1, "end": 1, "score": 0.5}]
    results = [{"error": "HTTP 500"}, {"findings": [{"startLine": 1, "endLine": 1, "quote": "one", "claim": "c"}],
                "rejected": 0, "unknowns": []}]
    packet = fanout.assemble_packet("/a", "q", "m", windows, results, files)
    assert packet["stats"]["windowsFailed"] == 1
    assert packet["evidence"][0]["spans"][0]["lines"] == "1-1"


def test_cli_enumerates_eligible_files():
    import subprocess, json as _json
    proc = subprocess.run(["python3", "-B", str(Path(__file__).resolve().parents[1] / "cli.py"),
                           "--folder", str(Path(__file__).resolve().parents[1]), "--list", "--json"],
                          capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
    result = _json.loads(proc.stdout)
    names = [f["path"].rsplit("/", 1)[-1] for f in result["files"]]
    assert "fanout.py" in names and "index.ts" in names and "AGENTS.md" in names
    assert not any(n.endswith(".env") or n == "package.json" for n in names)  # data/config stays out
    assert all(f["lines"] > 0 for f in result["files"])
    assert result["eligible"] == len(result["files"])


if __name__ == "__main__":
    for name, test in sorted(globals().items()):
        if name.startswith("test_"):
            test()
            print(f"pass {name}")
    print("fanout unit tests passed")
