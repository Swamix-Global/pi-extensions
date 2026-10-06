import hashlib
import json
import os
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from query_engine.engine import (scan_sources, source_chunks, query_project, plan_project,
                                 pack, parse_decision, hierarchy, decide)
from query_engine.models import Client, budget, encode, tokens, QUERY_SYSTEM, project_api_key
from query_engine.store import location, open_index, read_index


class Fake(Client):
    def __init__(self, context=32768, remote=False):
        super().__init__("http://localhost/v1", "fake", context, remote=remote, output=256)
        self.calls = []
        self.fail = False
        self.hook = None

    def check(self):
        pass

    def complete(self, state, system, structured=False, output=None):
        self.calls.append((state, system))
        if tokens(encode(state)) > budget(self.context, system, output or self.output):
            raise AssertionError("oversized request")
        if self.fail:
            raise RuntimeError("inference failure")
        if self.hook:
            self.hook()
        if structured:
            paths = []
            for part in state.get("parts", []):
                paths.extend(part["paths"])
            for decision in state.get("decisions", []):
                paths.extend(f["path"] for f in decision["files"])
            paths = list(dict.fromkeys(paths))
            return json.dumps({"answer": "Found indexed code", "files": [{"path": p, "reason": "read source"} for p in paths[:1]], "limitations": ["Verify source"]})
        return "## Behavior\nLocal summary: function symbols and dependencies."


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.root = self.base / "project"
        self.root.mkdir()
        self.store = self.base / "store"
        self.local, self.remote = Fake(), Fake(remote=True)
        (self.root / "a.py").write_text("def add(a, b): return a + b\n")

    def tearDown(self):
        self.temp.cleanup()

    def query(self, **kwargs):
        return query_project(str(self.root), "Find addition", store_dir=str(self.store),
                             local=self.local, remote=self.remote, **kwargs)

    def test_project_key_environment_precedence(self):
        with patch.dict(os.environ, {"OPENROUTER_API_KEY": "process-key"}), patch("pathlib.Path.read_text", side_effect=AssertionError):
            self.assertEqual(project_api_key(), "process-key")

    def test_project_key_from_installation_env(self):
        with patch.dict(os.environ, {}, clear=True), patch("pathlib.Path.exists", return_value=True), patch("pathlib.Path.read_text", return_value='# private\nOPENROUTER_API_KEY="copied-key"\n') as read:
            self.assertEqual(project_api_key(), "copied-key")
            read.assert_called_once_with()

    def test_missing_project_key(self):
        with patch.dict(os.environ, {}, clear=True), patch("pathlib.Path.exists", return_value=False):
            self.assertIsNone(project_api_key())

    def test_dry_run_no_writes_or_clients(self):
        with patch("query_engine.engine.local_client", side_effect=AssertionError), patch("query_engine.engine.decision_client", side_effect=AssertionError):
            plan = query_project(str(self.root), dry_run=True, store_dir=str(self.store))
        self.assertFalse(self.store.exists())
        self.assertEqual(plan["pending"]["added"], ["a.py"])

    def test_incremental_existing_schema_and_permissions(self):
        first = self.query()
        self.assertEqual(first["sync"]["updated"], 1)
        db = Path(first["database"])
        self.assertEqual(db.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.store.stat().st_mode & 0o777, 0o700)
        with sqlite3.connect(db) as conn:
            self.assertEqual([r[1] for r in conn.execute("PRAGMA table_info(files)")], ["path", "summary", "content_hash", "index_time"])
        local_calls = len(self.local.calls)
        self.assertEqual(self.query()["sync"]["unchanged"], 1)
        self.assertEqual(len(self.local.calls), local_calls)
        (self.root / "a.py").unlink()
        (self.root / "b.sh").write_text("echo hello")
        third = self.query()
        self.assertEqual(third["sync"], {"updated": 1, "deleted": 1, "unchanged": 0})
        self.assertEqual(third["files"][0]["path"], "b.sh")

    def test_failed_sync_preserves_old_map(self):
        first = self.query()
        before = read_index(str(self.root), Path(first["database"]))
        (self.root / "a.py").write_text("changed")
        self.local.fail = True
        with self.assertRaisesRegex(RuntimeError, "inference failure"):
            self.query()
        self.assertEqual(read_index(str(self.root), Path(first["database"])), before)

    def test_source_race_no_commit(self):
        self.local.hook = lambda: (self.root / "a.py").write_text("changed")
        with self.assertRaisesRegex(RuntimeError, "Sources changed"):
            self.query()
        self.assertEqual(read_index(str(self.root), location(str(self.root), str(self.store))), {})

    def test_source_race_during_answer(self):
        self.remote.hook = lambda: (self.root / "a.py").write_text("changed")
        with self.assertRaisesRegex(RuntimeError, "Sources changed"):
            self.query()

    def test_dry_run_cached_bytes_unchanged(self):
        first = self.query()
        before = {p.name: p.read_bytes() for p in self.store.iterdir()}
        plan = plan_project(str(self.root), str(self.store))
        self.assertEqual(plan["indexed"], 1)
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.store.iterdir()})

    def test_alias_reuse_and_folder_isolation(self):
        alias = self.base / "alias"
        alias.symlink_to(self.root)
        first = self.query()
        self.assertEqual(plan_project(str(alias), str(self.store))["database"], first["database"])
        child = self.root / "child"
        child.mkdir()
        self.assertNotEqual(plan_project(str(child), str(self.store))["database"], first["database"])

    def test_eligibility_tokenizer_and_symlinks(self):
        (self.root / "tokenizer_config.json").write_text("{}")
        (self.root / "merges.txt").write_text("data")
        (self.root / "custom.py").write_text("code")
        (self.root / "outside.py").symlink_to(self.root / "a.py")
        dep = self.root / "node_modules"
        dep.mkdir()
        (dep / "x.js").write_text("ignored")
        self.assertEqual(list(scan_sources(str(self.root))), ["a.py", "custom.py"])

    def test_binary_and_invalid_utf8_fail(self):
        for raw in (b"\x00", b"\xff"):
            (self.root / "a.py").write_bytes(raw)
            with self.assertRaises((ValueError, UnicodeError)):
                scan_sources(str(self.root))

    def test_unicode_chunk_consumes_every_character(self):
        text = "🙂中文éabc" * 8000
        chunks = source_chunks(text)
        self.assertEqual("".join(chunks), text)
        self.assertTrue(all(len(c.encode()) <= 16000 for c in chunks))

    def test_identity_symlink_hardlink_wal_safety(self):
        first = self.query()
        database = Path(first["database"])
        with self.assertRaisesRegex(RuntimeError, "identity"):
            read_index("/different", database)
        link = self.store / "other.db"
        os.link(database, link)
        with self.assertRaises(RuntimeError):
            read_index(str(self.root), database)
        link.unlink()
        sidecar = Path(str(database) + "-wal")
        sidecar.symlink_to(database)
        with self.assertRaises(RuntimeError):
            read_index(str(self.root), database)
        sidecar.unlink()
        with sqlite3.connect(database) as conn:
            conn.execute("PRAGMA journal_mode=WAL")
        before = set(self.store.iterdir())
        with self.assertRaisesRegex(RuntimeError, "WAL"):
            read_index(str(self.root), database)
        self.assertEqual(set(self.store.iterdir()), before)

    def test_symlinked_store_ancestor(self):
        alias = self.base / "alias"
        alias.symlink_to(self.root)
        with self.assertRaises(RuntimeError):
            plan_project(str(self.root), str(alias / "cache"))
        self.assertFalse((self.root / "cache").exists())

    def test_preindex_no_remote(self):
        with patch("query_engine.engine.decision_client", side_effect=AssertionError):
            result = query_project(str(self.root), index_only=True, store_dir=str(self.store), local=self.local)
        self.assertTrue(result["indexOnly"])
        self.assertEqual(result["parts"][0]["part"], "1/1")

    def test_budget_formula_and_pack_complete(self):
        self.assertEqual(tokens("x" * 35), 10)
        self.assertEqual(budget(1000, "x" * 35, 100), 790)
        items = [str(i) + "x" * 2000 for i in range(10)]
        small = Fake(context=1200)
        groups = pack(items, lambda g: {"items": g}, small, "system")
        self.assertEqual([x for g in groups for x in g], items)
        self.assertGreater(len(groups), 1)
        with self.assertRaisesRegex(RuntimeError, "One state item"):
            pack(["x" * 10000], lambda g: g, small, "system")

    def test_hierarchy_h1_h2_markers_and_all_paths(self):
        rows = [{"path": f"f{i}.py", "summary": "x" * 1800} for i in range(12)]
        parts = hierarchy(rows, Fake(context=2000), lambda _: None)
        self.assertGreater(len(parts), 1)
        self.assertEqual([p for part in parts for p in part["paths"]], [r["path"] for r in rows])
        for i, part in enumerate(parts):
            self.assertEqual(part["part"], f"{i+1}/{len(parts)}")
            self.assertTrue(part["overview"].startswith("# Project map"))
            self.assertIn("\n## Summary", part["overview"])

    def test_oversized_single_summary_consumes_all_fragments(self):
        row = {"path": "large.py", "summary": "x" * 20000}
        local = Fake(context=1200)
        parts = hierarchy([row], local, lambda _: None)
        self.assertGreater(len(parts), 1)
        fragments = [r for state, _ in local.calls for r in state["file_summaries"]]
        self.assertEqual("".join(r["summary"] for r in fragments), row["summary"])
        self.assertTrue(all(r["path"] == "large.py" for r in fragments))
        self.assertEqual(fragments[-1]["fragment"], f"{len(fragments)}/{len(fragments)}")

    def test_oversized_map_cache_reused_without_reindex(self):
        for i in range(80):
            (self.root / f"f{i}.py").write_text(f"value = {i}")
        self.remote.context = 1200
        first = self.query()
        self.assertTrue(any("hierarchical" in item for item in first["limitations"]))
        calls = len(self.local.calls)
        second = self.query()
        self.assertEqual(second["sync"]["unchanged"], 81)
        self.assertEqual(len(self.local.calls), calls)
        db = location(str(self.root), str(self.store))
        with sqlite3.connect(db) as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM map_cache").fetchone()[0], 1)

    def test_hierarchical_decisions_cover_every_part(self):
        parts = [{"part": f"{i+1}/8", "overview": "x" * 2500, "paths": [f"f{i}.py"]} for i in range(8)]
        client = Fake(context=1600, remote=True)
        decide("find code", [], parts, client)
        seen = [p["part"] for state, _ in client.calls for p in state.get("parts", [])]
        self.assertEqual(seen, [p["part"] for p in parts])
        self.assertTrue(any("decisions" in s for s, _ in client.calls))

    def test_decision_rejects_unindexed_or_duplicate_paths(self):
        for paths in (["outside.py"], ["a.py", "a.py"]):
            raw = json.dumps({"answer": "ok", "files": [{"path": p, "reason": "read"} for p in paths], "limitations": []})
            with self.assertRaises(ValueError):
                parse_decision(raw, {"a.py"})

    def test_client_rejects_truncation_and_disables_remote_compression(self):
        client = Client("https://example.invalid", "free", 32768, remote=True)
        with patch.object(client, "request", return_value={"choices": [{"finish_reason": "length", "message": {"content": "incomplete"}}]}):
            with self.assertRaisesRegex(RuntimeError, "incomplete"):
                client.complete({}, "system")
        with patch.object(client, "request", return_value={"choices": [{"finish_reason": "stop", "message": {"content": "{}"}}]}) as request:
            client.complete({}, "system", structured=True)
        self.assertFalse(request.call_args.args[1]["plugins"][0]["enabled"])

    def test_empty_project(self):
        (self.root / "a.py").unlink()
        result = self.query()
        self.assertEqual(result["indexed"], 0)
        self.assertEqual(result["files"], [])

    def test_cli_offline_json_and_required_args(self):
        cli = Path(__file__).resolve().parents[1] / "cli.py"
        run = subprocess.run(["python3", str(cli), "--folder", str(self.root), "--dry-run", "--json"], env={**os.environ, "PI_QUERY_STORE_DIR": str(self.store)}, capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertTrue(json.loads(run.stdout)["dryRun"])
        bad = subprocess.run(["python3", str(cli), "--folder", str(self.root)], capture_output=True)
        self.assertEqual(bad.returncode, 2)


if __name__ == "__main__":
    unittest.main()
