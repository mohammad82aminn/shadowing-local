"""Add vocabulary versions and idempotency receipts for synchronization."""

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0003_vocabularyentry_lemma_entry"),
    ]

    operations = [
        migrations.AddField(
            model_name="vocabularyentry",
            name="version",
            field=models.PositiveIntegerField(default=1),
        ),
        migrations.CreateModel(
            name="ProcessedSyncOperation",
            fields=[
                (
                    "operation_id",
                    models.UUIDField(editable=False, primary_key=True, serialize=False),
                ),
                ("request_hash", models.CharField(max_length=64)),
                ("result", models.JSONField()),
                ("processed_at", models.DateTimeField(auto_now_add=True)),
                (
                    "workspace",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="processed_sync_operations",
                        to="core.workspace",
                    ),
                ),
            ],
        ),
    ]
