# DayPunch — Copyright 2026 Nicolas Lapointe Lafortune. Licensed under the Apache License 2.0.
# DayPunch config.py
"""Paths, settings and defaults.

Nothing here names an employer. Anything site-specific lives in settings.json
under APP_DATA_DIR, which the app creates on first run, so the same build works
anywhere without editing code.

Precedence: environment variable > settings.json > built-in default.
"""
import json
import os
import sys

VERSION = "2026.10.01"
APP_NAME = "DayPunch"

HOME = os.path.expanduser("~")
_SRC_DIR = os.path.dirname(os.path.abspath(__file__))


def _app_data_dir():
    """Per-user writable state. Never the install folder, which is read-only
    once the app sits under Program Files."""
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or os.path.join(HOME, "AppData", "Local")
    elif sys.platform == "darwin":
        base = os.path.join(HOME, "Library", "Application Support")
    else:
        base = os.environ.get("XDG_DATA_HOME") or os.path.join(HOME, ".local", "share")
    return os.path.join(base, APP_NAME)


APP_DATA_DIR = os.environ.get("DAYPUNCH_APP_DATA", _app_data_dir())
SETTINGS_FILE = os.path.join(APP_DATA_DIR, "settings.json")

# ── Site settings ─────────────────────────────────────────────────────────────
# Written to settings.json on first run and editable from there. The labels
# exist because the terms a shop uses for these fields are not universal.
DEFAULTS = {
    "data_folder": os.path.join(HOME, "Documents", APP_NAME, "Daily"),
    "org_name": "",                  # shown in the window title when set
    "labels": {
        "copy_tab": "TEXT",          # the export panel — same word in EN and FR
        "copy_title": "TEXT TO COPY",
        "job_number": "Job #",       # repair order / work order number
        "job_line": "Line",
        "ref_id": "Ticket Number",   # helpline / support case reference
        "warranty": "Warranty work",
    },
}


def _load_settings():
    try:
        with open(SETTINGS_FILE, encoding="utf-8") as f:
            stored = json.load(f)
        if not isinstance(stored, dict):
            return dict(DEFAULTS)
    except (FileNotFoundError, ValueError, OSError):
        return dict(DEFAULTS)
    merged = dict(DEFAULTS)
    merged.update({k: v for k, v in stored.items() if k != "labels"})
    labels = dict(DEFAULTS["labels"])
    if isinstance(stored.get("labels"), dict):
        labels.update(stored["labels"])
    merged["labels"] = labels
    return merged


SETTINGS = _load_settings()
LABELS = SETTINGS["labels"]
ORG_NAME = os.environ.get("DAYPUNCH_ORG", SETTINGS["org_name"])

PORT = int(os.environ.get("DAYPUNCH_PORT", "5000"))

# ── Daily punch workbooks ─────────────────────────────────────────────────────
FOLDER = os.environ.get("DAYPUNCH_FOLDER", SETTINGS["data_folder"])

# ── Calendar drop folder ──────────────────────────────────────────────────────
CALENDAR_FOLDER = os.environ.get(
    "DAYPUNCH_CALENDAR_FOLDER", os.path.join(FOLDER, "Calendar")
)

# ── Reference database ────────────────────────────────────────────────────────
# One SQLite file in the user profile. No driver to install, no network path,
# nothing to share — which is also the shortest answer to "what does it touch?".
DB_PATH = os.environ.get(
    "DAYPUNCH_DB", os.path.join(APP_DATA_DIR, "daypunch.sqlite3")
)

# Seed content for a fresh database: only shop knowledge that is not tied to any
# one manufacturer. Everything model-specific is left for the user to build up.
SEED_REF_NOTES = [
    ("Tools", "Roloc Fiber Discs",    "Brown: Coarse or extra Coarse", "abrasive,roloc"),
    ("Tools", "Roloc Fiber Discs",    "Maroon: Medium",                "abrasive,roloc"),
    ("Tools", "Roloc Fiber Discs",    "Blue: extra-Fine",              "abrasive,roloc"),
    ("Tools", "Roloc Plastic Discs",  "Green: 50",                     "abrasive,roloc"),
    ("Tools", "Roloc Plastic Discs",  "Yellow: 80",                    "abrasive,roloc"),
    ("Tools", "Roloc Plastic Discs",  "White: 120",                    "abrasive,roloc"),
    ("Tools", "Aluminum Oxide Discs", "Red: P120 - Brake rotor conditioning.", "abrasive"),
]

# ── Workbook layout ───────────────────────────────────────────────────────────
PUNCH_SHEET = "Punch Times"
FIRST_PUNCH_ROW = 2
LAST_PUNCH_ROW = 30
PUNCH_ROWS = range(FIRST_PUNCH_ROW, LAST_PUNCH_ROW + 1)
MAX_PUNCHES = LAST_PUNCH_ROW - FIRST_PUNCH_ROW + 1  # 29
DATA_COLS = [2, 3, 4, 5, 8, 9, 10, 11, 12]  # B C D E H I J K L


def write_default_settings():
    """Drop a settings.json the user can edit, if there is not one already."""
    if os.path.exists(SETTINGS_FILE):
        return
    try:
        os.makedirs(APP_DATA_DIR, exist_ok=True)
        with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
            json.dump(DEFAULTS, f, indent=2)
    except OSError:
        pass
