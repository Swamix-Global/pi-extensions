"""Live CLI scenarios: real ``python3 -B cli.py`` subprocesses over disposable
absolute source/store paths with ``PI_QUERY_STORE_DIR``. No mocks, network,
inference, unittest or query_engine imports; store state is observed with
sqlite3 only. Queries return whole-file structural maps, never source excerpts.
Run: ``python3 -B tests/live.py``."""
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import tempfile
import textwrap
from pathlib import Path

CLI = Path(__file__).resolve().parents[1] / "cli.py"
MAP_WORD_LIMIT = 100


def _spawn(store, args):
    """Run the real CLI with an absolute PI_QUERY_STORE_DIR override."""
    env = {**os.environ, "PI_QUERY_STORE_DIR": os.path.abspath(str(store))}
    return subprocess.run(["python3", "-B", str(CLI), *args],
                          env=env, capture_output=True, text=True)


def _run(store, *args):
    """Run the real CLI with --json; stdout is one JSON document."""
    return _spawn(store, (*args, "--json"))


def _run_text(store, *args):
    """Run the real CLI without --json; stdout is the rendered bullet map."""
    return _spawn(store, args)


def _load(proc):
    """Parse the single JSON document the CLI prints on stdout."""
    assert proc.stdout.strip(), f"no JSON output; stderr: {proc.stderr}"
    return json.loads(proc.stdout)


def _database(store, root):
    """Return the per-folder database path the CLI derives from a canonical root."""
    key = hashlib.sha256(os.path.realpath(str(root)).encode("utf-8")).hexdigest()
    return Path(store) / (key + ".db")


def _rows(db):
    """Return {absolute path: content_hash} rows from the store database."""
    with sqlite3.connect(db) as conn:
        return dict(conn.execute("SELECT path, content_hash FROM files"))


def _sha(path):
    """Return a file's actual SHA-256 byte digest."""
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _write(root, relative, content, mode=None):
    """Write a UTF-8 fixture under root and return its absolute path."""
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    if mode is not None:
        os.chmod(path, mode)
    return path


def _line_count(path):
    """Return physical lines in an absolute source, matching the map's last endLine."""
    content = Path(path).read_text(encoding="utf-8")
    return len(content.split("\n")) - (1 if content.endswith("\n") else 0)


def _map_words(record):
    """Count name plus purpose words in one whole-file map."""
    return sum(len((section["name"] + " " + section["purpose"]).split()) for section in record["sections"])


def _assert_map(record, expected, map_kind):
    """Assert one exact whole-file map: ordered sections partitioning every physical line."""
    assert record["mapKind"] == map_kind, f"{record['path']} map kind"
    sections = record["sections"]
    actual = [(s["line"], s["endLine"], s["name"], s["purpose"]) for s in sections]
    assert actual == expected, f"map mismatch for {record['path']}"
    assert sections[0]["line"] == 1, "maps must start at the first physical line"
    for previous, section in zip(sections, sections[1:]):
        assert previous["endLine"] + 1 == section["line"], "sections must be consecutive"
    assert sections[-1]["endLine"] == _line_count(record["path"]), "maps must reach the final physical line"


