"""Hash-only CLI: JSON on stdout, progress on stderr, no network or inference."""
import argparse
import json
import sys

from .engine import query_project
from .indexer import auto_index_all_agent_folders


def format_result(result):
    """Present absolute paths and nested bullet-only structural file maps."""
    lines = [f"Folder: {result['folder']}", f"Store: {result['database']}"]
    sync = result["sync"]
    lines.append(f"Index: {result['indexed']} files; {sync['updated']} updated, {sync['deleted']} deleted, {sync['unchanged']} unchanged.")
    if result.get("dryRun"):
        lines.append("Dry run: no writes or network.")
        for kind, paths in result["pending"].items():
            lines.append(f"{kind}: {', '.join(paths) or '(none)'}")
    elif result.get("indexOnly"):
        lines.append("Indexed file hashes locally; no summaries or model calls.")
    else:
        lines.extend(["", result["answer"], "", "File maps (in order):"])
        for file in result["files"]:
            lines.append(f"- {file['path']}:{file['line']}")
            lines.append(f"  - why: {file['reason']}")
            lines.append(f"  - map: {file['mapKind']}")
            for section in file["sections"]:
                lines.append(f"  - {section['line']}-{section['endLine']} {section['name']}: {section['purpose']}")
            lines.append("")
        lines.append("Limitations: " + "; ".join(result["limitations"]))
    return "\n".join(lines)


def main():
    """Run a query, no-write preview or explicit hash-index rebuild."""
    parser = argparse.ArgumentParser(description="Local hash-only query engine: BM25 + TF-IDF with RRF")
    parser.add_argument("--folder", help="Absolute source folder path")
    parser.add_argument("--question")
    parser.add_argument("--auto-all", action="store_true", help="Index AGENTS.md folders under /home/ubuntu/src")
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--dry-run", action="store_true", help="Offline no-write hash plan")
    modes.add_argument("--index-only", action="store_true", help="Sync file hashes without retrieval")
    parser.add_argument("--reindex", action="store_true", help="Delete all cached rows and override with current source hashes")
    parser.add_argument("--json", action="store_true", help="One JSON document on stdout")
    args = parser.parse_args()
    if args.dry_run and (args.reindex or args.auto_all):
        parser.error("--dry-run cannot be combined with --reindex or --auto-all")
    if args.auto_all and (args.folder or args.question):
        parser.error("--auto-all cannot be combined with --folder or --question")
    if not args.auto_all:
        if not args.folder or not args.folder.strip():
            parser.error("--folder must be an absolute path unless --auto-all is specified")
        if not args.dry_run and not args.index_only and not (args.question and args.question.strip()):
            parser.error("--question is required unless --dry-run or --index-only")
    progress = lambda text: print(text, file=sys.stderr, flush=True)
    try:
        if args.auto_all:
            result = auto_index_all_agent_folders(progress=progress, reindex=args.reindex)
            failed = any("error" in entry for entry in result)
            print(json.dumps(result, ensure_ascii=False) if args.json else "\n".join(
                f"{entry['folder']}: {entry['error']}" if "error" in entry else format_result(entry) for entry in result))
            return int(failed)
        result = query_project(args.folder, args.question, dry_run=args.dry_run, index_only=args.index_only,
                               reindex=args.reindex, progress=progress)
        print(json.dumps(result, ensure_ascii=False) if args.json else format_result(result))
    except Exception as error:
        if args.json:
            print(json.dumps({"error": str(error)}))
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
