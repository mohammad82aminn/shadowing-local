"""Workspace-scoped, version-checked vocabulary synchronization."""

import hashlib
import json
from uuid import UUID

from django.db import IntegrityError, transaction

from .models import ProcessedSyncOperation, VocabularyEntry, VocabularyMeaning
from .vocabulary import normalize_meanings, normalize_vocabulary_form
from .workspace_leases import lease_is_current


MAX_BATCH_SIZE = 50


class InvalidOperation(ValueError):
    """A sync operation has an invalid or unexpected shape."""


class LeaseRequired(ValueError):
    """Raised when an operation has no current Workspace fencing token."""


def _canonical_hash(operation):
    encoded = json.dumps(operation, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _uuid(value, code):
    try:
        return UUID(str(value))
    except (ValueError, TypeError, AttributeError) as error:
        raise InvalidOperation(code) from error


def _validate(operation, workspace_id):
    if not isinstance(operation, dict) or set(operation) != {
        "operationId", "workspaceId", "type", "entryId", "baseVersion", "payload"
    }:
        raise InvalidOperation("invalid_operation_shape")
    operation_id = _uuid(operation["operationId"], "invalid_operation_id")
    if _uuid(operation["workspaceId"], "invalid_workspace_id") != workspace_id:
        raise InvalidOperation("workspace_mismatch")
    entry_id = _uuid(operation["entryId"], "invalid_entry_id")
    kind = operation["type"]
    base_version = operation["baseVersion"]
    if not isinstance(base_version, int) or isinstance(base_version, bool) or base_version < 0:
        raise InvalidOperation("invalid_base_version")
    payload = operation["payload"]
    if kind == "entry.save":
        if not isinstance(payload, dict) or set(payload) != {"form", "meanings", "lemmaEntryId"}:
            raise InvalidOperation("invalid_entry_payload")
        form = payload["form"]
        if not isinstance(form, str):
            raise InvalidOperation("invalid_vocabulary_form")
        form = " ".join(form.split())
        if not form or len(form) > 255 or any(ord(char) < 32 for char in form):
            raise InvalidOperation("invalid_vocabulary_form")
        raw_meanings = payload["meanings"]
        if not isinstance(raw_meanings, list) or len(raw_meanings) > 100:
            raise InvalidOperation("invalid_meanings")
        meanings = []
        ids = set()
        for item in raw_meanings:
            if not isinstance(item, dict) or set(item) != {"id", "text"}:
                raise InvalidOperation("invalid_meanings")
            meaning_id = _uuid(item["id"], "invalid_meanings")
            if meaning_id in ids:
                raise InvalidOperation("invalid_meanings")
            ids.add(meaning_id)
            meanings.append({"id": meaning_id, "text": item["text"]})
        try:
            texts = normalize_meanings([item["text"] for item in meanings])
        except ValueError as error:
            raise InvalidOperation(str(error)) from error
        for item, text in zip(meanings, texts):
            item["text"] = text
        lemma_id = payload["lemmaEntryId"]
        lemma_id = _uuid(lemma_id, "invalid_lemma_entry_id") if lemma_id else None
        if lemma_id == entry_id:
            raise InvalidOperation("self_lemma_not_allowed")
        payload = {"form": form, "meanings": meanings, "lemmaEntryId": lemma_id}
    elif kind == "entry.delete":
        if payload is not None:
            raise InvalidOperation("invalid_delete_payload")
    else:
        raise InvalidOperation("unsupported_operation")
    return operation_id, entry_id, kind, base_version, payload


def _entry_payload(entry):
    return {
        "id": str(entry.id),
        "workspaceId": str(entry.workspace_id),
        "form": entry.form,
        "lemmaEntryId": str(entry.lemma_entry_id) if entry.lemma_entry_id else None,
        "lemmaForm": entry.lemma_entry.form if entry.lemma_entry_id else None,
        "meanings": [
            {"id": str(item.id), "text": item.text}
            for item in entry.meanings.all()
        ],
        "version": entry.version,
        "createdAt": entry.created_at.isoformat(),
        "updatedAt": entry.updated_at.isoformat(),
    }


def _conflict(entry, code="version_conflict"):
    if entry:
        entry = VocabularyEntry.objects.select_related("lemma_entry").prefetch_related("meanings").get(pk=entry.pk)
    return {"status": "conflict", "error": code, "serverEntry": _entry_payload(entry) if entry else None}


def apply_operation(operation, workspace, holder_id, fencing_token):
    """Apply one operation atomically or return its preserved conflict state."""
    operation_id, entry_id, kind, base_version, payload = _validate(operation, workspace.id)
    request_hash = _canonical_hash(operation)
    with transaction.atomic():
        if not lease_is_current(workspace.id, holder_id, fencing_token):
            raise LeaseRequired("lease_lost")
        receipt = ProcessedSyncOperation.objects.filter(pk=operation_id).first()
        if receipt:
            if receipt.workspace_id == workspace.id and receipt.request_hash == request_hash:
                return {"status": "applied", "result": receipt.result, "replayed": True}
            return {"status": "conflict", "error": "operation_id_reused", "serverEntry": None}

        entry = VocabularyEntry.objects.select_for_update().filter(
            workspace=workspace, pk=entry_id
        ).first()
        if kind == "entry.save":
            if (base_version == 0 and entry) or (base_version > 0 and (not entry or entry.version != base_version)):
                return _conflict(entry)
            duplicate = VocabularyEntry.objects.filter(
                workspace=workspace,
                normalized_form=normalize_vocabulary_form(payload["form"]),
            ).exclude(pk=entry_id).first()
            if duplicate:
                return _conflict(duplicate, "duplicate_vocabulary_entry")
            lemma = None
            if payload["lemmaEntryId"]:
                lemma = VocabularyEntry.objects.filter(
                    workspace=workspace, pk=payload["lemmaEntryId"]
                ).first()
                if not lemma:
                    return _conflict(entry, "lemma_entry_unavailable")
            elif base_version and entry:
                lemma = None
            try:
                with transaction.atomic():
                    if entry is None:
                        entry = VocabularyEntry(
                            id=entry_id,
                            workspace=workspace,
                            form=payload["form"],
                            lemma_entry=lemma,
                            version=1,
                        )
                    else:
                        entry.form = payload["form"]
                        entry.lemma_entry = lemma
                        entry.version += 1
                    entry.save()
                    VocabularyMeaning.objects.filter(entry=entry).delete()
                    VocabularyMeaning.objects.bulk_create([
                        VocabularyMeaning(id=item["id"], entry=entry, text=item["text"], position=index)
                        for index, item in enumerate(payload["meanings"])
                    ])
                    entry = VocabularyEntry.objects.select_related("lemma_entry").prefetch_related("meanings").get(pk=entry.pk)
                    result = {"entry": _entry_payload(entry)}
            except IntegrityError:
                duplicate = VocabularyEntry.objects.filter(
                    workspace=workspace,
                    normalized_form=normalize_vocabulary_form(payload["form"]),
                ).exclude(pk=entry_id).first()
                return _conflict(duplicate or (entry if base_version > 0 else None), "duplicate_or_meaning_conflict")
        else:
            if not entry or base_version == 0 or entry.version != base_version:
                return _conflict(entry)
            if entry.observed_forms.exists():
                return _conflict(entry, "lemma_in_use")
            deleted_version = entry.version + 1
            entry.delete()
            result = {"deleted": True, "entryId": str(entry_id), "version": deleted_version}

        ProcessedSyncOperation.objects.create(
            operation_id=operation_id,
            workspace=workspace,
            request_hash=request_hash,
            result=result,
        )
        return {"status": "applied", "result": result, "replayed": False}
