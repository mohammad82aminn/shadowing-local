"""Application shell, health checks, and Workspace endpoints."""

import json
from json import JSONDecodeError
from uuid import UUID

from django.db import DatabaseError, IntegrityError, connections, transaction
from django.http import JsonResponse
from django.shortcuts import render
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.decorators.http import require_http_methods

from .models import VocabularyEntry, VocabularyMeaning, Workspace
from .lemmatization import suggest_lemmas, validate_selected_form
from .synchronization import InvalidOperation, LeaseRequired, MAX_BATCH_SIZE, _entry_payload, apply_operation
from .vocabulary import normalize_meanings, normalize_vocabulary_form
from .workspace_leases import (
    LeaseUnavailable,
    acquire_lease,
    heartbeat_lease,
    lease_payload,
    lease_is_current,
    release_lease,
)


def _database_status() -> tuple[bool, str]:
    """Return database availability without changing database state."""
    try:
        with connections["default"].cursor() as cursor:
            cursor.execute("SELECT 1")
            cursor.fetchone()
    except Exception:
        return False, "unavailable"
    return True, "available"


@ensure_csrf_cookie
def home(request):
    """Display the local application shell and current storage status."""
    database_ready, database_status = _database_status()
    return render(
        request,
        "core/home.html",
        {
            "database_ready": database_ready,
            "database_status": database_status,
        },
    )


def health(request):
    """Report application availability and local database connectivity."""
    database_ready, database_status = _database_status()
    status = "ok" if database_ready else "degraded"
    return JsonResponse(
        {"status": status, "database": database_status},
        status=200 if database_ready else 503,
    )


def _workspace_payload(workspace: Workspace) -> dict[str, str]:
    """Serialize public Workspace metadata for local browser storage."""
    return {
        "id": str(workspace.id),
        "name": workspace.name,
        "status": workspace.status,
        "createdAt": workspace.created_at.isoformat(),
        "updatedAt": workspace.updated_at.isoformat(),
    }


def _parse_json_body(request) -> tuple[dict | None, JsonResponse | None]:
    """Parse an API JSON object and return a safe client error when invalid."""
    if request.content_type != "application/json":
        return None, JsonResponse(
            {"error": "content_type_must_be_application_json"}, status=415
        )
    try:
        payload = json.loads(request.body)
    except (JSONDecodeError, UnicodeDecodeError):
        return None, JsonResponse({"error": "invalid_json"}, status=400)
    if not isinstance(payload, dict):
        return None, JsonResponse({"error": "json_object_required"}, status=400)
    return payload, None


def _database_unavailable() -> JsonResponse:
    """Explain that server Workspace features need a usable migrated database."""
    return JsonResponse(
        {"error": "workspace_database_unavailable"},
        status=503,
    )


def _lease_credentials(request):
    """Read the holder UUID and fencing token from request headers."""
    try:
        holder_id = UUID(request.headers.get("X-Workspace-Lease", ""))
        token_text = request.headers.get("X-Fencing-Token", "")
        if not token_text.isascii() or not token_text.isdecimal():
            raise ValueError
        fencing_token = int(token_text)
        if fencing_token < 1:
            raise ValueError
    except (ValueError, TypeError, AttributeError):
        return None, None, JsonResponse({"error": "lease_required"}, status=409)
    return holder_id, fencing_token, None


def _lease_conflict():
    return JsonResponse({"error": "lease_lost"}, status=409)


@require_http_methods(["POST"])
def workspace_lease_acquire(request, workspace_id: UUID):
    workspace, error = _vocabulary_workspace(workspace_id)
    if error:
        return error
    payload, error = _parse_json_body(request)
    if error:
        return error
    if set(payload) != {"holderId"}:
        return JsonResponse({"error": "holder_id_required"}, status=400)
    try:
        holder_id = UUID(str(payload["holderId"]))
        lease = acquire_lease(workspace, holder_id)
    except (ValueError, TypeError, AttributeError):
        return JsonResponse({"error": "invalid_holder_id"}, status=400)
    except LeaseUnavailable:
        return _lease_conflict()
    except DatabaseError:
        return _database_unavailable()
    return JsonResponse(lease_payload(lease))


@require_http_methods(["POST"])
def workspace_lease_heartbeat(request, workspace_id: UUID):
    workspace, error = _vocabulary_workspace(workspace_id)
    if error:
        return error
    holder_id, fencing_token, error = _lease_credentials(request)
    if error:
        return error
    try:
        lease = heartbeat_lease(workspace.id, holder_id, fencing_token)
    except DatabaseError:
        return _database_unavailable()
    return JsonResponse(lease_payload(lease)) if lease else _lease_conflict()


