import unittest
from pathlib import Path
from query_engine.indexer import find_agent_folders, index_folder
from query_engine.qdrant import is_qdrant_alive, collection_name_for_folder, get_indexed_points

class IndexerTests(unittest.TestCase):
    def test_find_agent_folders(self):
        folders = find_agent_folders(["/home/ubuntu/src"])
        folder_strs = [str(f) for f in folders]
        self.assertIn("/home/ubuntu/src/sglang-server", folder_strs)
        # Should not include .git or internal node_modules
        for f in folder_strs:
            self.assertNotIn(".git", f)
            self.assertNotIn("node_modules", f)

    def test_qdrant_service_integration(self):
        self.assertTrue(is_qdrant_alive(), "Qdrant daemon must be active on 127.0.0.1:6333")
        col = collection_name_for_folder("/home/ubuntu/src/sglang-server")
        points = get_indexed_points(col)
        self.assertGreaterEqual(len(points), 20, "Should have indexed sglang-server files in Qdrant")
        self.assertIn("AGENTS.md", points)
        self.assertIn("start.sh", points)

if __name__ == "__main__":
    unittest.main()
