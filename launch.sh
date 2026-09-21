#!/usr/bin/env bash
# DayPunch - Copyright 2026 Nicolas Lapointe Lafortune. Licensed under the Apache License 2.0.
#
# macOS and Linux launcher. On macOS, double-click launch.command instead; it
# runs this.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# A virtual environment next to the app wins over whatever python3 is on PATH.
if [ -x "$HERE/.venv/bin/python" ]; then
  PY="$HERE/.venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
  PY="$(command -v python3)"
else
  echo "DayPunch needs Python 3, and none was found on this machine." >&2
  exit 1
fi

if ! "$PY" -c "import flask, openpyxl, webview" >/dev/null 2>&1; then
  {
    echo "DayPunch is missing a dependency. Install them with:"
    echo
    echo "  \"$PY\" -m pip install -r \"$HERE/requirements.txt\""
    if [ "$(uname -s)" = "Linux" ]; then
      echo
      echo "pywebview also needs a GUI toolkit on Linux, e.g. GTK with WebKit2"
      echo "(python3-gi and gir1.2-webkit2-4.1 on Debian and Ubuntu)."
    fi
  } >&2
  exit 1
fi

exec "$PY" "$HERE/src/launch.py"
