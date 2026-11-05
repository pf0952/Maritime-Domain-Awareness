@echo off
rem ENC 3D installer: see install.ps1. The policy bypass is for this run of it only.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
pause
