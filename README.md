# DayPunch

Licensed under the Apache License 2.0 — see `LICENSE`.

A single-user tool for a technician to log how a working day was spent: a
sequence of time punches, each with a job number, a description, and notes.
It writes one spreadsheet per day and keeps a small reference library of
op-codes, notes and reusable text snippets.

## What it is

- A local web page served by a small Python process, displayed in a desktop
  window.
- The process listens on the loopback interface (`127.0.0.1`) only. It is not
  reachable from another machine, and it makes no outbound connections.

## What it touches

Everything it writes goes to two places.

**A per-user state folder**, holding `daypunch.sqlite3` (op-codes and reference
notes) and `settings.json` (data folder and field labels):

| Platform | State folder |
|---|---|
| Windows | `%LOCALAPPDATA%\DayPunch` |
| macOS | `~/Library/Application Support/DayPunch` |
| Linux | `$XDG_DATA_HOME/DayPunch`, by default `~/.local/share/DayPunch` |

**A data folder** for the day sheets, one `.xlsx` per day, set by `data_folder`
in `settings.json` and by default `DayPunch/Daily` under the user's Documents
folder. Calendar event files, if used, go in a `Calendar` subfolder of it.

No database driver, no service, no scheduled task, no registry keys, no
elevation, no outbound connections.

## Configuration

Everything site-specific lives in `settings.json`, created on first run:

```json
{
  "data_folder": "...",
  "org_name": "",
  "labels": { "job_number": "Job #", "ref_id": "Ticket Number", "copy_tab": "TEXT" }
}
```

Field labels are read from there, so the same build suits any shop without
touching code. `org_name` appears in the window title when set.

## Branding

`src/assets/logo.svg` is a placeholder. Replace it with any square-viewBox SVG
and it will fit the header slot. `--accent` at the top of `src/styles.css` is
the single colour to change for a house palette.

## Running it

Install the three dependencies once:

```
python -m pip install -r requirements.txt
```

Then start it with the launcher for your platform:

| Platform | Launcher |
|---|---|
| Windows | `launch.cmd` |
| macOS | `launch.command` — double-click in Finder |
| Linux | `launch.sh` |

Each one uses a `.venv` beside the app if there is one, otherwise the system
Python, and prints exactly what to install if a dependency is missing.

On macOS a copy downloaded as a ZIP carries Apple's quarantine flag, so the
first launch needs right-click → Open. A `git clone` does not.

For development, `tests/run_dev_server.sh` serves the app in a browser against a
throwaway profile.

## Tests

```
tests/.venv/bin/python tests/test_api.py      # 33 server checks
osascript -l JavaScript tests/test_app_js.js  # 42 app.js checks (node also works)
```

See `tests/README.md`.