@require_http_methods(["POST"])
def workspace_lease_release(request, workspace_id: UUID):
    holder_id, fencing_token, error = _lease_credentials(request)
    if error:
        return error
    try:
        released = release_lease(workspace_id, holder_id, fencing_token)
    except DatabaseError:
        return _database_unavailable()
    return JsonResponse({"released": released}) if released else _lease_conflict()


@require_http_methods(["GET", "POST"])
def workspace_collection(request):
    """List server Workspaces or idempotently register a local Workspace."""
    if request.method == "GET":
        try:
            workspaces = list(Workspace.objects.all())
        except DatabaseError:
            return _database_unavailable()
        return JsonResponse(
            {"workspaces": [_workspace_payload(item) for item in workspaces]}
        )

    payload, error = _parse_json_body(request)
    if error:
        return error
    if set(payload) != {"id", "name"}:
        return JsonResponse(
            {"error": "id_and_name_are_required"},
            status=400,
        )
    try:
        workspace_id = UUID(str(payload["id"]))
    except (ValueError, TypeError, AttributeError):
        return JsonResponse({"error": "invalid_workspace_id"}, status=400)

    if not isinstance(payload["name"], str):
        return JsonResponse({"error": "invalid_workspace_name"}, status=400)
    name = payload["name"].strip()
    if not name or len(name) > 120 or any(ord(char) < 32 for char in name):
        return JsonResponse({"error": "invalid_workspace_name"}, status=400)

    try:
        workspace, created = Workspace.objects.get_or_create(
            id=workspace_id,
            defaults={"name": name},
        )
    except DatabaseError:
        return _database_unavailable()
    if not created and workspace.name != name:
        return JsonResponse({"error": "workspace_id_conflict"}, status=409)

    return JsonResponse(
        {"workspace": _workspace_payload(workspace)},
        status=201 if created else 200,
    )


@require_http_methods(["PATCH"])
def workspace_detail(request, workspace_id: UUID):
    """Archive or restore one Workspace while SQLite is available."""
    payload, error = _parse_json_body(request)
    if error:
        return error
    if set(payload) != {"status"} or payload["status"] not in Workspace.Status.values:
        return JsonResponse({"error": "invalid_workspace_status"}, status=400)

    try:
        workspace = Workspace.objects.get(id=workspace_id)
        workspace.status = payload["status"]
        workspace.save(update_fields=("status", "updated_at"))
    except Workspace.DoesNotExist:
        return JsonResponse({"error": "workspace_not_found"}, status=404)
    except DatabaseError:
        return _database_unavailable()
    return JsonResponse({"workspace": _workspace_payload(workspace)})


def _vocabulary_payload(entry: VocabularyEntry) -> dict:
    return {
        "id": str(entry.id),
        "workspaceId": str(entry.workspace_id),
        "form": entry.form,
        "lemmaEntryId": str(entry.lemma_entry_id) if entry.lemma_entry_id else None,
        "lemmaForm": entry.lemma_entry.form if entry.lemma_entry_id else None,
        "version": entry.version,
        "meanings": [
            {"id": str(meaning.id), "text": meaning.text}
            for meaning in entry.meanings.all()
        ],
        "createdAt": entry.created_at.isoformat(),
        "updatedAt": entry.updated_at.isoformat(),
    }


@require_http_methods(["POST"])
def vocabulary_lemma_suggestions(request, workspace_id: UUID):
    """Suggest offline lemmas for exactly one selected word or phrase."""
    workspace, error = _vocabulary_workspace(workspace_id)
    if error:
        return error
    payload, error = _parse_json_body(request)
    if error:
        return error
    if set(payload) != {"form"}:
        return JsonResponse({"error": "selected_form_only"}, status=400)
    try:
        form = validate_selected_form(payload["form"])
        suggestions = suggest_lemmas(form)
    except ValueError as validation_error:
        return JsonResponse({"error": str(validation_error)}, status=400)
    return JsonResponse({"suggestions": suggestions})


