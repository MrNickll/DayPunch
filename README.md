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

| | |
|---|---|
| One SQLite file | `%LOCALAPPDATA%\DayPunch\daypunch.sqlite3` — op-codes and reference notes |
| Settings | `%LOCALAPPDATA%\DayPunch\settings.json` — folder location and field labels |
| One `.xlsx` per day | in the folder named by `data_folder`, default `Documents\DayPunch\Daily` |
| Optional calendar files | `.json` files in a `Calendar` subfolder, if used |

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

```
tests/run_dev_server.sh          # development, throwaway profile in tests/sandbox
python src/launch.py             # the real desktop window
```

## Tests

```
tests/.venv/bin/python tests/test_api.py      # 33 server checks
osascript -l JavaScript tests/test_app_js.js  # 42 app.js checks (node also works)
```

See `tests/README.md`.
