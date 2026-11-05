@echo off
rem ENC 3D. The first run sets everything up (it needs Python and Node), then the app fetches NOAA's charts itself.
rem Close the app's window and it stops.
cd /d "%~dp0"
if not exist backend\.venv\Scripts\python.exe (
  echo Setting up Python...
  python -m venv backend\.venv || goto failed
)
rem every time, as an update can need a new package; it's quick when there's nothing to do
backend\.venv\Scripts\python -m pip install --disable-pip-version-check -q -r backend\requirements.txt || goto failed
if not exist frontend\dist\index.html (
  echo Building the viewer...
  pushd frontend
  call npm ci --no-fund --no-audit || goto failed
  call npm run build || goto failed
  popd
)
rem opens it in a window of its own, starting the server first on a free port if it isn't running already. The server
rem runs with no console (its messages go to enc\server.log), and stops once the last window is closed
start "" backend\.venv\Scripts\pythonw.exe backend\launch.py %*
exit /b 0
:failed
pause
