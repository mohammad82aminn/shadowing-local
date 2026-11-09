"""Add Workspace writer leases and monotonically increasing fencing tokens."""

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0004_vocabulary_sync"),
    ]

    operations = [
        migrations.CreateModel(
            name="WorkspaceLease",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                ("holder_id", models.UUIDField(blank=True, null=True)),
                ("fencing_token", models.PositiveBigIntegerField(default=0)),
                ("expires_at", models.DateTimeField()),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "workspace",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="lease",
                        to="core.workspace",
                    ),
                ),
            ],
            options={
                "constraints": [
                    models.CheckConstraint(
                        condition=models.Q(("fencing_token__gte", 0)),
                        name="core_lease_token_nonnegative",
                    ),
                ],
            },
        ),
    ]
