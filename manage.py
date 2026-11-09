#!/usr/bin/env python
"""Django command-line utility for the Shadowing project."""

import os
import sys


def main() -> None:
    """Run Django management commands."""
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
    try:
        from django.core.management import execute_from_command_line
    except ImportError as exc:
        raise ImportError(
            "Django is unavailable. Activate the project environment and install "
            "requirements.txt."
        ) from exc
    execute_from_command_line(sys.argv)


if __name__ == "__main__":
    main()
