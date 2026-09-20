# PunchTrak calendar_sync.py
# v2026.9.01
import os
import json
import logging
from datetime import datetime, timedelta

from config import CALENDAR_FOLDER

log = logging.getLogger("punchtrak")

def ensure_calendar_folder():
    os.makedirs(CALENDAR_FOLDER, exist_ok=True)

def build_event_json(closed_punch, next_punch):
    """
    Build the calendar event dict for a closed punch.
    closed_punch: the punch that just got closed (has start time)
    next_punch: the punch after it (provides the end time)
    """
    date_str   = closed_punch.get("date", "")
    start_time = closed_punch.get("time", "")
    end_time   = next_punch.get("time", "")

    if not date_str or not start_time or not end_time:
        return None

    start_iso = f"{date_str}T{start_time}:00"
    end_iso   = f"{date_str}T{end_time}:00"

    status      = closed_punch.get("status", "")
    ro          = closed_punch.get("ro", "")
    line        = closed_punch.get("line", "")
    description = closed_punch.get("description", "")
    opcode      = closed_punch.get("opcode", "")
    warranty    = closed_punch.get("warranty", "")
    story       = closed_punch.get("story", "")
    if story == "-":
        story = ""

# Build subject
    if status in ("B", "C", "A"):
        subject = description or {"B": "Lunch", "C": "Home Time", "A": "Available"}.get(status, status)
    else:
        subject_parts = [f"[{status}]"]
        if warranty == "x":
            subject_parts.append("[WARRANTY]")
        if ro:
            ro_part = f"RO {ro}"
            if line:
                ro_part += f" / {line}"
            subject_parts.append(ro_part)
        if description:
            subject_parts.append(f"— {description}")
        subject = " ".join(subject_parts)

    # Build body
    body_lines = []
    if description:
        body_lines.append(description)
    if opcode:
        body_lines.append(f"OP-Code: {opcode}")
    if story:
        body_lines.append("")
        body_lines.append(story)
    body_lines.append("")
    body_lines.append("---")
    body_lines.append(f"Status: {status}")
    if ro:
        body_lines.append(f"RO: {ro}")
    if line:
        body_lines.append(f"Line: {line}")

    return {
        "subject": subject,
        "start":   start_iso,
        "end":     end_iso,
        "body":    "\n".join(body_lines),
        "status":  status,
        "ro":      ro,
        "line":    line,
    }

def write_calendar_event(closed_punch, next_punch):
    """
    Write a .json calendar event file to the PunchTrak_Calendar folder.
    Called when a new punch is saved and the previous one is now closed.
    """
    try:
        ensure_calendar_folder()
        event = build_event_json(closed_punch, next_punch)
        if not event:
            return

        # Unique filename: date_starttime_status_RO
        date_part   = (closed_punch.get("date", "unknown")).replace("-", "")
        time_part   = (closed_punch.get("time", "0000")).replace(":", "")
        status_part = closed_punch.get("status", "X")
        ro_part     = closed_punch.get("ro", "noRO")
        filename    = f"{date_part}_{time_part}_{status_part}_RO{ro_part}.json"
        filepath    = os.path.join(CALENDAR_FOLDER, filename)

        if os.path.exists(filepath):
            return
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(event, f, ensure_ascii=False, indent=2)

    except Exception:
        log.exception("calendar event write failed")  # never crash over calendar sync

def cleanup_old_calendar_files(days=30):
    """Delete .json files older than `days` days from PunchTrak_Calendar."""
    try:
        if not os.path.exists(CALENDAR_FOLDER):
            return
        cutoff = datetime.now() - timedelta(days=days)
        for filename in os.listdir(CALENDAR_FOLDER):
            if not filename.endswith('.json'):
                continue
            filepath = os.path.join(CALENDAR_FOLDER, filename)
            if datetime.fromtimestamp(os.path.getmtime(filepath)) < cutoff:
                os.remove(filepath)
    except Exception:
        log.exception("calendar cleanup failed")
