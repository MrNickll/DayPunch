@echo off
rem DayPunch - Copyright 2026 Nicolas Lapointe Lafortune. Licensed under the Apache License 2.0.
rem
rem Windows launcher. Starts DayPunch with pythonw, so no console stays open.
setlocal
set "HERE=%~dp0"

rem A virtual environment next to the app wins over the system Python.
if exist "%HERE%.venv\Scripts\pythonw.exe" (
  set PYW="%HERE%.venv\Scripts\pythonw.exe"
  set PY="%HERE%.venv\Scripts\python.exe"
  goto check
)
where pyw >nul 2>nul && (set "PYW=pyw -3" & set "PY=py -3" & goto check)
where pythonw >nul 2>nul && (set "PYW=pythonw" & set "PY=python" & goto check)

echo DayPunch needs Python 3, and none was found on this machine.
echo Install it from https://www.python.org/downloads/ and run this again.
pause
exit /b 1

:check
%PY% -c "import flask, openpyxl, webview" >nul 2>nul
if errorlevel 1 (
  echo DayPunch is missing a dependency. Install them with:
  echo.
  echo   %PY% -m pip install -r "%HERE%requirements.txt"
  echo.
  pause
  exit /b 1
)

start "" %PYW% "%HERE%src\launch.py"
endlocal
