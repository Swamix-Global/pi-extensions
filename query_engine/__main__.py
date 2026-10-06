"""CLI: JSON on stdout, progress on stderr. Python 3.10+, standard library only."""
import argparse
import json
import sys
from .engine import query_project
from .indexer import index_folder, auto_index_all_agent_folders


def format_result(result):
    lines = [f"Folder: {result['folder']}", f"Store: {result['database']}"]
    sync = result.get("sync")
    if sync:
        lines.append(f"Map: {result['indexed']} files; {sync['updated']} updated, {sync['deleted']} deleted, {sync['unchanged']} unchanged.")
    if result.get("dryRun"):
        lines.append("Dry run: no writes, inference or network.")
        for kind, paths in result["pending"].items():
            lines.append(f"{kind}: {', '.join(paths) or '(none)'}")
    elif result.get("indexOnly"):
        lines.append(f"Preindexed locally: {len(result['parts'])} map parts. SGLang KV cache is evictable, not durable.")
    else:
        lines.extend(["", result["answer"], "", "Files to read (in order):"])
        for file in result["files"]:
            lines.extend([file["path"], f"Why read: {file['reason']}", f"Context: {file['summary']}", ""])
        if result.get("limitations"):
            lines.append("Limitations: " + "; ".join(result["limitations"]))
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Query engine: SGLang indexing, Qdrant vector retrieval, OpenRouter decisions")
    parser.add_argument("--folder")
    parser.add_argument("--question")
    parser.add_argument("--auto-all", action="store_true", help="Auto-index all folders containing AGENTS.md")
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--dry-run", action="store_true", help="Offline, no-write plan")
    modes.add_argument("--index-only", action="store_true", help="Preindex all eligible files with local SGLang; no remote inference")
    parser.add_argument("--json", action="store_true", help="One JSON document on stdout")
    args = parser.parse_args()

    if args.auto_all:
        try:
            results = auto_index_all_agent_folders(
                progress=lambda text: print(text, file=sys.stderr, flush=True)
            )
            if args.json:
                print(json.dumps(results, indent=2, ensure_ascii=False))
            else:
                for r in results:
                    print(f"[{r.get('folder')}]: {r.get('total_files')} files indexed (Qdrant: {r.get('qdrant_collection')})")
            return 0
        except Exception as error:
            if args.json:
                print(json.dumps({"error": str(error)}))
            print(str(error), file=sys.stderr)
            return 1

    if not args.folder or not args.folder.strip():
        parser.error("--folder must be nonblank unless --auto-all is specified")
    if not args.dry_run and not args.index_only and not (args.question and args.question.strip()):
        parser.error("--question is required unless --dry-run or --index-only")
    try:
        result = query_project(args.folder, args.question, dry_run=args.dry_run,
                               index_only=args.index_only,
                               progress=lambda text: print(text, file=sys.stderr, flush=True))
        if args.json:
            print(json.dumps(result, ensure_ascii=False))
        else:
            print(format_result(result))
    except Exception as error:
        if args.json:
            print(json.dumps({"error": str(error)}))
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
