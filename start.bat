@echo off
rem ENC 3D. The first run sets everything up (it needs Python and Node), then the app fetches NOAA's charts itself.
rem Leave this window open while you use the app, and close it to stop.
cd /d "%~dp0"
if not exist backend\.venv\Scripts\python.exe (
  echo Setting up Python...
  python -m venv backend\.venv || goto failed
  backend\.venv\Scripts\python -m pip install --disable-pip-version-check -q -r backend\requirements.txt || goto failed
)
if not exist frontend\dist\index.html (
  echo Building the viewer...
  pushd frontend
  call npm ci --no-fund --no-audit || goto failed
  call npm run build || goto failed
  popd
)
set ENC_OPEN_BROWSER=1
backend\.venv\Scripts\python -m uvicorn main:app --app-dir backend %*
:failed
pause
