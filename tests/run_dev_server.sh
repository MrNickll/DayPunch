#!/usr/bin/env bash
# Run PunchTrak against a throwaway profile in tests/sandbox.
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
  "$VENV/bin/pip" -q install flask openpyxl
fi

mkdir -p "$SANDBOX"
export PUNCHTRAK_APP_DATA="$SANDBOX/appdata"
export PUNCHTRAK_FOLDER="$SANDBOX/daily"
export PUNCHTRAK_PORT="${PUNCHTRAK_PORT:-5000}"

cd "$SRC"
exec "$VENV/bin/python" -c "
import logging, config, daily_file, server
logging.basicConfig(level=logging.INFO)
daily_file.create_daily_file()
print('PunchTrak', config.VERSION, '| data:', config.FOLDER, '| db:', config.DB_PATH)
server.app.run(port=config.PORT, debug=False, use_reloader=False)
"
