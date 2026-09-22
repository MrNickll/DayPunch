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


def _fresh_defaults():
    """A copy of DEFAULTS that shares nothing with it. dict(DEFAULTS) alone
    would hand back the very same labels dict, and anything that later edited
    the live labels would quietly rewrite the defaults too."""
    return {**DEFAULTS, "labels": dict(DEFAULTS["labels"])}


def _load_settings():
    try:
        with open(SETTINGS_FILE, encoding="utf-8") as f:
            stored = json.load(f)
        if not isinstance(stored, dict):
            return _fresh_defaults()
    except (FileNotFoundError, ValueError, OSError):
        return _fresh_defaults()
    merged = _fresh_defaults()
    merged.update({k: v for k, v in stored.items() if k != "labels"})
    labels = dict(DEFAULTS["labels"])
    if isinstance(stored.get("labels"), dict):
        labels.update(stored["labels"])
    merged["labels"] = labels
    return merged


SETTINGS = _load_settings()
LABELS = SETTINGS["labels"]
ORG_NAME = os.environ.get("DAYPUNCH_ORG", SETTINGS["org_name"])

# The port to try first. If something already holds it, server.bind_server()
# lets the system choose a free one rather than failing.
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


# ── Editing settings from the UI ──────────────────────────────────────────────
ORG_NAME_MAX = 80
LABEL_MAX = 40
EDITABLE = {"data_folder", "org_name", "labels"}

# Settings an environment variable pins. Saving over them would appear to work
# and then not apply, so the settings screen shows them read-only instead.
ENV_LOCKS = {"data_folder": "DAYPUNCH_FOLDER", "org_name": "DAYPUNCH_ORG"}


class SettingsError(ValueError):
    """An edit that cannot be stored; the message is shown to the user."""


def locked_fields():
    return sorted(k for k, var in ENV_LOCKS.items() if os.environ.get(var))


def _validate_folder(raw):
    path = os.path.expanduser(str(raw or "").strip())
    if not path:
        raise SettingsError("The data folder cannot be empty.")
    if not os.path.isabs(path):
        raise SettingsError("The data folder must be a full path, not a relative one.")
    if os.path.exists(path) and not os.path.isdir(path):
        raise SettingsError("That data folder path points at a file, not a folder.")
    # The folder may not exist yet; it is created on next start. What has to be
    # true now is that its nearest existing parent can be written to.
    probe = path
    while not os.path.exists(probe):
        parent = os.path.dirname(probe)
        if parent == probe:
            break
        probe = parent
    if not os.access(probe, os.W_OK):
        raise SettingsError(f"DayPunch cannot write to {probe}.")
    return os.path.normpath(path)


def validate_settings(incoming):
    """Check an edit from the settings screen; return the complete settings to
    store. Only known keys are accepted, and a blank label means its default."""
    if not isinstance(incoming, dict):
        raise SettingsError("Settings must be sent as an object.")
    unknown = set(incoming) - EDITABLE
    if unknown:
        raise SettingsError("Unknown setting: " + ", ".join(sorted(unknown)))
    for key in locked_fields():
        if key in incoming:
            raise SettingsError(
                f"{key} is set by the {ENV_LOCKS[key]} environment variable.")

    result = _load_settings()          # start from disk, not from memory
    if "data_folder" in incoming:
        result["data_folder"] = _validate_folder(incoming["data_folder"])
    if "org_name" in incoming:
        name = str(incoming["org_name"] or "").strip()
        if len(name) > ORG_NAME_MAX:
            raise SettingsError(f"The organisation name is limited to {ORG_NAME_MAX} characters.")
        result["org_name"] = name
    if "labels" in incoming:
        labels = incoming["labels"]
        if not isinstance(labels, dict):
            raise SettingsError("Labels must be sent as an object.")
        bad = set(labels) - set(DEFAULTS["labels"])
        if bad:
            raise SettingsError("Unknown label: " + ", ".join(sorted(bad)))
        merged = dict(result["labels"])
        for key, value in labels.items():
            text = str(value or "").strip()
            if len(text) > LABEL_MAX:
                raise SettingsError(f"Labels are limited to {LABEL_MAX} characters.")
            merged[key] = text or DEFAULTS["labels"][key]
        result["labels"] = merged
    return result


def save_settings(new):
    """Write settings.json atomically, then refresh what is served live.

    Labels and the organisation name take effect at once. The data folder is
    read at start-up and captured by the modules that use it, so a change there
    waits for the next launch.
    """
    global ORG_NAME
    os.makedirs(APP_DATA_DIR, exist_ok=True)
    tmp = SETTINGS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(new, f, indent=2, ensure_ascii=False)
    os.replace(tmp, SETTINGS_FILE)     # a crash mid-write cannot truncate it

    SETTINGS.clear()
    SETTINGS.update(new)
    LABELS.clear()
    LABELS.update(new["labels"])
    if not os.environ.get(ENV_LOCKS["org_name"]):
        ORG_NAME = new["org_name"]


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
