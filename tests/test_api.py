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

# Every route refuses requests not addressed to this machine: the defence
# against DNS rebinding, where a hostile name is re-pointed at 127.0.0.1.
print("\nHost guard")
def host_status(host):
    return client.get("/api/settings", headers={"Host": host}).status_code
check("localhost is served", host_status("localhost:5000"), 200)
check("127.0.0.1 is served", host_status("127.0.0.1:5000"), 200)
check("[::1] is served", host_status("[::1]:5000"), 200)
check("another host name is refused", host_status("evil.example"), 403)
check("  ...even one that starts with localhost", host_status("localhost.evil.example:5000"), 403)
check("  ...on write routes too",
      client.put("/api/settings", json={}, headers={"Host": "evil.example"}).status_code, 403)

print("\nSettings")
defaults_before = dict(config.DEFAULTS["labels"])
current = client.get("/api/settings").get_json()
check("reports where it stores its state", current["state_folder"], config.APP_DATA_DIR)
check("the folder pinned by DAYPUNCH_FOLDER is reported locked", "data_folder" in current["locked"], True)

r = client.put("/api/settings", data="org_name=x",
               headers={"Content-Type": "application/x-www-form-urlencoded"})
check("a non-JSON write is refused", r.status_code, 415)
r = client.put("/api/settings", json={"port": 80})
check("an unknown setting is refused", r.status_code, 400)
r = client.put("/api/settings", json={"data_folder": "/tmp/elsewhere"})
check("a field pinned by the environment is refused", r.status_code, 400)
r = client.put("/api/settings", json={"labels": {"ref_id": "x" * 41}})
check("an over-long label is refused", r.status_code, 400)
r = client.put("/api/settings", json={"labels": {"not_a_label": "x"}})
check("an unknown label is refused", r.status_code, 400)

r = client.put("/api/settings", json={"org_name": "  Test Shop  ",
                                      "labels": {"ref_id": "Case #", "job_number": ""}})
check("a valid edit is accepted", r.status_code, 200)
now = client.get("/api/settings").get_json()
check("  ...labels apply without a restart", now["labels"]["ref_id"], "Case #")
check("  ...so does the organisation name, trimmed", now["org_name"], "Test Shop")
check("  ...a blank label goes back to its default",
      now["labels"]["job_number"], config.DEFAULTS["labels"]["job_number"])
import json as _json
on_disk = _json.load(open(config.SETTINGS_FILE, encoding="utf-8"))
check("  ...and settings.json on disk agrees", on_disk["labels"]["ref_id"], "Case #")
check("the defaults themselves are left untouched", config.DEFAULTS["labels"], defaults_before)

# The data folder is pinned in this test run; lift the pin to exercise it.
pinned = os.environ.pop("DAYPUNCH_FOLDER")
try:
    new_folder = os.path.join(WORK, "moved", "daily")
    r = client.put("/api/settings", json={"data_folder": new_folder})
    check("changing the data folder is accepted", r.status_code, 200)
    check("  ...and flagged as needing a restart", r.get_json().get("restart_needed"), True)
    after = client.get("/api/settings").get_json()
    check("  ...saved, while the old one stays in use until then",
          (after["data_folder"], after["active_data_folder"]), (new_folder, config.FOLDER))
finally:
    os.environ["DAYPUNCH_FOLDER"] = pinned

print("\nData folder validation")
def folder_error(raw):
    try:
        config._validate_folder(raw)
        return None
    except config.SettingsError as e:
        return str(e)
check("a relative path is refused", folder_error("daily") is not None, True)
check("an empty path is refused", folder_error("   ") is not None, True)
a_file = os.path.join(WORK, "a-file.txt")
open(a_file, "w").close()
check("a path to a file is refused", folder_error(a_file) is not None, True)
check("a folder that does not exist yet is fine", folder_error(os.path.join(WORK, "new", "deep")), None)
check("~ is expanded", config._validate_folder("~/DayPunchTest").startswith(os.path.expanduser("~")), True)

# README promises no outbound connections. A CDN font or script added later
# would break that silently -- this is what the Google Fonts @import did.
print("\nNothing loads from the network")
import re as _re
external = _re.compile(r"""https?://(?!127\.0\.0\.1|localhost)[^\s'")]+""")
for route in ("/", "/styles.css", "/app.js"):
    body = client.get(route).get_data(as_text=True)
    check(f"{route} references no outside host", external.findall(body), [])

fonts_dir = os.path.join(SRC, "assets", "fonts")
bundled = sorted(f for f in os.listdir(fonts_dir) if f.endswith(".woff2"))
check("the stylesheet's fonts are bundled", bundled,
      ["IBMPlexMono-Regular.woff2", "IBMPlexMono-SemiBold.woff2"])
for f in bundled:
    r = client.get(f"/assets/fonts/{f}")
    check(f"  ...{f} is served as a font", (r.status_code, r.mimetype), (200, "font/woff2"))
