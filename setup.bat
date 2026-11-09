@echo off
setlocal
cd /d "%~dp0"

where py >nul 2>nul
if errorlevel 1 (
    echo Python Launcher was not found. Install Python 3.14 and enable the py launcher.
    exit /b 1
)

py -3.14 -m venv --clear --without-pip .venv
if errorlevel 1 exit /b %errorlevel%

py -3.14 -m pip --python .venv install -r requirements.txt
if errorlevel 1 (
    echo Dependency installation failed. Check network access to the package index.
    exit /b 1
)

if not exist ".runtime" mkdir ".runtime"
if not exist ".runtime\bootstrap-5.3.8-dist.zip" (
    powershell -NoProfile -NonInteractive -Command "Invoke-WebRequest -Uri 'https://github.com/twbs/bootstrap/releases/download/v5.3.8/bootstrap-5.3.8-dist.zip' -OutFile '.runtime\bootstrap-5.3.8-dist.zip' -TimeoutSec 60"
    if errorlevel 1 (
        echo Bootstrap download failed. Check network access to github.com.
        exit /b 1
    )
)

if not exist ".runtime\bootstrap-LICENSE" (
    powershell -NoProfile -NonInteractive -Command "Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/twbs/bootstrap/v5.3.8/LICENSE' -OutFile '.runtime\bootstrap-LICENSE' -TimeoutSec 30"
    if errorlevel 1 (
        echo Bootstrap license download failed. Check network access to raw.githubusercontent.com.
        exit /b 1
    )
)

".venv\Scripts\python.exe" scripts\vendor_bootstrap.py ".runtime\bootstrap-5.3.8-dist.zip" ".runtime\bootstrap-LICENSE"
if errorlevel 1 exit /b %errorlevel%

echo Setup completed. Run start.bat to launch Shadowing.
