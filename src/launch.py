# DayPunch — Copyright 2026 Nicolas Lapointe Lafortune. Licensed under the Apache License 2.0.
# DayPunch launch.py
import threading
import os
import webview

from config import PORT, VERSION, APP_NAME, ORG_NAME
from daily_file import create_daily_file
from server import bind_server, set_webview_window


def main():
    # Step 1 — Create today's xlsx if it doesn't exist
    create_daily_file()

    # Step 2 — Bind the server before opening the window. A taken port used to
    # fail silently inside a thread, and the window then opened onto nothing --
    # or onto whatever else was already listening there. Now the system picks a
    # free port instead, and the window is pointed at the one actually bound.
    server = bind_server(PORT)
    port = server.port
    threading.Thread(target=server.serve_forever, daemon=True).start()

    # Step 3 — Open pywebview window (blocks until window is closed). The socket
    # is already listening, so there is no need to sleep and hope it is ready.
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
        # 127.0.0.1 rather than localhost: localhost can resolve to IPv6 first,
        # and the server listens on IPv4 only.
        url=f"http://127.0.0.1:{port}",
        width=1900,
        height=1000,
        min_size=(900, 600),
        resizable=True,
    )
    window.events.shown += set_icon
    set_webview_window(window)
    webview.start()

if __name__ == "__main__":
    main()
