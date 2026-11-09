# Shadowing

Shadowing is a local English listening and typing practice application. It is built with Django, SQLite, Django Templates, Bootstrap, JavaScript, and IndexedDB.

## Initial setup

1. Install Python 3.14.
2. Run `setup.bat`. It creates the project virtual environment, installs the pinned Python dependencies, downloads the pinned Bootstrap release, and copies its assets into the local static directory.
3. Run `start.bat` to start Django. The application database is the local `shadowing.sqlite3` file.
4. Open the local URL printed by `start.bat` (default `http://127.0.0.1:8000/`).

For a manual foreground launch, use `python manage.py runserver 127.0.0.1:8000`. Django loads the ignored project `.env` automatically; do not paste the secret key into a command. If the configured port is already in use, open the running server URL instead of launching a second server.

The first startup creates a local `.env` file with a random secret key. That file is excluded from Git. SQLite is stored in `shadowing.sqlite3` in the project directory; set `DJANGO_DB_PATH` in `.env` only if you want to store it at another local path. Django binds to `127.0.0.1:8000` by default; set `DJANGO_PORT` in `.env` if that port is reserved on the computer. Startup checks migration status but never applies migrations.

To install requirements manually in this Windows environment, use:

```bat
py -3.14 -m venv --clear --without-pip .venv
py -3.14 -m pip --python .venv install -r requirements.txt
```

The global Python installation is not modified.

## Stop

- `stop.bat` stops only the Django process started by this project.
- `stop-all.bat` stops Django. The SQLite database file remains intact.

## Health check

`/health/` returns the application and SQLite status as JSON. If the database file cannot be opened, Django reports degraded status and remains available on localhost.

## Workspace foundation

The home page creates, selects, archives, and restores Workspaces. Each Workspace uses the same UUID in Django and the browser. SQLite holds the canonical Workspace name and active/archived state. The browser stores Workspace metadata and the current selection in the versioned `shadowing-local` IndexedDB database.

IndexedDB version 1 contains three object stores:

- `workspaces`: local Workspace metadata, keyed by UUID.
- `settings`: browser-local settings, including the selected Workspace and per-Workspace defaults.
- `pendingOperations`: Workspace registration requests to retry when SQLite becomes available.

Workspace creation is saved locally before the Django registration request. If the request fails, the local Workspace and its pending registration remain in IndexedDB. Archive and restore require the SQLite record to be available. Clearing this site's browser data can remove local Workspace metadata and pending registrations.

Phase two adds `core/migrations/0001_initial.py`, which creates the Workspace table. It has been applied to the local SQLite database. The project startup scripts do not apply future migrations automatically; review and approve them before applying.
