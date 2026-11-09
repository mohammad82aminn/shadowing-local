@echo off
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo Project virtual environment is missing.
    echo Run setup.bat to create the isolated environment and install approved dependencies.
    exit /b 1
)

".venv\Scripts\python.exe" scripts\runtime.py start
if errorlevel 1 exit /b %errorlevel%
echo Open the local application URL printed above.
