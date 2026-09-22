# DayPunch — Copyright 2026 Nicolas Lapointe Lafortune. Licensed under the Apache License 2.0.
# DayPunch server.py
from flask import Flask, jsonify, request, send_from_directory
from openpyxl import load_workbook
from openpyxl.styles import PatternFill, Font, Alignment, Border
from datetime import date, datetime, time
from contextlib import closing
import glob
import logging
import os
import socket
import sqlite3
import config
from config import (
    FOLDER, PUNCH_ROWS, DATA_COLS, MAX_PUNCHES, PUNCH_SHEET, DB_PATH,
)
from calendar_sync import write_calendar_event, cleanup_old_calendar_files
from werkzeug.serving import make_server

app = Flask(__name__, static_folder=None)
log = logging.getLogger("daypunch")

_webview_window = None


# ── Request guard ─────────────────────────────────────────────────────────────
# The server only listens on loopback, but a web page open in the user's normal
# browser can still send it requests. The awkward case is DNS rebinding: a
# hostile name re-pointed at 127.0.0.1, which the browser then treats as the
# same origin and lets read the replies. Such requests still carry the hostile
# name in their Host header, so refusing anything not addressed to this machine
# closes that door for every route at once.
_LOCAL_HOSTS = {"localhost", "127.0.0.1", "[::1]"}


def _hostname(host):
    host = (host or "").strip().lower()
    if host.startswith("["):                        # [::1]:5000
        return host.split("]", 1)[0] + "]"
    return host.split(":", 1)[0]


@app.before_request
def _only_local_hosts():
    if _hostname(request.host) not in _LOCAL_HOSTS:
        return jsonify({"error": "Requests must be addressed to this machine."}), 403


def set_webview_window(win):
    global _webview_window
    _webview_window = win


# ── Database ──────────────────────────────────────────────────────────────────
# One SQLite file in the user profile. There is no driver to install, no network
# path and nothing shared, which is both simpler and a much shorter answer to
# "what does this program touch?".

SCHEMA = """
CREATE TABLE IF NOT EXISTS [OP-Codes] (
    ID          INTEGER PRIMARY KEY AUTOINCREMENT,
    Code        TEXT DEFAULT '',
    Description TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS Ref_Notes (
    ID       INTEGER PRIMARY KEY AUTOINCREMENT,
    Category TEXT,
    [Key]    TEXT,
    [Value]  TEXT,
    Tags     TEXT
);
CREATE TABLE IF NOT EXISTS Story_Templates (
    ID       INTEGER PRIMARY KEY AUTOINCREMENT,
    [Value]  TEXT,
    Category TEXT,
    [Key]    TEXT,
    Tags     TEXT
);
"""


class _Cursor:
    """sqlite3 cursor that takes parameters as varargs, the way this file
    writes its queries."""

    def __init__(self, cur):
        self._cur = cur

    def execute(self, sql, *params):
        if len(params) == 1 and isinstance(params[0], (tuple, list)):
            params = tuple(params[0])
        self._cur.execute(sql, params)
        return self

    def fetchall(self):
        return self._cur.fetchall()

    def fetchone(self):
        return self._cur.fetchone()


class _Connection:
    def __init__(self, conn):
        self._conn = conn

    def cursor(self):
        return _Cursor(self._conn.cursor())

    def commit(self):
        self._conn.commit()

    def close(self):
        self._conn.close()


def init_db():
    """Create the database on first run and seed it. Returns True if it was new."""
    folder = os.path.dirname(DB_PATH)
    if folder:
        os.makedirs(folder, exist_ok=True)
    fresh = not os.path.exists(DB_PATH)
    with closing(sqlite3.connect(DB_PATH)) as conn:
        conn.executescript(SCHEMA)
        if fresh and config.SEED_REF_NOTES:
            conn.executemany(
                "INSERT INTO Ref_Notes (Category, [Key], [Value], Tags) VALUES (?, ?, ?, ?)",
                config.SEED_REF_NOTES,
            )
            log.info("new database seeded with %d reference notes",
                     len(config.SEED_REF_NOTES))
        conn.commit()
    return fresh


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA foreign_keys = ON")
    return _Connection(conn)


