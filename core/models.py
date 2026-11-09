"""Database models for locally managed workspaces."""

import uuid

from django.db import models


class Workspace(models.Model):
    """A personal working environment shared by the browser and local server."""

    class Status(models.TextChoices):
        ACTIVE = "active", "Active"
        ARCHIVED = "archived", "Archived"

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name = models.CharField(max_length=120)
    status = models.CharField(
        max_length=16,
        choices=Status.choices,
        default=Status.ACTIVE,
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("name", "id")
        constraints = [
            models.CheckConstraint(
                condition=models.Q(status__in=("active", "archived")),
                name="core_workspace_valid_status",
            ),
            models.CheckConstraint(
                condition=~models.Q(name=""),
                name="core_workspace_name_not_empty",
            ),
        ]

    def __str__(self) -> str:
        return self.name


class WorkspaceLease(models.Model):
    """Current cross-browser vocabulary writer and its fencing generation."""

    workspace = models.OneToOneField(
        Workspace,
        on_delete=models.CASCADE,
        related_name="lease",
    )
    holder_id = models.UUIDField(null=True, blank=True)
    fencing_token = models.PositiveBigIntegerField(default=0)
    expires_at = models.DateTimeField()
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=models.Q(fencing_token__gte=0),
                name="core_lease_token_nonnegative",
            ),
        ]


class VocabularyEntry(models.Model):
    """A Workspace-owned word or phrase in the local vocabulary notebook."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace = models.ForeignKey(
        Workspace,
        on_delete=models.CASCADE,
        related_name="vocabulary_entries",
    )
    form = models.CharField(max_length=255)
    normalized_form = models.CharField(max_length=255, editable=False)
    lemma_entry = models.ForeignKey(
        "self",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="observed_forms",
    )
    version = models.PositiveIntegerField(default=1)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("normalized_form", "id")
        constraints = [
            models.UniqueConstraint(
                fields=("workspace", "normalized_form"),
                name="core_vocab_workspace_form_unique",
            ),
            models.CheckConstraint(
                condition=~models.Q(form=""),
                name="core_vocab_form_not_empty",
            ),
        ]

    def save(self, *args, **kwargs):
        from .vocabulary import normalize_vocabulary_form

        self.form = " ".join(self.form.split())
        self.normalized_form = normalize_vocabulary_form(self.form)
        super().save(*args, **kwargs)

    def clean(self):
        from django.core.exceptions import ValidationError

        super().clean()
        if self.lemma_entry_id and self.workspace_id != self.lemma_entry.workspace_id:
            raise ValidationError({"lemma_entry": "lemma_must_belong_to_same_workspace"})

    def __str__(self) -> str:
        return self.form


class ProcessedSyncOperation(models.Model):
    """Idempotency receipt for one Workspace-scoped vocabulary operation."""

    operation_id = models.UUIDField(primary_key=True, editable=False)
    workspace = models.ForeignKey(
        Workspace,
        on_delete=models.CASCADE,
        related_name="processed_sync_operations",
    )
    request_hash = models.CharField(max_length=64)
    result = models.JSONField()
    processed_at = models.DateTimeField(auto_now_add=True)


class VocabularyMeaning(models.Model):
    """A manually entered Persian meaning belonging to one vocabulary entry."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    entry = models.ForeignKey(
        VocabularyEntry,
        on_delete=models.CASCADE,
        related_name="meanings",
    )
    text = models.CharField(max_length=500)
    position = models.PositiveSmallIntegerField(default=0)

    class Meta:
        ordering = ("position", "id")
        constraints = [
            models.UniqueConstraint(
                fields=("entry", "position"),
                name="core_vocab_meaning_position_unique",
            ),
            models.CheckConstraint(
                condition=~models.Q(text=""),
                name="core_vocab_meaning_not_empty",
            ),
        ]
