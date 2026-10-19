"""Fanout evidence engine: deterministic windows, parallel local extraction,
verbatim-validated citations."""
from .engine import canonical, enumerate_files, scan_sources
from .fanout import compile_evidence

__all__ = ["canonical", "compile_evidence", "enumerate_files", "scan_sources"]