config.write_default_settings()
init_db()


# ── Serving ───────────────────────────────────────────────────────────────────

def _bind_loopback(port):
    """A listening IPv4 loopback socket on `port` (0 means any free port).

    Deliberately without SO_REUSEADDR: on Windows that option lets a socket
    bind a port another program is actively using, which is the silent
    takeover this exists to prevent.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(("127.0.0.1", port))
        sock.listen(128)
    except OSError:
        sock.close()
        raise
    return sock


def bind_server(preferred):
    """Serve the app on the preferred loopback port, or on any free one if that
    is taken.

    The bind is the check: asking "is it free?" and binding afterwards leaves a
    gap in which something else can take the port. The socket is bound here and
    handed to Werkzeug rather than letting make_server() bind it, because on a
    busy port make_server() prints a message and calls sys.exit(1) -- nothing a
    caller can catch and recover from. The socket is listening by the time this
    returns, so a client can connect before serve_forever() is running.
    """
    try:
        sock = _bind_loopback(preferred)
    except OSError:
        log.warning("port %d is in use; letting the system choose one", preferred)
        sock = _bind_loopback(0)
    port = sock.getsockname()[1]
    srv = make_server("127.0.0.1", port, app, threaded=True, fd=sock.fileno())
    sock.close()              # make_server() works on its own duplicate
    return srv


# ── Helpers ───────────────────────────────────────────────────────────────────

def find_today_file():
    today_str = date.today().strftime("%Y-%m-%d")
    path = os.path.join(FOLDER, f"{today_str}.xlsx")
    if os.path.exists(path):
        return path
    files = sorted(glob.glob(os.path.join(FOLDER, "????-??-??.xlsx")))
    return files[-1] if files else None

def list_dated_files():
    files = sorted(glob.glob(os.path.join(FOLDER, "????-??-??.xlsx")), reverse=True)
    return [os.path.basename(f) for f in files]

def find_previous_file():
    """Return the most recent dated file that is NOT today's."""
    today_str = date.today().strftime("%Y-%m-%d")
    files = sorted(glob.glob(os.path.join(FOLDER, "????-??-??.xlsx")), reverse=True)
    for f in files:
        if not os.path.basename(f).startswith(today_str):
            return f
    return None

def is_today(filepath):
    return os.path.basename(filepath).startswith(date.today().strftime("%Y-%m-%d"))

def cell_val(cell):
    v = cell.value
    if isinstance(v, datetime): return v.strftime("%Y-%m-%d")
    if isinstance(v, time):     return v.strftime("%H:%M")
    if v is None:               return ""
    return str(v)

def _as_int(value):
    """RO numbers land in a numeric cell; never 500 on a stray character."""
    if value is None or str(value).strip() == "":
        return None
    try:
        return int(str(value).strip())
    except ValueError:
        return str(value).strip()

def clear_row_data(ws, row):
    for col in DATA_COLS:
        ws.cell(row, col).value = None

def clear_row_completely(ws, row):
    for col in range(1, 16):
        cell = ws.cell(row, col)
        cell.value     = None
        cell.fill      = PatternFill(fill_type=None)
        cell.font      = Font()
        cell.alignment = Alignment()
        cell.border    = Border()

def ensure_row_formulas(ws, row):
    r  = row
    nr = row + 1
    if r > 2:
        ws.cell(r, 1).value = '=$A$2'
    ws.cell(r, 6).value = f'=MAX(0,SUM(B{nr}-B{r})*24)'
    if ws.cell(r, 12).value is None:
        ws.cell(r, 12).value = '-'
    ws.cell(r, 13).value = (
        f'=IF(I{r}="x",(_xlfn.CONCAT(J{r}," ","- ",N{r},", ",O{r}," - ",C{r},", ",G{r}," - ",K{r},": ",L{r})),'
        f'(_xlfn.CONCAT(J{r}," ","- ",N{r},", ",O{r}," - ",C{r},", ",K{r},": ",L{r})))'
    )
    ws.cell(r, 14).value = f'=TEXT(A{r},"mm/dd/yyyy")'
    ws.cell(r, 15).value = f'=TEXT(B{r},"hh:mm")'