@require_http_methods(["POST"])
def vocabulary_lemma_confirm(request, workspace_id: UUID):
    """Create or update two independent entries and their Workspace-local relation."""
    workspace, error = _vocabulary_workspace(workspace_id)
    if error:
        return error
    payload, error = _parse_json_body(request)
    if error:
        return error
    if set(payload) != {"form", "lemma"}:
        return JsonResponse({"error": "observed_form_and_lemma_required"}, status=400)
    try:
        observed_form = validate_selected_form(payload["form"])
        lemma_form = validate_selected_form(payload["lemma"])
    except ValueError as validation_error:
        return JsonResponse({"error": str(validation_error)}, status=400)

    observed_key = normalize_vocabulary_form(observed_form)
    lemma_key = normalize_vocabulary_form(lemma_form)
    holder_id, fencing_token, error = _lease_credentials(request)
    if error:
        return error
    try:
        with transaction.atomic():
            if not lease_is_current(workspace.id, holder_id, fencing_token):
                return _lease_conflict()
            observed, _ = VocabularyEntry.objects.get_or_create(
                workspace=workspace,
                normalized_form=observed_key,
                defaults={"form": observed_form},
            )
            if observed_key == lemma_key:
                observed.lemma_entry = None
            else:
                lemma, _ = VocabularyEntry.objects.get_or_create(
                    workspace=workspace,
                    normalized_form=lemma_key,
                    defaults={"form": lemma_form},
                )
                if lemma.workspace_id != observed.workspace_id:
                    return JsonResponse({"error": "lemma_workspace_mismatch"}, status=400)
                observed.lemma_entry = lemma
            observed.save(update_fields=("lemma_entry", "updated_at"))
            observed.version += 1
            observed.save(update_fields=("version",))
            observed = VocabularyEntry.objects.select_related("lemma_entry").get(id=observed.id)
    except IntegrityError:
        return JsonResponse({"error": "lemma_entry_conflict"}, status=409)
    except DatabaseError:
        return _database_unavailable()
    return JsonResponse(
        {"observed": _vocabulary_payload(observed)},
        status=201,
    )


def _vocabulary_workspace(workspace_id: UUID):
    try:
        workspace = Workspace.objects.get(id=workspace_id)
    except Workspace.DoesNotExist:
        return None, JsonResponse({"error": "workspace_not_found"}, status=404)
    except DatabaseError:
        return None, _database_unavailable()
    if workspace.status != Workspace.Status.ACTIVE:
        return None, JsonResponse({"error": "workspace_not_active"}, status=409)
    return workspace, None


def _validated_vocabulary_form(value):
    if not isinstance(value, str):
        raise ValueError("invalid_vocabulary_form")
    form = " ".join(value.split())
    if not form or len(form) > 255 or any(ord(char) < 32 for char in form):
        raise ValueError("invalid_vocabulary_form")
    return form


def _replace_meanings(entry, values):
    meanings = list(entry.meanings.all())
    for position, text in enumerate(values):
        if position < len(meanings):
            meaning = meanings[position]
            if meaning.text != text or meaning.position != position:
                meaning.text = text
                meaning.position = position
                meaning.save(update_fields=("text", "position"))
        else:
            VocabularyMeaning.objects.create(
                entry=entry,
                text=text,
                position=position,
            )
    if len(meanings) > len(values):
        VocabularyMeaning.objects.filter(
            id__in=[item.id for item in meanings[len(values):]]
        ).delete()


@require_http_methods(["GET", "POST"])
def vocabulary_collection(request, workspace_id: UUID):
    """Search a Workspace notebook or add one exact word/phrase."""
    workspace, error = _vocabulary_workspace(workspace_id)
    if error:
        return error
    if request.method == "GET":
        query = request.GET.get("q", "").strip()
        try:
            entries = VocabularyEntry.objects.filter(workspace=workspace).prefetch_related(
                "meanings"
            )
            if query:
                entries = entries.filter(form__icontains=query)
            return JsonResponse({"entries": [_vocabulary_payload(item) for item in entries]})
        except DatabaseError:
            return _database_unavailable()

    payload, error = _parse_json_body(request)
    if error:
        return error
    if set(payload) != {"form", "meanings"}:
        return JsonResponse({"error": "form_and_meanings_are_required"}, status=400)
    try:
        form = _validated_vocabulary_form(payload["form"])
        meanings = normalize_meanings(payload["meanings"])
    except ValueError as validation_error:
        return JsonResponse({"error": str(validation_error)}, status=400)
    normalized = normalize_vocabulary_form(form)
    holder_id, fencing_token, error = _lease_credentials(request)
    if error:
        return error
    try:
        with transaction.atomic():
            if not lease_is_current(workspace.id, holder_id, fencing_token):
                return _lease_conflict()
            entry = VocabularyEntry.objects.create(
                workspace=workspace,
                form=form,
                normalized_form=normalized,
            )
            for position, text in enumerate(meanings):
                VocabularyMeaning.objects.create(
                    entry=entry,
                    text=text,
                    position=position,
                )
    except IntegrityError:
        existing = VocabularyEntry.objects.filter(
            workspace=workspace,
            normalized_form=normalized,
        ).prefetch_related("meanings").first()
        if existing:
            return JsonResponse(
                {"error": "duplicate_vocabulary_entry", "entry": _vocabulary_payload(existing)},
                status=409,
            )
        return JsonResponse({"error": "vocabulary_entry_conflict"}, status=409)
    return JsonResponse({"entry": _vocabulary_payload(entry)}, status=201)


