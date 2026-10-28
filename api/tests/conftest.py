"""Shared test setup: an in-memory database, and the API dir on sys.path."""

import os
import sys
from pathlib import Path

os.environ["SCREENFORGE_DB"] = ":memory:"
os.environ.setdefault("SCREENFORGE_TAG_SOURCE", "sim")

API_DIR = Path(__file__).resolve().parent.parent
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))
