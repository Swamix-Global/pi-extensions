#!/usr/bin/env python3
import sys

# Dry runs must not create bytecode caches either.
sys.dont_write_bytecode = True

from query_engine.__main__ import main

if __name__ == "__main__":
    raise SystemExit(main())
