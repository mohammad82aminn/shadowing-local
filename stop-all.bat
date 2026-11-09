@echo off
setlocal
cd /d "%~dp0"

call stop.bat
if errorlevel 1 (
    echo Django could not be confirmed stopped; the SQLite database file was left intact.
    exit /b 1
)

echo Django stopped. The SQLite database file was left intact.
