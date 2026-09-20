# Tests

No installation beyond `flask` and `openpyxl`, which `run_dev_server.sh` puts
in `tests/.venv` on first run.

```
tests/.venv/bin/python tests/test_api.py       # 33 server checks
osascript -l JavaScript tests/test_app_js.js   # 42 app.js checks
node tests/test_app_js.js                      # same, if node is installed
```

`test_api.py` runs the Flask app in-process against a throwaway profile in a
temp directory. The app creates its own SQLite database and its first day
sheet, so there is nothing to seed and repeated runs cannot drift.

`test_app_js.js` loads the real `src/app.js` against a stubbed DOM that records
event listeners, so handler accumulation is directly observable. `fetch` never
resolves, which parks `init()` at its first await and leaves the tests in
control. `PUNCHTRAK_APP_JS` points the harness at another copy of `app.js`,
which is how a fix gets A/B'd against the code it replaced.

## Environment variables

| Variable | Purpose |
|---|---|
| `PUNCHTRAK_APP_DATA` | per-user state (database, settings) |
| `PUNCHTRAK_FOLDER` | where the dated `.xlsx` files live |
| `PUNCHTRAK_CALENDAR_FOLDER` | calendar event drop folder |
| `PUNCHTRAK_DB` | the SQLite file |
| `PUNCHTRAK_ORG` | organisation name in the window title |
| `PUNCHTRAK_PORT` | server port (default 5000) |

None are set in normal use.