# The OFL lets the fonts ship only alongside their licence.
check("  ...with the Open Font License beside them",
      os.path.exists(os.path.join(fonts_dir, "OFL.txt")), True)

# The launcher used to call app.run() on a fixed port inside a thread: if the
# port was taken it failed silently, and the window opened onto nothing -- or
# onto whatever else was listening there. bind_server() binds or falls back.
print("\nPort selection")
import socket, threading, urllib.request

def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]

wanted = free_port()
srv = server.bind_server(wanted)
check("a free preferred port is used as asked", srv.port, wanted)
srv.server_close()

squatter = socket.socket()
squatter.bind(("127.0.0.1", 0))
squatter.listen(1)
taken = squatter.getsockname()[1]
srv = server.bind_server(taken)
check("a taken port falls back to another one", srv.port != taken and srv.port > 0, True)
check("  ...and binds loopback only", srv.server_address[0], "127.0.0.1")
worker = threading.Thread(target=srv.serve_forever, daemon=True)
worker.start()
with urllib.request.urlopen(f"http://127.0.0.1:{srv.port}/api/settings", timeout=5) as resp:
    check("  ...and actually serves the app there", (resp.status, "app_name" in resp.read().decode()), (200, True))
srv.shutdown()
srv.server_close()
squatter.close()

# A database made before the Type column existed -- like one converted by hand
# from Access -- must gain it on start-up without losing a row.
print("\nMigration")
old_db = os.path.join(WORK, "old-schema.sqlite3")
raw = sqlite3.connect(old_db)
raw.executescript("""
CREATE TABLE [OP-Codes] (ID INTEGER PRIMARY KEY AUTOINCREMENT, Code TEXT, Description TEXT);
CREATE TABLE Ref_Notes (ID INTEGER PRIMARY KEY AUTOINCREMENT, Category TEXT, [Key] TEXT, [Value] TEXT, Tags TEXT);
CREATE TABLE Story_Templates (ID INTEGER PRIMARY KEY AUTOINCREMENT, [Value] TEXT, Category TEXT, [Key] TEXT, Tags TEXT);
INSERT INTO [OP-Codes] (Code, Description) VALUES ('S-T', 'Service Tires');
""")
raw.commit(); raw.close()
real_db = server.DB_PATH
server.DB_PATH = old_db
try:
    server.init_db()
    raw = sqlite3.connect(old_db)
    cols = [r[1] for r in raw.execute("PRAGMA table_info([OP-Codes])")]
    check("an old database gains the Type column", "Type" in cols, True)
    check("  ...keeping its rows",
          raw.execute("SELECT Code, Description, Type FROM [OP-Codes]").fetchall(),
          [("S-T", "Service Tires", "")])
    check("  ...with no warnings when IDs are sound", server.schema_warnings(raw), [])
    raw.close()
    server.init_db()                       # running it twice must be harmless
    check("migrating twice is harmless", True, True)
finally:
    server.DB_PATH = real_db

# A conversion that made ID a plain INTEGER leaves new rows without an ID.
bad = sqlite3.connect(":memory:")
bad.executescript("""
CREATE TABLE [OP-Codes] (ID INTEGER, Code TEXT, Description TEXT, Type TEXT);
CREATE TABLE Ref_Notes (ID INT PRIMARY KEY, Category TEXT, [Key] TEXT, [Value] TEXT, Tags TEXT);
CREATE TABLE Story_Templates (ID INTEGER PRIMARY KEY, [Value] TEXT, Category TEXT, [Key] TEXT, Tags TEXT);
INSERT INTO [OP-Codes] (Code, Description) VALUES ('X', 'Added after conversion');
""")
w = server.schema_warnings(bad)
check("a plain INTEGER ID is flagged", any(x.startswith("OP-Codes: ID is not") for x in w), True)
check("  ...so are the rows it left without one", any("1 row(s) have no ID" in x for x in w), True)
check("  ...and INT PRIMARY KEY, which SQLite does not number", any(x.startswith("Ref_Notes") for x in w), True)
check("  ...but not a proper INTEGER PRIMARY KEY", any(x.startswith("Story_Templates") for x in w), False)
bad.close()
check("/api/dbstatus reports warnings (none here)", client.get("/api/dbstatus").get_json()["warnings"], [])

print("\nOP-code editing")
post_opcode("S-T", "Service Tires")
post_opcode("TRN-A", "Training Aston")
codes = {o["desc"]: o for o in client.get("/api/opcodes").get_json()}
check("OP-codes come with an id and a parent type",
      sorted(codes["Service Tires"]), ["code", "desc", "id", "type"])
check("  ...no parent type until one is set", codes["Training Aston"]["type"], "")
tid = codes["Training Aston"]["id"]

