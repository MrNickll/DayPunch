"""In-process API checks for DayPunch.

    tests/.venv/bin/python tests/test_api.py

Runs against a throwaway profile in a temp directory. The app builds its own
database and its first day sheet, so nothing needs seeding.
"""
import os
import shutil
import sqlite3
import sys
import tempfile
from datetime import date

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(os.path.dirname(HERE), "src")

WORK = tempfile.mkdtemp(prefix="daypunch-test-")
os.environ.update(
    DAYPUNCH_APP_DATA=os.path.join(WORK, "appdata"),
    DAYPUNCH_FOLDER=os.path.join(WORK, "daily"),
    DAYPUNCH_CALENDAR_FOLDER=os.path.join(WORK, "calendar"),
)
sys.path.insert(0, SRC)

import config      # noqa: E402
import daily_file  # noqa: E402
import server  # noqa: E402

daily_file.create_daily_file()
client = server.app.test_client()
DB = config.DB_PATH

passed = failed = 0


def check(label, got, want):
    global passed, failed
    if got == want:
        passed += 1
        print(f"  PASS  {label}")
    else:
        failed += 1
        print(f"  FAIL  {label}\n          got:  {got!r}\n          want: {want!r}")


def code_of(desc):
    conn = sqlite3.connect(DB)
    row = conn.execute(
        "SELECT [Code] FROM [OP-Codes] WHERE [Description]=? COLLATE NOCASE", (desc,)
    ).fetchone()
    conn.close()
    return None if row is None else (row[0] or "")


def post_opcode(code, desc):
    return client.post("/api/opcodes", json={"code": code, "desc": desc}).get_json()


print("\nFresh database")
status = client.get("/api/dbstatus").get_json()
check("no OP-codes ship with the app", status["opcodes"], 0)
check("only the manufacturer-neutral seed notes",
      status["notes"], len(config.SEED_REF_NOTES))

print("\nOP-codes")
# Built here rather than shipped: a description is usually typed before the
# OP-code is known, so the row starts code-less.
post_opcode("", "Airbag Light On")
post_opcode("Service", "Annual Service")
# The reported bug: a description saved without a code could never get one.
check("code-less row starts empty", code_of("Airbag Light On"), "")
r = post_opcode("SA-99-1234", "Airbag Light On")
check("  ...accepts a code later", r.get("updated"), True)
check("  ...and the code is stored", code_of("Airbag Light On"), "SA-99-1234")

r = post_opcode("SA-99-1234", "Airbag Light On")
check("re-sending the same pair is a no-op", r.get("skipped"), "known")

r = post_opcode("", "Airbag Light On")
check("no code to contribute is a no-op", r.get("skipped"), "known")

r = post_opcode("XX-01", "Brand New Job Never Seen")
check("new description inserts", r.get("added"), True)
check("  ...with its code", code_of("Brand New Job Never Seen"), "XX-01")

r = post_opcode("  xx-01  ", "  brand new job never seen  ")
check("case + whitespace variants dedupe", r.get("skipped"), "known")

r = post_opcode("XX-01", "A Different Job")
check("code already used elsewhere is refused", r.get("skipped"), "code-used-elsewhere")
check("  ...and reports the owner", r.get("existing"), "Brand New Job Never Seen")
check("  ...without inserting", code_of("A Different Job"), None)

r = post_opcode("ZZ-02", "Annual Service")   # already has code "Service"
check("existing code is not overwritten", r.get("skipped"), "description-has-other-code")
check("  ...original kept", code_of("Annual Service"), "Service")

print("\nPunches")
today = f"{date.today():%Y-%m-%d}.xlsx"


def save(punches):
    return client.post("/api/punches", json={"file": today, "punches": punches})


res = save([
    {"time": "08:00", "status": "W", "ro": "295204", "line": "a",
     "description": "Annual Service", "opcode": "Service", "refid": "TKT-1", "story": "Started work"},
    {"time": "12:00", "status": "B", "description": "Lunch time"},
])
check("save round-trips", res.status_code, 200)
back = client.get(f"/api/punches?file={today}").get_json()["punches"]
check("  ...punch count", len(back), 2)
check("  ...RO stored as a number", back[0]["ro"], "295204")
check("  ...duration computed", back[0]["duration"], "4.0")
check("  ...ticket number round-trips", back[0]["refid"], "TKT-1")

res = save([{"time": "08:00", "status": "W", "ro": "not-a-number"}])
check("a non-numeric RO no longer 500s", res.status_code, 200)
check("  ...and is kept verbatim",
      client.get(f"/api/punches?file={today}").get_json()["punches"][0]["ro"], "not-a-number")

# Regression: server.py called cleanup_old_calendar_files() without importing it,
# so EVERY save of a day containing a "C" punch raised NameError and returned 500 —
# after the workbook had already been written. That is end of day, and every edit
# to a past day through the file picker.
res = save([
    {"time": "08:00", "status": "W", "ro": "295204", "description": "Annual Service"},
    {"time": "17:03", "status": "C", "description": "Home time"},
])
check("saving a day that ends with a C punch", res.status_code, 200)

many = [{"time": f"{6 + i // 4:02d}:{(i % 4) * 15:02d}", "status": "W", "ro": str(i)}
        for i in range(35)]
res = save(many)
check("overflow past 29 punches is reported", res.status_code, 507)
check("  ...with a count", "6 punch(es) were not saved" in res.get_json()["error"], True)

print("\nOther routes")
files = client.get("/api/files").get_json()
check("/api/files lists today's sheet", today in files, True)
check("/api/refnotes serves the seed", len(client.get("/api/refnotes").get_json()), 7)
status = client.get("/api/dbstatus").get_json()
check("/api/dbstatus reports a healthy database", status["db_ok"], True)

print("\nFresh install")
seeded = client.get("/api/refnotes").get_json()
check("the seed is Tools only", sorted({n["category"] for n in seeded}), ["Tools"])
# Stronger than scanning for forbidden words: the seed must be exactly what
# config declares and nothing else, whatever anyone adds there later.
check("the seed is exactly what config declares",
      sorted((n["category"], n["key"], n["value"], n["tags"]) for n in seeded),
      sorted(config.SEED_REF_NOTES))
settings = client.get("/api/settings").get_json()
check("labels come from settings, not the markup", settings["labels"]["ref_id"], "Ticket Number")
check("  ...and the copy tab is neutral", settings["labels"]["copy_tab"], "TEXT")
check("no employer name is baked in", settings["org_name"], "")

shutil.rmtree(WORK, ignore_errors=True)
print(f"\n{passed} passed, {failed} failed\n")
sys.exit(1 if failed else 0)