@require_http_methods(["PATCH", "DELETE"])
def vocabulary_detail(request, workspace_id: UUID, entry_id: UUID):
    """Edit or remove one entry without crossing Workspace boundaries."""
    workspace, error = _vocabulary_workspace(workspace_id)
    if error:
        return error
    try:
        entry = VocabularyEntry.objects.prefetch_related("meanings").get(
            workspace=workspace,
            id=entry_id,
        )
    except VocabularyEntry.DoesNotExist:
        return JsonResponse({"error": "vocabulary_entry_not_found"}, status=404)
    except DatabaseError:
        return _database_unavailable()

    holder_id, fencing_token, error = _lease_credentials(request)
    if error:
        return error

    if request.method == "DELETE":
        with transaction.atomic():
            if not lease_is_current(workspace.id, holder_id, fencing_token):
                return _lease_conflict()
            entry.delete()
        return JsonResponse({"deleted": True})

    payload, error = _parse_json_body(request)
    if error:
        return error
    if set(payload) != {"form", "meanings"}:
        return JsonResponse({"error": "form_and_meanings_are_required"}, status=400)
    try:
        form = _validated_vocabulary_form(payload["form"])
        meanings = normalize_meanings(payload["meanings"])
    except ValueError as validation_error:
        return JsonResponse({"error": str(validation_error)}, status=400)
    entry.form = form
    entry.normalized_form = normalize_vocabulary_form(form)
    entry.version += 1
    try:
        with transaction.atomic():
            if not lease_is_current(workspace.id, holder_id, fencing_token):
                return _lease_conflict()
            entry.save(update_fields=("form", "normalized_form", "version", "updated_at"))
            _replace_meanings(entry, meanings)
    except IntegrityError:
        existing = VocabularyEntry.objects.filter(
            workspace=workspace,
            normalized_form=entry.normalized_form,
        ).exclude(id=entry.id).prefetch_related("meanings").first()
        if existing:
            return JsonResponse(
                {"error": "duplicate_vocabulary_entry", "entry": _vocabulary_payload(existing)},
                status=409,
            )
        return JsonResponse({"error": "vocabulary_entry_conflict"}, status=409)
    entry = VocabularyEntry.objects.prefetch_related("meanings").get(id=entry.id)
    return JsonResponse({"entry": _vocabulary_payload(entry)})


@require_http_methods(["GET", "POST"])
def vocabulary_sync(request, workspace_id: UUID):
    """Pull one Workspace cache snapshot or apply an idempotent operation batch."""
    workspace, error = _vocabulary_workspace(workspace_id)
    if error:
        return error
    if request.method == "GET":
        try:
            entries = VocabularyEntry.objects.filter(workspace=workspace).select_related(
                "lemma_entry"
            ).prefetch_related("meanings")
            return JsonResponse({"entries": [_entry_payload(item) for item in entries]})
        except DatabaseError:
            return _database_unavailable()

    payload, error = _parse_json_body(request)
    if error:
        return error
    if set(payload) != {"operations"} or not isinstance(payload["operations"], list):
        return JsonResponse({"error": "operations_list_required"}, status=400)
    operations = payload["operations"]
    if not 1 <= len(operations) <= MAX_BATCH_SIZE:
        return JsonResponse({"error": "invalid_batch_size", "maximum": MAX_BATCH_SIZE}, status=400)

    holder_id, fencing_token, error = _lease_credentials(request)
    if error:
        return error

    results = []
    for operation in operations:
        try:
            operation_id = operation.get("operationId") if isinstance(operation, dict) else None
            result = apply_operation(operation, workspace, holder_id, fencing_token)
            results.append({"operationId": operation_id, **result})
        except LeaseRequired:
            return _lease_conflict()
        except InvalidOperation as validation_error:
            results.append({
                "operationId": operation.get("operationId") if isinstance(operation, dict) else None,
                "status": "rejected",
                "error": str(validation_error),
            })
        except DatabaseError:
            return _database_unavailable()
    return JsonResponse({"results": results})
