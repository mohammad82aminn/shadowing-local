"""Add same-Workspace-capable self references for vocabulary lemmas."""

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0002_vocabularyentry_vocabularymeaning_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="vocabularyentry",
            name="lemma_entry",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="observed_forms",
                to="core.vocabularyentry",
            ),
        ),
    ]
