#!/usr/bin/env bash
# Run DayPunch against a throwaway profile in tests/sandbox.
# The app creates its own database and its first day sheet, so there is nothing
# to seed. Creates tests/.venv on first run. macOS/Linux development only.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(dirname "$HERE")/src"
VENV="$HERE/.venv"
SANDBOX="$HERE/sandbox"

if [ ! -x "$VENV/bin/python" ]; then
  echo "Creating $VENV ..."
  python3 -m venv "$VENV"
  # "python -m pip" rather than bin/pip: bin/pip carries the venv's absolute path
  # in its shebang, so it breaks the moment the folder is moved or renamed.
  "$VENV/bin/python" -m pip -q install flask openpyxl
fi

mkdir -p "$SANDBOX"
export DAYPUNCH_APP_DATA="$SANDBOX/appdata"
export DAYPUNCH_FOLDER="$SANDBOX/daily"
export DAYPUNCH_PORT="${DAYPUNCH_PORT:-5000}"

cd "$SRC"
exec "$VENV/bin/python" -c "
import logging, config, daily_file, server
logging.basicConfig(level=logging.INFO)
daily_file.create_daily_file()
srv = server.bind_server(config.PORT)
print('DayPunch', config.VERSION, '| data:', config.FOLDER, '| db:', config.DB_PATH)
print(' * Running on http://127.0.0.1:%d' % srv.port, flush=True)
srv.serve_forever()
"