# ── Static ────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return send_from_directory('../src', 'index.html')

@app.route("/styles.css")
def styles():
    return send_from_directory('../src', 'styles.css')

@app.route("/app.js")
def appjs():
    return send_from_directory('../src', 'app.js')

@app.route("/assets/<path:filename>")
def assets(filename):
    return send_from_directory('../src/assets', filename)


# ── Carryover ─────────────────────────────────────────────────────────────────

@app.route("/api/carryover", methods=["GET"])
def get_carryover():
    """
    Look at the previous day's file and find the last W/DW punch with an RO,
    skipping C punches at the end. Returns it as a carryover candidate.
    """
    prev = find_previous_file()
    if not prev:
        return jsonify({"carryover": None})
    try:
        wb = load_workbook(prev, data_only=True, read_only=True)
        ws = wb[PUNCH_SHEET]
        punches = []
        for r in PUNCH_ROWS:
            time_val = ws.cell(r, 2).value
            status   = ws.cell(r, 3).value
            if time_val is None and status is None:
                break
            punches.append({
                "status":      cell_val(ws.cell(r, 3)),
                "ro":          cell_val(ws.cell(r, 4)),
                "line":        cell_val(ws.cell(r, 5)),
                "opcode":      cell_val(ws.cell(r, 7)),
                "warranty":    cell_val(ws.cell(r, 9)),
                "description": cell_val(ws.cell(r, 11)),
            })
        wb.close()
        for p in reversed(punches):
            if p["status"] == "C":
                continue
            if p["status"] in ("W", "DW") and p["ro"]:
                return jsonify({"carryover": p, "from": os.path.basename(prev)})
            break
        return jsonify({"carryover": None})
    except Exception:
        return jsonify({"carryover": None})


# ── Files ─────────────────────────────────────────────────────────────────────

@app.route("/api/files", methods=["GET"])
def get_files():
    return jsonify(list_dated_files())


# ── Punches ───────────────────────────────────────────────────────────────────

@app.route("/api/punches", methods=["GET"])
def get_punches():
    filename = request.args.get("file")
    path = os.path.join(FOLDER, filename) if filename else find_today_file()
    if not path or not os.path.exists(path):
        return jsonify({"error": "No file found"}), 404
    try:
        wb = load_workbook(path, data_only=True, read_only=True)
        ws = wb[PUNCH_SHEET]
        anchor_date = cell_val(ws.cell(2, 1))
        punches = []
        for r in PUNCH_ROWS:
            time_val = ws.cell(r, 2).value
            status   = ws.cell(r, 3).value
            if time_val is None and status is None:
                break
            punches.append({
                "row":         r,
                "date":        anchor_date,
                "time":        cell_val(ws.cell(r, 2)),
                "status":      cell_val(ws.cell(r, 3)),
                "ro":          cell_val(ws.cell(r, 4)),
                "line":        cell_val(ws.cell(r, 5)),
                "duration":    cell_val(ws.cell(r, 6)),
                "opcode":      cell_val(ws.cell(r, 7)),
                "odometer":    cell_val(ws.cell(r, 8)),
                "warranty":    cell_val(ws.cell(r, 9)),
                "refid":       cell_val(ws.cell(r, 10)),
                "description": cell_val(ws.cell(r, 11)),
                "story":       cell_val(ws.cell(r, 12)),
            })
        wb.close()
        for i in range(len(punches)):
            try:
                t1 = datetime.strptime(punches[i]["time"], "%H:%M")
                if i + 1 < len(punches):
                    t2 = datetime.strptime(punches[i + 1]["time"], "%H:%M")
                    delta = (t2 - t1).total_seconds() / 3600
                    punches[i]["duration"] = str(round(delta, 4)) if delta > 0 else ""
                else:
                    punches[i]["duration"] = ""
            except Exception:
                punches[i]["duration"] = ""
        return jsonify({"file": os.path.basename(path), "is_today": is_today(path), "punches": punches})
    except PermissionError:
        return jsonify({"error": "File is open in Excel. Close it and try again."}), 423

