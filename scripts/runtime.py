"""Windows runtime helper for local Shadowing start and stop scripts."""

from __future__ import annotations

import json
import os
import secrets
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parents[1]
ENV_FILE = ROOT / ".env"
RUNTIME_DIR = ROOT / ".runtime"
PID_FILE = RUNTIME_DIR / "django.pid"
LOG_FILE = RUNTIME_DIR / "django.log"
PYTHON = ROOT / ".venv" / "Scripts" / "python.exe"


def load_or_create_environment() -> dict[str, str]:
    """Read .env or create it with local-only random secrets."""
    if not ENV_FILE.exists():
        values = {
            "DJANGO_SECRET_KEY": secrets.token_urlsafe(50),
            "DJANGO_PORT": "8000",
        }
        ENV_FILE.write_text(
            "".join(f"{key}={value}\n" for key, value in values.items()),
            encoding="utf-8",
        )
        print("Created .env with local random secrets (the file is Git-ignored).")
        return values

    values: dict[str, str] = {}
    for line in ENV_FILE.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")

    required = {"DJANGO_SECRET_KEY"}
    missing = sorted(required - values.keys())
    if missing:
        raise RuntimeError(f"Missing .env values: {', '.join(missing)}")
    values.setdefault("DJANGO_PORT", "8000")
    return values


def project_environment() -> dict[str, str]:
    """Combine process variables with the project-local .env values."""
    environment = os.environ.copy()
    for key, value in load_or_create_environment().items():
        environment.setdefault(key, value)
    environment["DJANGO_SETTINGS_MODULE"] = "config.settings"
    return environment


def database_available(environment: dict[str, str]) -> bool:
    """Check SQLite connectivity without applying migrations."""
    try:
        result = subprocess.run(
            [
                str(PYTHON),
                "-c",
                "from django.db import connections; "
                "connections['default'].ensure_connection()",
            ],
            cwd=ROOT,
            env=environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=8,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0


def check_migrations(environment: dict[str, str]) -> None:
    """Show migration status for review; never apply migrations here."""
    result = subprocess.run(
        [str(PYTHON), "manage.py", "showmigrations", "--plan"],
        cwd=ROOT,
        env=environment,
        check=False,
    )
    if result.returncode != 0:
        print("Migration status could not be checked; no migrations were applied.")


def collect_static(environment: dict[str, str]) -> None:
    """Prepare local static files without changing database state."""
    result = subprocess.run(
        [str(PYTHON), "manage.py", "collectstatic", "--noinput"],
        cwd=ROOT,
        env=environment,
        check=False,
    )
    if result.returncode != 0:
        print("Static files could not be prepared; Django will still be started.")


def wait_for_server(process: subprocess.Popen[bytes], port: int) -> bool:
    """Wait for the local health endpoint or detect an early server exit."""
    for _ in range(20):
        if process.poll() is not None:
            return False
        try:
            with urlopen(f"http://127.0.0.1:{port}/health/", timeout=3) as response:
                payload = json.loads(response.read())
                if response.status == 200 and payload == {
                    "status": "ok",
                    "database": "available",
                }:
                    return True
        except HTTPError as error:
            if error.code == 503:
                try:
                    payload = json.loads(error.read())
                except ValueError:
                    payload = None
                if payload == {"status": "degraded", "database": "unavailable"}:
                    return True
        except (URLError, TimeoutError, OSError):
            time.sleep(0.25)
        time.sleep(0.25)
    return False


def is_project_server(process_id: int) -> bool:
    """Confirm a recorded PID belongs to this project's Django runserver."""
    python_path = str(PYTHON).replace("'", "''")
    command = (
        f"$p = Get-CimInstance Win32_Process -Filter 'ProcessId = {process_id}'; "
        f"if ($null -ne $p -and $p.CommandLine.StartsWith('{python_path}', "
        "[System.StringComparison]::OrdinalIgnoreCase) "
        "-and $p.CommandLine -like '*manage.py*runserver*127.0.0.1:*') "
        "{ exit 0 } else { exit 1 }"
    )
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", command],
            cwd=ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=5,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0


def start() -> int:
    """Launch Django with its local SQLite database, bound to localhost."""
    if not PYTHON.is_file():
        print(
            "Project dependencies are missing. Run setup.bat to create .venv "
            "and install requirements.txt."
        )
        return 1

    environment = project_environment()
    try:
        port = int(environment["DJANGO_PORT"])
    except ValueError:
        print("DJANGO_PORT must be a valid TCP port number.")
        return 1
    if not 1 <= port <= 65535:
        print("DJANGO_PORT must be between 1 and 65535.")
        return 1

    RUNTIME_DIR.mkdir(exist_ok=True)
    collect_static(environment)

    database_ready = database_available(environment)
    if database_ready:
        check_migrations(environment)
    else:
        print("Starting in degraded mode; the local SQLite database is unavailable.")

    if PID_FILE.exists():
        try:
            existing_pid = int(PID_FILE.read_text(encoding="ascii").strip())
        except ValueError:
            PID_FILE.unlink(missing_ok=True)
        else:
            if is_project_server(existing_pid):
                print(f"Django is already running (PID {existing_pid}).")
                return 0
            PID_FILE.unlink(missing_ok=True)

    log_handle = LOG_FILE.open("ab")
    creation_flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    creation_flags |= getattr(subprocess, "DETACHED_PROCESS", 0)
    process = subprocess.Popen(
        [str(PYTHON), "manage.py", "runserver", "--noreload", f"127.0.0.1:{port}"],
        cwd=ROOT,
        env=environment,
        stdin=subprocess.DEVNULL,
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        creationflags=creation_flags,
    )
    log_handle.close()
    if not wait_for_server(process, port):
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            cwd=ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=10,
        )
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
        PID_FILE.unlink(missing_ok=True)
        log_tail = LOG_FILE.read_bytes()[-4096:].decode("utf-8", "replace")
        print("Django failed to start. Recent log output:")
        print(log_tail)
        return 1
    PID_FILE.write_text(str(process.pid), encoding="ascii")
    print(f"Django started at http://127.0.0.1:{port}/ (PID {process.pid}).")
    print(f"Runtime log: {LOG_FILE}")
    return 0


def stop() -> int:
    """Stop only the Django process recorded by this project."""
    if not PID_FILE.exists():
        print("No Django process is recorded as running.")
        return 0

    try:
        process_id = int(PID_FILE.read_text(encoding="ascii").strip())
    except ValueError:
        PID_FILE.unlink(missing_ok=True)
        print("The recorded PID is invalid; no process was stopped.")
        return 1
    if not is_project_server(process_id):
        PID_FILE.unlink(missing_ok=True)
        print("The recorded PID does not belong to this project's Django server.")
        return 1
    result = subprocess.run(
        ["taskkill", "/PID", str(process_id), "/T", "/F"],
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
        timeout=10,
    )
    PID_FILE.unlink(missing_ok=True)
    if result.returncode != 0:
        print("Windows could not stop the verified Django process tree.")
        return 1
    print("Django stopped. The local SQLite database file was left intact.")
    return 0


def main() -> int:
    """Dispatch the requested runtime operation."""
    if len(sys.argv) != 2 or sys.argv[1] not in {"start", "stop"}:
        print("Usage: python scripts/runtime.py start|stop")
        return 2
    try:
        return start() if sys.argv[1] == "start" else stop()
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as exc:
        print(f"Runtime operation failed: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
