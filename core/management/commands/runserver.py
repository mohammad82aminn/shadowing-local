"""Local runserver command that tolerates an unavailable database."""

from django.db import OperationalError, connections
from whitenoise.runserver_nostatic.management.commands.runserver import (
    Command as WhiteNoiseRunserverCommand,
)


class Command(WhiteNoiseRunserverCommand):
    """Keep local practice available if the local database cannot be checked."""

    def check_migrations(self):
        """Report database check failures without applying migrations."""
        try:
            connections["default"].ensure_connection()
            return super().check_migrations()
        except OperationalError as error:
            self.stderr.write(
                self.style.WARNING(
                    "Could not check database migrations; starting in degraded "
                    f"mode without applying migrations ({error.__class__.__name__})."
                )
            )
