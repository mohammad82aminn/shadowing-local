@echo off
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo Project virtual environment is missing; nothing was stopped.
    exit /b 1
)

".venv\Scripts\python.exe" scripts\runtime.py stop