@app.route("/api/punches", methods=["POST"])
def save_punches():
    body     = request.json
    filename = body.get("file")
    data     = body.get("punches", [])
    path     = os.path.join(FOLDER, filename) if filename else find_today_file()
    if not path or not os.path.exists(path):
        return jsonify({"error": "No file found"}), 404
    try:
        wb = load_workbook(path)
    except PermissionError:
        return jsonify({"error": "File is open in Excel. Close it to save."}), 423

    ws = wb[PUNCH_SHEET]
    for r in PUNCH_ROWS:
        clear_row_data(ws, r)
    for r in range(31, min(ws.max_row + 1, 85)):
        clear_row_completely(ws, r)

    dropped = max(0, len(data) - MAX_PUNCHES)
    for i, punch in enumerate(data[:MAX_PUNCHES]):
        r = i + 2
        ensure_row_formulas(ws, r)
        ws.cell(r, 2).value  = punch.get("time") or None
        ws.cell(r, 3).value  = punch.get("status") or None
        ws.cell(r, 4).value  = _as_int(punch.get("ro"))
        ws.cell(r, 5).value  = punch.get("line") or None
        ws.cell(r, 7).value  = punch.get("opcode") or None
        ws.cell(r, 8).value  = punch.get("odometer") or None
        ws.cell(r, 9).value  = punch.get("warranty") or None
        ws.cell(r, 10).value = punch.get("refid") or None
        ws.cell(r, 11).value = punch.get("description") or None
        ws.cell(r, 12).value = punch.get("story") or "-"

    if is_today(path):
        ws["A2"] = date.today()

    wb.save(path)
    wb.close()

    # Calendar sync — write event json for any newly closed punches
    for i in range(len(data) - 1):
        p = data[i]
        if p.get("status") in ("W", "DW", "WI", "B", "A"):
            next_p = data[i + 1]
            write_calendar_event(p, next_p)

    if any(p.get("status") == "C" for p in data):
        cleanup_old_calendar_files()

    if dropped:
        return jsonify({
            "ok": False,
            "error": f"Only {MAX_PUNCHES} punches fit in a day sheet — "
                     f"{dropped} punch(es) were not saved.",
        }), 507

    return jsonify({"ok": True})


# ── Templates ─────────────────────────────────────────────────────────────────

@app.route("/api/templates", methods=["GET"])
def get_templates():
    try:
        with closing(get_db()) as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT [Value], Tags FROM Story_Templates ORDER BY Category, [Key]")
            templates = [{"value": row[0], "tags": row[1] or ""}
                         for row in cursor.fetchall() if row[0]]
        return jsonify(templates)
    except Exception:
        log.exception("get_templates failed")
        return jsonify([])

# ── Last modified ─────────────────────────────────────────────────────────────

@app.route("/api/lastmodified", methods=["GET"])
def last_modified():
    filename = request.args.get("file")
    path = os.path.join(FOLDER, filename) if filename else find_today_file()
    if not path or not os.path.exists(path):
        return jsonify({"ts": 0})
    return jsonify({"ts": os.path.getmtime(path)})

# ── OP-Codes ──────────────────────────────────────────────────────────────────

@app.route("/api/opcodes", methods=["GET"])
def get_opcodes():
    try:
        with closing(get_db()) as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT [Code], [Description] FROM [OP-Codes] ORDER BY [Description]")
            codes = [{"code": row[0] or "", "desc": row[1] or ""}
                     for row in cursor.fetchall()]
        return jsonify(codes)
    except Exception:
        log.exception("get_opcodes failed")
        return jsonify([])