def put_opcode(**kw):
    return client.put("/api/opcodes", json=kw)
r = put_opcode(id=tid, code="TRN-A", desc="Training Aston", type="wi")
check("a parent type can be set", r.status_code, 200)
check("  ...and is stored upper-case",
      {o["desc"]: o["type"] for o in client.get("/api/opcodes").get_json()}["Training Aston"], "WI")
check("an unknown parent type is refused", put_opcode(id=tid, code="TRN-A", desc="Training Aston", type="X").status_code, 400)
check("an empty description is refused", put_opcode(id=tid, code="TRN-A", desc=" ", type="").status_code, 400)
check("a description already taken is refused",
      put_opcode(id=tid, code="TRN-A", desc="service tires", type="").status_code, 409)
check("a code already taken is refused",
      put_opcode(id=tid, code="s-t", desc="Training Aston", type="").status_code, 409)
check("an OP-code that no longer exists is reported", put_opcode(id=99999, code="", desc="x", type="").status_code, 404)
check("a non-JSON edit is refused",
      client.put("/api/opcodes", data="id=1", content_type="application/x-www-form-urlencoded").status_code, 415)
r = client.delete(f"/api/opcodes?id={tid}")
check("an OP-code can be deleted", (r.status_code, "Training Aston" in
      [o["desc"] for o in client.get("/api/opcodes").get_json()]), (200, False))
check("automatic learning still leaves the type blank",
      {o["desc"]: o["type"] for o in client.get("/api/opcodes").get_json()}["Service Tires"], "")

client.post("/api/refnotes", json={"category": "Story", "key": "Winter tires",
                                   "value": "Installed four winter tires.", "tags": "S-T"})
tpl = [t for t in client.get("/api/templates").get_json() if t["key"] == "Winter tires"]
check("story templates carry their name, for use as variants",
      (tpl[0]["key"], tpl[0]["tags"]) if tpl else None, ("Winter tires", "S-T"))

# Note categories fold into a handful of filter groups. The group belongs to the
# category, so re-grouping never means touching every note.
print("\nReference groups")
check("no category starts out grouped", client.get("/api/refgroups").get_json(), {})
def set_group(category, group):
    return client.put("/api/refgroups", json={"category": category, "group": group})
check("a category can be put in a group", set_group("Torque Specs", "Car info").status_code, 200)
set_group("Brakes", "Car info")
set_group("Advisors", "People")
check("  ...and the mapping comes back", client.get("/api/refgroups").get_json(),
      {"Torque Specs": "Car info", "Brakes": "Car info", "Advisors": "People"})
set_group("torque specs", "Specs")
check("category names match whatever their case", client.get("/api/refgroups").get_json().get("Torque Specs"
      , client.get("/api/refgroups").get_json().get("torque specs")), "Specs")
set_group("Advisors", "  ")
check("an empty group takes the category out of any", "Advisors" in client.get("/api/refgroups").get_json(), False)
check("a missing category is refused", set_group("", "People").status_code, 400)
check("an over-long group name is refused", set_group("Tools", "x" * 41).status_code, 400)
check("a group named like a fixed filter is refused", set_group("Tools", "op-codes").status_code, 400)
check("a non-JSON write is refused",
      client.put("/api/refgroups", data="c=x", content_type="application/x-www-form-urlencoded").status_code, 415)

# The table is new, so an existing database must simply gain it on start-up.
old_db2 = os.path.join(WORK, "pre-groups.sqlite3")
raw = sqlite3.connect(old_db2)
raw.executescript("""
CREATE TABLE [OP-Codes] (ID INTEGER PRIMARY KEY AUTOINCREMENT, Code TEXT, Description TEXT, Type TEXT DEFAULT '');
CREATE TABLE Ref_Notes (ID INTEGER PRIMARY KEY AUTOINCREMENT, Category TEXT, [Key] TEXT, [Value] TEXT, Tags TEXT);
CREATE TABLE Story_Templates (ID INTEGER PRIMARY KEY AUTOINCREMENT, [Value] TEXT, Category TEXT, [Key] TEXT, Tags TEXT);
INSERT INTO Ref_Notes (Category, [Key], [Value]) VALUES ('Torque Specs', 'Wheel', '175 Nm');
""")
raw.commit(); raw.close()
real_db = server.DB_PATH
server.DB_PATH = old_db2
try:
    server.init_db()
    raw = sqlite3.connect(old_db2)
    tables = {r[0] for r in raw.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    check("an existing database gains the groups table", "Ref_Categories" in tables, True)
    check("  ...keeping its notes", raw.execute("SELECT COUNT(*) FROM Ref_Notes").fetchone()[0], 1)
    raw.close()
finally:
    server.DB_PATH = real_db

shutil.rmtree(WORK, ignore_errors=True)
print(f"\n{passed} passed, {failed} failed\n")
sys.exit(1 if failed else 0)
