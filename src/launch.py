# DayPunch — Copyright 2026 Nicolas Lapointe Lafortune. Licensed under the Apache License 2.0.
# DayPunch launch.py
import threading
import time
import os
import webview

from config import PORT, VERSION, APP_NAME, ORG_NAME
from daily_file import create_daily_file
from server import app


def start_flask():
    app.run(port=PORT, debug=False, use_reloader=False)


def main():
    # Step 1 — Create today's xlsx if it doesn't exist
    create_daily_file()

    # Step 2 — Start Flask in a background thread
    flask_thread = threading.Thread(target=start_flask, daemon=True)
    flask_thread.start()

    # Step 3 — Wait briefly for Flask to be ready
    time.sleep(1)

    # Step 4 — Open pywebview window (blocks until window is closed)
    def set_icon(win):
        try:
            import clr
            clr.AddReference('System.Drawing')
            from System.Drawing import Icon
            icon_path = os.path.abspath(os.path.join(os.path.dirname(__file__), 'assets', 'app.ico'))
            win.native.Icon = Icon(icon_path)
        except Exception:
            pass

    window = webview.create_window(
        title=f"{APP_NAME} {VERSION}" + (f" — {ORG_NAME}" if ORG_NAME else ""),
        url=f"http://localhost:{PORT}",
        width=1900,
        height=1000,
        min_size=(900, 600),
        resizable=True,
    )
    window.events.shown += set_icon
    from server import set_webview_window
    set_webview_window(window)
    webview.start()

if __name__ == "__main__":
    main()