def _upsert_opcode(conn, code, desc):
    """Insert an OP-code, or fill in the code of one already saved without it.

    Descriptions are usually typed before the OP-code is known, so the row gets
    created code-less. Matching is done in Python on trimmed, case-folded text
    so it behaves the same whatever the backend collation is. Does not commit.
    """
    code = (code or "").strip()
    desc = (desc or "").strip()
    if not desc:
        return {"ok": True, "skipped": "no-description"}

    cursor = conn.cursor()
    cursor.execute("SELECT ID, [Code], [Description] FROM [OP-Codes]")
    rows = [
        (row[0], (row[1] or "").strip(), (row[2] or "").strip())
        for row in cursor.fetchall()
    ]

    by_desc = next((r for r in rows if r[2].lower() == desc.lower()), None)
    by_code = next((r for r in rows if code and r[1].lower() == code.lower()), None)

    if by_desc:
        if not code or by_desc[1].lower() == code.lower():
            return {"ok": True, "skipped": "known"}
        if by_desc[1]:
            return {"ok": True, "skipped": "description-has-other-code",
                    "existing": by_desc[1]}
        if by_code and by_code[0] != by_desc[0]:
            return {"ok": True, "skipped": "code-used-elsewhere", "existing": by_code[2]}
        cursor.execute("UPDATE [OP-Codes] SET [Code]=? WHERE ID=?", code, by_desc[0])
        return {"ok": True, "updated": True}

    if by_code:
        return {"ok": True, "skipped": "code-used-elsewhere", "existing": by_code[2]}

    cursor.execute("INSERT INTO [OP-Codes] ([Code], [Description]) VALUES (?, ?)", code, desc)
    return {"ok": True, "added": True}


def _insert_refnote(conn, category, key, value, tags):
    """Insert a reference note or story template. Does not commit."""
    table = "Story_Templates" if (category or "").lower() == "story" else "Ref_Notes"
    conn.cursor().execute(
        f"INSERT INTO {table} (Category, [Key], [Value], Tags) VALUES (?, ?, ?, ?)",
        category, key, value, tags
    )
    return {"ok": True}


@app.route("/api/opcodes", methods=["POST"])
def add_opcode():
    entry = request.json or {}
    code  = (entry.get("code") or "").strip()
    desc  = (entry.get("desc") or "").strip()
    if not desc:
        return jsonify({"ok": True, "skipped": "no-description"})
    try:
        with closing(get_db()) as conn:
            result = _upsert_opcode(conn, code, desc)
            if result.get("added") or result.get("updated"):
                conn.commit()
            return jsonify(result)
    except Exception as e:
        log.exception("add_opcode failed")
        return jsonify({"error": str(e)}), 500


# ── Ref Notes ─────────────────────────────────────────────────────────────────

@app.route("/api/refnotes", methods=["GET"])
def get_refnotes():
    try:
        notes = []
        with closing(get_db()) as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT ID, Category, [Key], [Value], Tags FROM Ref_Notes ORDER BY Category, Key")
            for row in cursor.fetchall():
                notes.append({
                    "row":      row[0],
                    "sheet":    "Ref_Notes",
                    "category": row[1] or "",
                    "key":      row[2] or "",
                    "value":    row[3] or "",
                    "tags":     row[4] or "",
                })

            cursor.execute("SELECT ID, Category, [Key], [Value], Tags FROM Story_Templates ORDER BY Category, Key")
            for row in cursor.fetchall():
                notes.append({
                    "row":      row[0],
                    "sheet":    "Story_Templates",
                    "category": row[1] or "Story",
                    "key":      row[2] or "",
                    "value":    row[3] or "",
                    "tags":     row[4] or "",
                })
        return jsonify(notes)
    except Exception:
        log.exception("get_refnotes failed")
        return jsonify([])

@app.route("/api/refnotes", methods=["POST"])
def add_refnote():
    entry    = request.json
    category = entry.get("category", "").strip()
    key      = entry.get("key", "").strip()
    value    = entry.get("value", "").strip()
    tags     = entry.get("tags", "").strip()
    try:
        with closing(get_db()) as conn:
            _insert_refnote(conn, category, key, value, tags)
            conn.commit()
        return jsonify({"ok": True})
    except Exception as e:
        log.exception("add_refnote failed")
        return jsonify({"error": str(e)}), 500