def scenario_dry_run_and_query():
    """Scenario 1: dry-run filtering, exact whole-file maps, contract scope and context reduction."""
    with tempfile.TemporaryDirectory(prefix="query-live-s1-") as tmp:
        base = Path(tmp).resolve()
        root = base / "source"
        root.mkdir()
        store = base / "store"

        help_proc = _run(store, "--help")
        assert help_proc.returncode == 0 and "Local hash-only query engine" in help_proc.stdout

        # A 1999-line unparsable Python file whose only marker sits at line 1900.
        lines = [f"filler line {i:04d}" for i in range(1999)]
        lines[1899] = "UNIQUE_TAIL_MARKER = compute()"
        tail = _write(root, "tail.py", "\n".join(lines) + "\n")

        # Representative fixtures: Python, C++, shell, batch, Markdown, build and scripts.
        module = _write(root, "module.py", textwrap.dedent('''\
            """Widget module: def fake_in_docstring(): not a declaration."""

            # def commented_function(): return None

            import os
            import sys

            MAX_RETRIES = 3
            DEFAULT_NAME = "widget"

            class Greeter:
                """Greeter class."""

                def greet(self, name):
                    body = "MODULE_BODY_SENTINEL"
                    return f"hello {name}"

                def shout(self):
                    return "HI"

            def top_level(flag):
                return flag
            '''))
        engine = _write(root, "engine.cpp", textwrap.dedent('''\
            #include <string>
            #include <vector>

            #define MAX_RETRIES 3
            #define TIMEOUT_MS 100

            // Widget worker declaration.
            namespace demo {

            class Worker {
            public:
                // void commented_out() { return; }

                // Add two numbers.
                int add(
                    int left,
                    int right) {
                    int total = left + right;
                    return total;
                }

                void reset() {
                    std::string body = "CPP_BODY_SENTINEL";
                }
            };

            // Free helper.
            int free_function(int value) {
                return value;
            }

            int Worker::scale(
                int factor) {
                return factor * factor;
            }

            }
            '''))
        shell = _write(root, "deploy.sh", textwrap.dedent('''\
            #!/usr/bin/env bash
            set -euo pipefail

            # fake_function() { echo commented; }

            APP_NAME=widget
            RETRIES=3

            # Log a message.
            log() {
                echo "SHELL_BODY_SENTINEL: $1"
            }

            # Deploy the app.
            deploy() {
                local target="$1"
                log "$target"
            }

            if [ -n "${TARGET:-}" ]; then
                deploy "$TARGET"
            fi
            '''))
        batch = _write(root, "run.bat", textwrap.dedent('''\
            @echo off
            setlocal

            set TARGET=release
            set VERBOSE=0

            rem Build the widget.
            :build
            echo BATCH_BODY_SENTINEL
            goto :done

            rem Mark completion.
            :done
            echo done
            exit /b 0
            '''))
        guide = _write(root, "README.md", textwrap.dedent('''\
            # Widget Guide

            Short introduction to widgets.

            ## Install

            Run make.

            ```sh
            # fenced-fake-heading
            ```

            <!-- # hidden-fake-heading -->

            ## Usage

            Setext Section
            ==============

            Call deploy after install.

            MARKDOWN_BODY_SENTINEL stays in the body.
            '''))
        architecture = _write(root, "ARCHITECTURE.md", textwrap.dedent('''\
            # Architecture

            Components and flow.

            ## Storage

            Topology: ARCH_BODY_SENTINEL.

            ## Retrieval

            BM25 and TF-IDF.
            '''))
        tool = _write(root, "tool", textwrap.dedent('''\
            #!/usr/bin/env python3
            """Executable widget tool."""

            import sys

            def main(argv):
                print("TOOL_BODY_SENTINEL", argv)

            if __name__ == "__main__":
                main(sys.argv[1:])
            '''), mode=0o755)
        makefile = _write(root, "Makefile", textwrap.dedent('''\
            # Widget build.

            BINARY = widget
            FLAGS = -O2

            build: $(BINARY)

            $(BINARY):
            \techo MAKE_BODY_SENTINEL
            \tcc $(FLAGS) -o $(BINARY) main.c

            clean:
            \trm -f $(BINARY)
            '''))
        ninja = _write(root, "build.ninja", textwrap.dedent('''\
            # Widget ninja build.

            rule cc
                command = cc -O2 -o $out $in && echo BUILD_BODY_SENTINEL

            build widget: cc main.c

            build test: cc test.c
            '''))
        styles = _write(root, "styles.css", textwrap.dedent('''\
            /* Widget styles. */

            .widget {
                color: red;
            }

            .badge {
                content: "CSS_BODY_SENTINEL";
            }
            '''))

        # Adversarial shell and C++ fakes, env-shebang scripts, unsupported grammars and density.
        heredoc = _write(root, "heredoc.sh", textwrap.dedent('''\
            #!/usr/bin/env bash
            set -euo pipefail

            # Real heredoc helper.
            heredoc_real() {
                echo heredoc
            }

            cat <<'EOF' > generated
            heredoc_fake_function() { echo fake; }
            if [ -n "$FAKE" ]; then
                echo fake
            fi
            EOF

            # Final heredoc helper.
            heredoc_final() {
                echo final
            }
            '''))
        raw = _write(root, "raw.cpp", textwrap.dedent('''\
            #include <string>

            // Real raw worker.
            int raw_compute(int value) {
                const char* text = R"tag(
            fake_raw_function() { return 0; }
            #define FAKE_MACRO 1
            )tag";
                return value;
            }
            '''))
        env_sh = _write(root, "env-sh", textwrap.dedent('''\
            #!/bin/sh
            # Run env sh script.
            env_sh_run() {
                echo env_sh
            }
            '''), mode=0o755)
        env_bash = _write(root, "env-bash", textwrap.dedent('''\
            #!/usr/bin/env bash
            set -euo pipefail

            # Build env bash script.
            env_bash_build() {
                echo env_bash
            }
            '''), mode=0o755)
        env_zsh = _write(root, "env-zsh", textwrap.dedent('''\
            #!/usr/bin/env zsh

            # Deploy env zsh script.
            env_zsh_deploy() {
                echo env_zsh
            }
            '''), mode=0o755)
        env_fish = _write(root, "env-fish", textwrap.dedent('''\
            #!/usr/bin/env fish
            set -gx ENV_FISH_FLAG widget

            if test -n "$ENV_FISH_FLAG"
                echo "$ENV_FISH_FLAG"
            end
            '''), mode=0o755)
        golang = _write(root, "main.go", textwrap.dedent('''\
            package main

            import "fmt"

            func main() {
                fmt.Println("golang_probe")
            }
            '''))
        rust = _write(root, "lib.rs", textwrap.dedent('''\
            // Rust probe for rust_probe.
            pub fn rust_compute(value: i32) -> i32 {
                value + 1
            }
            '''))
        dense_names = [f"dense_step_{index:02d}" for index in range(18)]
        dense_lines = []
        for index, name in enumerate(dense_names):
            dense_lines += [f"def {name}(value):",
                            f'    """Process dense step {index:02d} input value and return it unchanged."""',
                            "    return value",
                            ""]
        dense = _write(root, "dense.py", "\n".join(dense_lines))
        other = _write(root, "other.py", "def unrelated():\n    return 1\n")
        package = _write(root, "realpkg/pkg.py", "def pkg_helper():\n    return None\n")

        eligible = [architecture, makefile, guide, ninja, shell, engine, module, other,
                    package, batch, styles, tail, tool, heredoc, raw, env_sh, env_bash,
                    env_zsh, env_fish, golang, rust, dense]
        expected_sources = sorted(str(path) for path in eligible)

        # Excluded formats, sources and paths. The omitted token must never be reachable.
        omitted = "ZZQ_EXCLUDED_FIXTURE"
        excluded = [
            _write(root, "notes.txt", f"TXT text {omitted}\n"),
            _write(root, "page.html", f"<p>{omitted}</p>\n"),
            _write(root, "data.json", f'{{"excluded": "{omitted}"}}\n'),
            _write(root, "config.yaml", f"excluded: {omitted}\n"),
            _write(root, "settings.toml", f'excluded = "{omitted}"\n'),
            _write(root, "notes.md", f"# Notes\n\n{omitted}\n"),
            _write(root, "ignored.py", f'def ignored_fixture():\n    return "{omitted}"\n'),
            _write(root, "generated/kept.py", f'def generated_fixture():\n    return "{omitted}"\n'),
            _write(root, "node_modules/dependency.py", f'def dependency_fixture():\n    return "{omitted}"\n'),
            _write(root, ".venv/lib.py", f'def venv_fixture():\n    return "{omitted}"\n'),
            _write(root, "tool-noexec", f"#!/usr/bin/env python3\n{omitted} = 1\n", mode=0o644),
        ]
        linked = root / "linked.py"
        os.symlink(other, linked)
        aliasdir = root / "aliasdir"
        os.symlink(root / "realpkg", aliasdir)
        excluded += [linked, aliasdir]
        (root / ".gitignore").write_text("ignored.py\ngenerated/\n", encoding="utf-8")
        subprocess.run(["git", "init", "-q", str(root)], check=True, capture_output=True, text=True)

        # Dry-run: same scanner/hashes, absolute pending paths, no store created.
        dry = _run(store, "--folder", str(root), "--dry-run")
        assert dry.returncode == 0, dry.stderr
        plan = _load(dry)
        assert plan["dryRun"] is True
        assert plan["eligible"] == len(expected_sources)
        assert plan["pending"] == {"added": expected_sources, "changed": [], "deleted": [], "unchanged": []}
        for path in excluded:
            assert str(path) not in plan["pending"]["added"], f"{path} must not be indexed"
        assert plan["database"] == str(_database(store, root))
        assert Path(plan["database"]).is_absolute()
        assert not store.exists(), "dry-run must not create the store"

        # Real query: full-source tail match with a compressed excerpt-free map.
        found = _run(store, "--folder", str(root), "--question", "unique_tail_marker")
        assert found.returncode == 0, found.stderr
        result = _load(found)
        assert result["sync"] == {"updated": len(expected_sources), "deleted": 0, "unchanged": 0}
        assert result["indexed"] == len(expected_sources)
        assert [file["path"] for file in result["files"]] == [str(tail)], "tail match must outrank filler"
        top = result["files"][0]
        assert Path(top["path"]).is_absolute()
        assert top["line"] == 1900, "marker at the end of the 1999-line source must be located"
        assert top["score"] > 0 and top["bm25"] > 0 and top["tfidf"] > 0
        assert "excerpt" not in top, "maps replace source excerpts"
        assert set(top) == {"path", "score", "bm25", "tfidf", "reason", "line", "sections", "mapKind"}
        _assert_map(top, [(1, 1999, "block 1", "source block")], "fallback")
        tail_text = tail.read_text(encoding="utf-8")
        assert len(found.stdout) * 20 < len(tail_text), "query output must be far smaller than the source"
        assert len(json.dumps(top["sections"])) * 50 < len(tail_text), "map must compress the source"

        # Minimal schema: exactly project + files(path, content_hash).
        db = _database(store, root)
        assert _rows(db) == {path: _sha(path) for path in expected_sources}
        with sqlite3.connect(db) as conn:
            assert [r[1] for r in conn.execute("PRAGMA table_info(files)")] == ["path", "content_hash"]
            assert {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")} == {"project", "files"}
            assert conn.execute("SELECT folder FROM project WHERE id=1").fetchone()[0] == str(root)

        # No match returns an empty list, not invented evidence.
        none = _load(_run(store, "--folder", str(root), "--question", "absent_symbol_xyz"))
        assert none["files"] == [] and "No lexical matches" in none["answer"]
        hidden = _load(_run(store, "--folder", str(root), "--question", "zzq_excluded_fixture"))
        assert hidden["files"] == [], "excluded formats, ignored paths, symlinks and dependencies stay unindexed"

        # Contract scope: only a query rooted exactly at .pi/subagents/contracts includes
        # Markdown, skips Git ignore and excludes *.claim dirs; other paths keep rules.
        project = base / "contracts-project"
        contracts = project / ".pi/subagents/contracts"
        contracts.mkdir(parents=True)
        (project / ".gitignore").write_text("/.pi/subagents/contracts/*\n/src/ignored.py\n", encoding="utf-8")
        contract_files = []
        for name, body in (("contract-01.md", "zebra zebra zebra\n"), ("contract-02.md", "zebra\n"),
                           ("contract-03.md", "zebra\n"), ("contract-04.md", "zebra\n"),
                           ("contract-05.md", "zebra\n"), ("contract-06.md", "zebra\n"),
                           ("contract-07.md", "octopus\n")):
            contract_files.append(_write(contracts, name, body))
        claim = contracts / "contract-01.claim"
        claim.mkdir()
        (claim / "owner.md").write_text("zebra zebra zebra zebra zebra\n", encoding="utf-8")
        kept = _write(project, "src/kept.py", "def walrus(): return 'zebra'\n")
        ignored = _write(project, "src/ignored.py", "def walrus(): return 'zebra'\n")
        _write(project, "src/notes.md", "walrus zebra\n")
        subprocess.run(["git", "-C", str(project), "init", "-q"], check=True, capture_output=True, text=True)
        probe = subprocess.run(["git", "-C", str(project), "check-ignore", *map(str, [*contract_files, ignored])],
                               capture_output=True, text=True)
        assert probe.returncode == 0 and set(probe.stdout.split()) == {str(p) for p in [*contract_files, ignored]}, \
            "contract and ordinary fixtures must be genuinely Git-ignored"

        # The same scanner previews contract scope: Markdown eligible, claim owner.md excluded.
        contract_plan = _load(_run(store, "--folder", str(contracts), "--dry-run"))
        assert contract_plan["eligible"] == 7
        assert contract_plan["pending"]["added"] == [str(p) for p in contract_files]

        # Zero, one and six matches with deterministic ranking and irrelevant filtering.
        none_contract = _load(_run(store, "--folder", str(contracts), "--question", "quasar"))
        assert none_contract["files"] == [] and "No lexical matches" in none_contract["answer"]
        one_contract = _load(_run(store, "--folder", str(contracts), "--question", "octopus"))
        assert [f["path"] for f in one_contract["files"]] == [str(contracts / "contract-07.md")]
        six_contract = _load(_run(store, "--folder", str(contracts), "--question", "zebra"))
        assert [f["path"] for f in six_contract["files"]] == [str(p) for p in contract_files[:6]], \
            "contract scope must return all six positive candidates in stable order"
        repeat_contract = _load(_run(store, "--folder", str(contracts), "--question", "zebra"))
        assert [f["path"] for f in repeat_contract["files"]] == [f["path"] for f in six_contract["files"]], \
            "contract ranking must be deterministic"
        assert all(f["score"] > 0 and Path(f["path"]).is_absolute() for f in six_contract["files"])
        assert _rows(_database(store, contracts)) == {str(p): _sha(p) for p in contract_files}, \
            "claim owner.md must stay out of the index"

        # Ordinary source queries in the same Git repo still skip ignored files and unlisted Markdown.
        src = project / "src"
        src_plan = _load(_run(store, "--folder", str(src), "--dry-run"))
        assert src_plan["pending"]["added"] == [str(kept)]
        ordinary = _load(_run(store, "--folder", str(src), "--question", "walrus"))
        assert [f["path"] for f in ordinary["files"]] == [str(kept)], \
            "ordinary queries must keep Git ignore and unlisted-Markdown rules"

        # Relative source folder is a runtime failure.
        rel = _run(store, "--folder", "relative", "--dry-run")
        assert rel.returncode == 1 and "absolute" in _load(rel)["error"]

        # Every representative fixture returns its exact declaration/heading map.
        fixtures = {
            "tail.py": ("unique_tail_marker", "fallback", [
                (1, 1999, "block 1", "source block")]),
            "module.py": ("greeter", "structural", [
                (1, 4, "preamble", "leading comments and setup"),
                (5, 7, "imports", "imports os, sys"),
                (8, 10, "configuration", "2 module assignments"),
                (11, 13, "Greeter", "Greeter class"),
                (14, 17, "greet", "greet"),
                (18, 20, "shout", "shout"),
                (21, 22, "top_level", "top level")]),
            "engine.cpp": ("timeout_ms", "structural", [
                (1, 3, "includes", "2 include directives"),
                (4, 7, "defines", "2 macros"),
                (8, 9, "demo", "Widget worker declaration."),
                (10, 14, "Worker", "class"),
                (15, 21, "add", "Add two numbers."),
                (22, 27, "reset", "reset"),
                (28, 31, "free_function", "Free helper."),
                (32, 37, "Worker::scale", "worker scale")]),
            "deploy.sh": ("app_name", "structural", [
                (1, 5, "preamble", "leading comments and setup"),
                (6, 9, "configuration", "2 variables"),
                (10, 14, "log", "Log a message."),
                (15, 19, "deploy", "Deploy the app."),
                (20, 22, "if", "conditional block")]),
            "run.bat": ("setlocal", "structural", [
                (1, 3, "preamble", "leading comments and setup"),
                (4, 7, "configuration", "2 variables"),
                (8, 12, "build", "Build the widget."),
                (13, 15, "done", "Mark completion.")]),
            "README.md": ("guide", "structural", [
                (1, 4, "Widget Guide", "level 1 heading: Widget Guide"),
                (5, 14, "Install", "level 2 heading: Install"),
                (15, 16, "Usage", "level 2 heading: Usage"),
                (17, 22, "Setext Section", "level 1 heading: Setext Section")]),
            "ARCHITECTURE.md": ("topology", "structural", [
                (1, 4, "Architecture", "level 1 heading: Architecture"),
                (5, 8, "Storage", "level 2 heading: Storage"),
                (9, 11, "Retrieval", "level 2 heading: Retrieval")]),
            "tool": ("argv", "structural", [
                (1, 3, "preamble", "leading comments and setup"),
                (4, 5, "imports", "imports sys"),
                (6, 8, "main", "main"),
                (9, 10, "entrypoint", "script entrypoint")]),
            "Makefile": ("binary", "fallback", [
                (1, 2, "block 1", "source block"),
                (3, 5, "block 2", "source block"),
                (6, 7, "block 3", "source block"),
                (8, 11, "block 4", "source block"),
                (12, 13, "block 5", "source block")]),
            "build.ninja": ("ninja", "fallback", [
                (1, 2, "block 1", "source block"),
                (3, 5, "block 2", "source block"),
                (6, 7, "block 3", "source block"),
                (8, 8, "block 4", "source block")]),
            "styles.css": ("badge", "fallback", [
                (1, 2, "block 1", "source block"),
                (3, 6, "block 2", "source block"),
                (7, 9, "block 3", "source block")]),
            "heredoc.sh": ("heredoc_real", "structural", [
                (1, 4, "preamble", "leading comments and setup"),
                (5, 16, "heredoc_real", "Real heredoc helper."),
                (17, 19, "heredoc_final", "Final heredoc helper.")]),
            "raw.cpp": ("raw_compute", "structural", [
                (1, 3, "includes", "1 include directives"),
                (4, 10, "raw_compute", "Real raw worker.")]),
            "env-sh": ("env_sh_run", "structural", [
                (1, 2, "preamble", "leading comments and setup"),
                (3, 5, "env_sh_run", "Run env sh script.")]),
            "env-bash": ("env_bash_build", "structural", [
                (1, 4, "preamble", "leading comments and setup"),
                (5, 7, "env_bash_build", "Build env bash script.")]),
            "env-zsh": ("env_zsh_deploy", "structural", [
                (1, 3, "preamble", "leading comments and setup"),
                (4, 6, "env_zsh_deploy", "Deploy env zsh script.")]),
            "env-fish": ("env_fish_flag", "structural", [
                (1, 3, "preamble", "leading comments and setup"),
                (4, 6, "if", "conditional block")]),
            "main.go": ("golang_probe", "fallback", [
                (1, 2, "block 1", "source block"),
                (3, 4, "block 2", "source block"),
                (5, 7, "block 3", "source block")]),
            "lib.rs": ("rust_probe", "fallback", [
                (1, 4, "block 1", "source block")]),
            "other.py": ("unrelated", "structural", [
                (1, 2, "unrelated", "unrelated")]),
            "realpkg/pkg.py": ("pkg_helper", "structural", [
                (1, 2, "pkg_helper", "pkg helper")]),
        }
        maps = {}
        for relative, (question, map_kind, expected) in fixtures.items():
            data = _load(_run(store, "--folder", str(root), "--question", question))
            matches = [file for file in data["files"] if file["path"] == str(root / relative)]
            assert len(matches) == 1, f"{relative} must be ranked for {question!r}"
            record = matches[0]
            assert record["score"] > 0 and record["bm25"] > 0 and record["tfidf"] > 0
            assert "excerpt" not in record
            _assert_map(record, expected, map_kind)
            maps[relative] = record

        # Dense file: every declared function survives while purposes adapt to the budget.
        dense_data = _load(_run(store, "--folder", str(root), "--question", "dense_step_00"))
        dense_matches = [file for file in dense_data["files"] if file["path"] == str(dense)]
        assert len(dense_matches) == 1, "dense.py must be ranked for dense_step_00"
        dense_record = dense_matches[0]
        assert dense_record["mapKind"] == "structural"
        assert [section["name"] for section in dense_record["sections"]] == dense_names, \
            "dense maps must preserve every declared function name"
        assert all(len(section["purpose"].split()) <= 4 for section in dense_record["sections"]), \
            "dense purposes must fit the adaptive allowance"
        maps["dense.py"] = dense_record

        # Every representative map is actually near a hundred words, not just smaller by ratio.
        for relative, record in maps.items():
            words = _map_words(record)
            assert words <= MAP_WORD_LIMIT, f"{relative} map must stay near a hundred words, got {words}"

        # Fenced, commented and docstring fakes never become map names or purposes.
        fakes = [("module.py", "commented_function"), ("module.py", "fake_in_docstring"),
                 ("engine.cpp", "commented_out"), ("deploy.sh", "fake_function"),
                 ("README.md", "fenced-fake-heading"), ("README.md", "hidden-fake-heading"),
                 ("heredoc.sh", "heredoc_fake_function"), ("raw.cpp", "fake_raw_function"),
                 ("raw.cpp", "FAKE_MACRO"), ("main.go", "main"), ("lib.rs", "rust_compute")]
        for relative, fake in fakes:
            assert fake not in json.dumps(maps[relative]["sections"]), \
                f"{fake} must not appear in the {relative} map"
        assert maps["styles.css"]["mapKind"] == "fallback", "unsupported languages map as fallback blocks"

        # Deterministic, sentinel-free and compact rendered context.
        broad = _load(_run(store, "--folder", str(root), "--question", "sentinel"))
        repeat = _load(_run(store, "--folder", str(root), "--question", "sentinel"))
        assert repeat["answer"] == broad["answer"] and repeat["files"] == broad["files"], \
            "retrieval output must be deterministic"
        sentinel_files = {"module.py", "engine.cpp", "deploy.sh", "run.bat", "README.md", "tool",
                          "Makefile", "build.ninja", "styles.css", "ARCHITECTURE.md"}
        assert {Path(file["path"]).name for file in broad["files"]} == sentinel_files
        sentinels = ["MODULE_BODY_SENTINEL", "CPP_BODY_SENTINEL", "SHELL_BODY_SENTINEL", "BATCH_BODY_SENTINEL",
                     "MARKDOWN_BODY_SENTINEL", "ARCH_BODY_SENTINEL", "TOOL_BODY_SENTINEL", "MAKE_BODY_SENTINEL",
                     "BUILD_BODY_SENTINEL", "CSS_BODY_SENTINEL", omitted]
        assert all(token not in json.dumps(broad["files"]) for token in sentinels), "source bodies leak into maps"
        map_words = sum(_map_words(file) for file in broad["files"])
        source_words = sum(len(Path(path).read_text(encoding="utf-8").split()) for path in expected_sources)
        assert map_words * 20 < source_words, "map words must stay far below source words"

        text = _run_text(store, "--folder", str(root), "--question", "sentinel")
        assert text.returncode == 0, text.stderr
        output_lines = text.stdout.splitlines()
        start = output_lines.index("File maps (in order):")
        end = next(i for i in range(start + 1, len(output_lines)) if output_lines[i].startswith("Limitations:"))
        map_lines = [line for line in output_lines[start + 1:end] if line.strip()]
        assert map_lines and all(line.startswith("- ") or line.startswith("  - ") for line in map_lines), \
            "rendered maps must be bullet-only"
        assert "Excerpt" not in text.stdout and all(token not in text.stdout for token in sentinels)
        assert len(text.stdout.split()) * 10 < source_words, "rendered context must stay compact"


def scenario_hash_lifecycle():
    """Scenario 2: hash-only freshness, read-only dry-run, deletion and forced reindex."""
    with tempfile.TemporaryDirectory(prefix="query-live-s2-") as tmp:
        base = Path(tmp).resolve()
        root = base / "source"
        root.mkdir()
        store = base / "store"
        alpha = root / "alpha.py"
        alpha.write_text("def addition(a, b): return a + b\n", encoding="utf-8")
        beta = root / "beta.py"
        beta.write_text("echo add\n", encoding="utf-8")

        first = _load(_run(store, "--folder", str(root), "--index-only"))
        assert first["sync"] == {"updated": 2, "deleted": 0, "unchanged": 0}
        db = _database(store, root)
        assert _rows(db) == {str(alpha): _sha(alpha), str(beta): _sha(beta)}

        # Real trigger records every deleted path, proving stale rows leave before replacements.
        with sqlite3.connect(db) as conn:
            conn.execute("CREATE TABLE deletes(path TEXT)")
            conn.execute("CREATE TRIGGER record_delete AFTER DELETE ON files "
                         "BEGIN INSERT INTO deletes VALUES (OLD.path); END")

        # Equal-length edit with the original mtime restored still reindexes by hash.
        before = alpha.stat()
        alpha.write_text("def addition(a, b): return a - b\n", encoding="utf-8")
        os.utime(alpha, ns=(before.st_atime_ns, before.st_mtime_ns))
        assert alpha.stat().st_size == before.st_size and alpha.stat().st_mtime_ns == before.st_mtime_ns
        changed = _load(_run(store, "--folder", str(root), "--index-only"))
        assert changed["sync"] == {"updated": 1, "deleted": 0, "unchanged": 1}
        assert _rows(db) == {str(alpha): _sha(alpha), str(beta): _sha(beta)}
        with sqlite3.connect(db) as conn:
            assert [r[0] for r in conn.execute("SELECT path FROM deletes")] == [str(alpha)]

        # Dry-run is read-only: database bytes are untouched.
        before_bytes = db.read_bytes()
        dry = _load(_run(store, "--folder", str(root), "--dry-run"))
        assert dry["pending"] == {"added": [], "changed": [], "deleted": [],
                                  "unchanged": [str(alpha), str(beta)]}
        assert db.read_bytes() == before_bytes, "dry-run must not change database bytes"

        # Deletion removes the stale row.
        beta.unlink()
        removed = _load(_run(store, "--folder", str(root), "--index-only"))
        assert removed["sync"] == {"updated": 0, "deleted": 1, "unchanged": 1}
        assert _rows(db) == {str(alpha): _sha(alpha)}

        # Force reindex replaces the unchanged row: trigger proves delete before insert.
        with sqlite3.connect(db) as conn:
            conn.execute("DELETE FROM deletes")
        forced = _load(_run(store, "--folder", str(root), "--index-only", "--reindex"))
        assert forced["sync"] == {"updated": 1, "deleted": 0, "unchanged": 0}
        assert _rows(db) == {str(alpha): _sha(alpha)}
        with sqlite3.connect(db) as conn:
            assert [r[0] for r in conn.execute("SELECT path FROM deletes")] == [str(alpha)]


def scenario_legacy_invalid_and_refusals():
    """Scenario 3: legacy migration, invalid UTF-8 invalidation and store refusals."""
    with tempfile.TemporaryDirectory(prefix="query-live-s3-") as tmp:
        base = Path(tmp).resolve()
        root = base / "source"
        root.mkdir()
        store = base / "store"
        store.mkdir()
        source = root / "marker.py"
        source.write_text("def legacy_marker(): return 1\n", encoding="utf-8")
        db = _database(store, root)
        with sqlite3.connect(db) as conn:
            conn.executescript(
                "CREATE TABLE project(id INTEGER PRIMARY KEY, folder TEXT);"
                "CREATE TABLE files(path TEXT PRIMARY KEY, summary TEXT, content_hash TEXT, index_time TEXT);"
                "CREATE TABLE map_cache(signature TEXT PRIMARY KEY, parts TEXT);")
            conn.execute("INSERT INTO project VALUES (1, ?)", (str(root),))
            conn.execute("INSERT INTO files VALUES (?, 'obsolete', ?, 'yesterday')",
                         (str(source), _sha(source)))

        # Legacy dry-run previews the changed row without migrating or writing.
        before = db.read_bytes()
        preview = _load(_run(store, "--folder", str(root), "--dry-run"))
        assert preview["indexed"] == 1
        assert preview["pending"]["changed"] == [str(source)]
        assert db.read_bytes() == before, "dry-run must not migrate the legacy database"
        with sqlite3.connect(db) as conn:
            assert [r[1] for r in conn.execute("PRAGMA table_info(files)")] == \
                ["path", "summary", "content_hash", "index_time"]
            assert conn.execute("SELECT name FROM sqlite_master WHERE name='map_cache'").fetchone()

        # Writable sync rebuilds to the minimal schema and rehashes the source.
        rebuilt = _load(_run(store, "--folder", str(root), "--question", "legacy_marker"))
        assert rebuilt["sync"] == {"updated": 1, "deleted": 0, "unchanged": 0}
        assert rebuilt["files"][0]["path"] == str(source)
        with sqlite3.connect(db) as conn:
            assert [r[1] for r in conn.execute("PRAGMA table_info(files)")] == ["path", "content_hash"]
            assert conn.execute("SELECT name FROM sqlite_master WHERE name='map_cache'").fetchone() is None
        assert _rows(db) == {str(source): _sha(source)}

        # Invalid UTF-8 scan exits nonzero, preserves cached rows; repaired source succeeds.
        bad = root / "bad.py"
        bad.write_bytes(b"legacy_marker \xff")
        failed = _run(store, "--folder", str(root), "--index-only")
        assert failed.returncode == 1 and "utf-8" in _load(failed)["error"].lower()
        assert _rows(db) == {str(source): _sha(source)}, "failed scan must preserve cached rows"
        bad.write_text("def repaired_marker(): return 2\n", encoding="utf-8")
        repaired = _load(_run(store, "--folder", str(root), "--question", "repaired_marker"))
        assert repaired["sync"] == {"updated": 1, "deleted": 0, "unchanged": 1}
        assert repaired["files"][0]["path"] == str(bad)
        assert _rows(db) == {str(source): _sha(source), str(bad): _sha(bad)}

        # Cross-folder identity, hardlinked database and symlinked store are refused.
        other = base / "other"
        other.mkdir()
        shutil.copy2(db, _database(store, other))
        mismatch = _run(store, "--folder", str(other), "--dry-run")
        assert mismatch.returncode == 1 and "identity" in _load(mismatch)["error"]

        linked = store / "linked.db"
        os.link(db, linked)
        unsafe = _run(store, "--folder", str(root), "--dry-run")
        assert unsafe.returncode == 1 and "Unsafe index database" in _load(unsafe)["error"]
        linked.unlink()

        alias = base / "alias"
        alias.symlink_to(root)
        symlinked = _run(alias / "cache", "--folder", str(root), "--dry-run")
        assert symlinked.returncode == 1 and "symlink" in _load(symlinked)["error"]


def main():
    """Run the three real CLI scenarios and print one PASS line per scenario."""
    scenario_dry_run_and_query()
    print("PASS scenario 1: dry-run indexes only the curated sources and skips txt/html/json/yaml/toml, "
          "incidental Markdown, git-ignored, symlinked, non-executable extensionless and dependency paths; "
          "the marker at line 1900 of a 1999-line source ranks first with positive fused scores and an "
          "excerpt-free map; every fixture returns its exact consecutive sections ending on the final "
          "physical line under a soft hundred-word budget, fenced/commented/docstring, heredoc, C++ "
          "raw-string, Go and Rust fakes stay absent while env bash/sh/zsh/fish shebangs map structurally "
          "and every dense declaration survives, contract-scope queries rooted exactly at "
          ".pi/subagents/contracts index Git-ignored Markdown without claim owner.md and return every "
          "positive candidate deterministically, and rendered context stays far below the sources")
    scenario_hash_lifecycle()
    print("PASS scenario 2: mtime-preserving equal-length edit reindexes; dry-run keeps database bytes; "
          "deletion removes rows; forced reindex deletes before insert; stored hashes match SHA-256")
    scenario_legacy_invalid_and_refusals()
    print("PASS scenario 3: legacy summary migration previews read-only then rebuilds; invalid UTF-8 exits "
          "nonzero and preserves cached rows before repair; cross-folder, hardlinked database and symlinked store refused")


if __name__ == "__main__":
    main()
