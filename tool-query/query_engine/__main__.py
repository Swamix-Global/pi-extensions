"""CLI: JSON or YAML on stdout, progress on stderr; local fanout evidence only."""
import argparse
import json
import sys

import yaml

from .engine import canonical, enumerate_files
from .fanout import compile_evidence


def _yaml(document):
    """Unlimited-width YAML: the terminal wraps naturally, we never re-flow."""
    return yaml.safe_dump(document, sort_keys=False, allow_unicode=True, width=1000000)


def main():
    """Enumerate eligible files or compile one fanout evidence packet."""
    parser = argparse.ArgumentParser(
        description="Fanout evidence engine: deterministic windows, parallel local extraction, verbatim-validated quotes")
    parser.add_argument("--folder", required=True, help="Absolute source folder path")
    parser.add_argument("--question", help="One concrete question for the evidence fanout")
    parser.add_argument("--list", action="store_true", help="Enumerate eligible files; no model calls")
    parser.add_argument("--windows", type=int, default=12, help="Window budget (1-24, default 12)")
    parser.add_argument("--concurrency", type=int, default=12, help="Parallel requests (1-32, default 12)")
    parser.add_argument("--json", action="store_true", help="One JSON document on stdout")
    args = parser.parse_args()
    if not args.list and not (args.question and args.question.strip()):
        parser.error("--question is required unless --list is given")
    progress = lambda text: print(text, file=sys.stderr, flush=True)
    try:
        if args.list:
            result = enumerate_files(args.folder)
        else:
            result = compile_evidence(args.folder, args.question, windows_limit=args.windows,
                                      concurrency=args.concurrency, progress=progress)
        if args.json:
            document = dict(result)
            document["yaml"] = _yaml(result)
            print(json.dumps(document, ensure_ascii=False))
        else:
            print(_yaml(result))
    except Exception as error:
        if args.json:
            print(json.dumps({"error": str(error)}))
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
