# Shadowing

Shadowing is a local English listening and typing practice app. It uses Django, SQLite, Django Templates, Bootstrap, vanilla JavaScript, and IndexedDB.

## Features

- Play local MP4/WebM videos and import SRT/VTT subtitles in the browser.
- Practice subtitle cues, track progress, and select vocabulary words or phrases.
- Keep practice projects, subtitles, cues, and progress in browser IndexedDB.
- Keep canonical workspaces and vocabulary in local SQLite; queue vocabulary changes while offline.
- Suggest English lemmas locally without an online translation or AI service.
- Coordinate vocabulary writers with Workspace leases, 15-second heartbeats, 60-second expiry, Web Locks, and fencing tokens.

Raw exercise answers are not persisted. Video and subtitle files are not uploaded to Django or external services. The app binds its development server to localhost.

## Requirements

- Windows
- Python 3.14
- Node.js for JavaScript tests

## Setup and run

1. Run `setup.bat` once to create `.venv` and install the pinned dependencies.
2. Run `start.bat`. It checks migration status without applying migrations and starts Django on the local address configured by `DJANGO_PORT` (default `8000`).
3. Open the URL printed by the script, usually `http://127.0.0.1:8000/`.

To run Django in the foreground instead, activate `.venv` and run:

```bat
python manage.py runserver 127.0.0.1:8000
```

The Django settings load the project-local `.env` file. Keep `.env` private; do not commit its secret key. If the port is already in use, open the running server URL or stop that server before starting another.

## Database migrations

Migrations are never applied automatically at startup. Review pending migrations before applying them manually. The vocabulary, synchronization, and lease APIs require migrations `0002` through `0005`; without them, those database-backed features remain unavailable. Local browser practice can still run.

The local `shadowing.sqlite3`, `.env`, virtual environments, runtime files, and collected static files are excluded from Git. A fresh checkout creates its local database as needed; user data is not part of the repository.

## Tests

Run JavaScript tests with:

```bat
node --test --test-isolation=none tests/*.test.mjs
```

Run Django tests with an explicitly configured temporary SQLite database and a local test secret:

```bat
set DJANGO_DB_PATH=%TEMP%\shadowing-tests.sqlite3
set DJANGO_SECRET_KEY=local-test-only
python manage.py test
```

Do not point test runs at `shadowing.sqlite3`.

## Stop

- `stop.bat` stops the Django process started by `start.bat`.
- A foreground `runserver` process stops with `Ctrl+C`.

Backup and recovery are not implemented yet.