@app.route("/api/refnotes", methods=["PUT"])
def update_refnote():
    entry   = request.json
    row_id  = entry.get("row")
    sheet   = entry.get("sheet", "Ref_Notes")
    if not row_id:
        return jsonify({"error": "No row"}), 400
    try:
        with closing(get_db()) as conn:
            cursor = conn.cursor()
            if sheet == "Story_Templates":
                cursor.execute(
                    "UPDATE Story_Templates SET Category=?, [Key]=?, [Value]=?, Tags=? WHERE ID=?",
                    entry.get("category",""), entry.get("key",""), entry.get("value",""), entry.get("tags",""), row_id
                )
            else:
                cursor.execute(
                    "UPDATE Ref_Notes SET Category=?, [Key]=?, [Value]=?, Tags=? WHERE ID=?",
                    entry.get("category",""), entry.get("key",""), entry.get("value",""), entry.get("tags",""), row_id
                )
            conn.commit()
        return jsonify({"ok": True})
    except Exception as e:
        log.exception("update_refnote failed")
        return jsonify({"error": str(e)}), 500

@app.route("/api/refnotes", methods=["DELETE"])
def delete_refnote():
    row_id = request.args.get("row", type=int)
    sheet  = request.args.get("sheet", "Ref_Notes")
    if not row_id:
        return jsonify({"error": "No row"}), 400
    try:
        table = "Story_Templates" if sheet == "Story_Templates" else "Ref_Notes"
        with closing(get_db()) as conn:
            cursor = conn.cursor()
            cursor.execute(f"DELETE FROM {table} WHERE ID=?", row_id)
            conn.commit()


        return jsonify({"ok": True})
    except Exception as e:
        log.exception("delete_refnote failed")
        return jsonify({"error": str(e)}), 500

# ── Backup DB Warning ─────────────────────────────────────────────────────────

@app.route("/api/dbstatus", methods=["GET"])
def db_status():
    """Health of the reference database, and the labels the UI should render."""
    try:
        with closing(get_db()) as conn:
            cur = conn.cursor()
            cur.execute("SELECT COUNT(*) FROM [OP-Codes]")
            opcodes = cur.fetchone()[0]
            cur.execute("SELECT COUNT(*) FROM Ref_Notes")
            notes = cur.fetchone()[0]
        return jsonify({"db_ok": True, "opcodes": opcodes, "notes": notes})
    except Exception as e:
        log.exception("db_status failed")
        return jsonify({"db_ok": False, "error": str(e)})


@app.route("/api/settings", methods=["GET"])
def get_settings():
    """Field labels and org name, so nothing shop-specific is baked into the UI,
    plus what the settings screen needs to edit them."""
    return jsonify({
        "labels":             config.LABELS,
        "org_name":           config.ORG_NAME,
        "app_name":           config.APP_NAME,
        "version":            config.VERSION,
        "data_folder":        config.SETTINGS["data_folder"],
        "active_data_folder": FOLDER,          # what is in use until restart
        "state_folder":       config.APP_DATA_DIR,
        "defaults":           config.DEFAULTS["labels"],
        "locked":             config.locked_fields(),
    })


@app.route("/api/settings", methods=["PUT"])
def update_settings():
    # Requiring JSON is also part of keeping other web pages out: a cross-site
    # request with this content type needs a CORS preflight, and this server
    # never grants one.
    if not request.is_json:
        return jsonify({"error": "Expected application/json."}), 415
    try:
        new = config.validate_settings(request.get_json(silent=True))
        config.save_settings(new)
    except config.SettingsError as e:
        return jsonify({"error": str(e)}), 400
    except OSError as e:
        log.exception("saving settings failed")
        return jsonify({"error": f"Could not write the settings file: {e}"}), 500
    restart = ("data_folder" not in config.locked_fields()
               and os.path.normpath(new["data_folder"]) != os.path.normpath(FOLDER))
    return jsonify({"ok": True, "restart_needed": restart})

# ── Windows Title Bar ─────────────────────────────────────────────────────────
@app.route("/api/title", methods=["POST"])
def set_title():
    global _webview_window
    title = request.json.get("title", "DayPunch")
    if _webview_window:
        _webview_window.set_title(title)
    return jsonify({"ok": True})
