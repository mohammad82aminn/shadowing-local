"""Regression and Workspace foundation tests."""

import io
import json
import uuid
from datetime import timedelta
from unittest.mock import patch

from django.conf import settings
from django.core.management import get_commands
from django.core.management.base import BaseCommand
from django.db import IntegrityError, OperationalError, transaction
from django.test import Client, SimpleTestCase, TestCase, override_settings
from django.utils import timezone
from django.urls import Resolver404, resolve

from config import settings as project_settings
from core.management.commands.runserver import Command as LocalRunserverCommand
from core.models import VocabularyEntry, Workspace, WorkspaceLease
from core.vocabulary import normalize_vocabulary_form


class HealthEndpointTests(SimpleTestCase):
    def test_health_endpoint_reports_database_available(self):
        with patch("core.views._database_status", return_value=(True, "available")):
            response = self.client.get("/health/")

        self.assertEqual(response.status_code, 200)
        self.assertJSONEqual(
            response.content,
            {"status": "ok", "database": "available"},
        )

    def test_health_endpoint_reports_degraded_mode(self):
        with patch("core.views._database_status", return_value=(False, "unavailable")):
            response = self.client.get("/health/")

        self.assertEqual(response.status_code, 503)
        self.assertJSONEqual(
            response.content,
            {"status": "degraded", "database": "unavailable"},
        )


class LocalRunserverTests(SimpleTestCase):
    def test_project_runserver_command_takes_precedence(self):
        self.assertEqual(get_commands()["runserver"], "core")

    def test_database_error_does_not_block_local_server_startup(self):
        stderr = io.StringIO()
        command = LocalRunserverCommand(stderr=stderr)
        with patch(
            "core.management.commands.runserver.connections"
        ) as connections:
            connections.__getitem__.return_value.ensure_connection.side_effect = (
                OperationalError("database unavailable")
            )
            command.check_migrations()

        self.assertIn("starting in degraded mode", stderr.getvalue())

    def test_available_database_runs_migration_status_check(self):
        stderr = io.StringIO()
        command = LocalRunserverCommand(stderr=stderr)
        with patch(
            "core.management.commands.runserver.connections"
        ) as connections, patch.object(
            BaseCommand,
            "check_migrations",
        ) as check_migrations:
            connections.__getitem__.return_value.ensure_connection.return_value = None
            command.check_migrations()

        check_migrations.assert_called_once_with()


class SecurityConfigurationTests(SimpleTestCase):
    def test_sqlite_is_the_configured_database(self):
        self.assertEqual(
            project_settings.DATABASES["default"]["ENGINE"],
            "django.db.backends.sqlite3",
        )

    def test_debug_is_disabled_and_hosts_are_local_only(self):
        self.assertFalse(project_settings.DEBUG)
        self.assertEqual(
            project_settings.ALLOWED_HOSTS,
            ["127.0.0.1", "localhost"],
        )

    def test_csrf_is_enabled_and_authentication_routes_are_absent(self):
        self.assertIn("django.middleware.csrf.CsrfViewMiddleware", settings.MIDDLEWARE)
        for path in ("/admin/", "/accounts/login/"):
            with self.assertRaises(Resolver404):
                resolve(path)


class WorkspaceModelTests(TestCase):
    def test_workspace_has_uuid_and_active_default(self):
        workspace = Workspace.objects.create(name="Listening practice")

        self.assertIsInstance(workspace.id, uuid.UUID)
        self.assertEqual(workspace.status, Workspace.Status.ACTIVE)
        self.assertIsNotNone(workspace.created_at)
        self.assertIsNotNone(workspace.updated_at)


class WorkspaceShellTests(SimpleTestCase):
    @override_settings(
        STORAGES={
            **settings.STORAGES,
            "staticfiles": {
                "BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"
            },
        }
    )
    def test_home_page_exposes_workspace_ui_and_csrf_cookie(self):
        response = self.client.get("/")

        self.assertEqual(response.status_code, 200)
        self.assertIn("csrftoken", response.cookies)
        self.assertContains(response, "data-workspace-app")
        self.assertContains(response, "api/workspaces/")
        self.assertContains(response, "js/workspace-manager.js")
        self.assertContains(response, "data-video-player")
        self.assertContains(response, "data-video-file")
        self.assertContains(response, "js/video-player.js")
        self.assertContains(response, "data-subtitle-manager")
        self.assertContains(response, "data-subtitle-file")
        self.assertContains(response, "data-confirm-subtitle")
        self.assertContains(response, "js/cue-manager.js")
        self.assertContains(response, "js/answer-engine.js")
        self.assertContains(response, "data-progress-statistics")
        self.assertContains(response, "تکمیل درست")
        self.assertContains(response, "پوشش")
        self.assertContains(response, "دقت تلاش اول")
        self.assertContains(response, "js/progress-statistics.js")
        self.assertContains(response, "data-vocabulary-notebook")
        self.assertContains(response, "js/vocabulary-notebook.js")


class WorkspaceEndpointTests(TestCase):
    def setUp(self):
        self.workspace_id = uuid.uuid4()
        self.payload = {"id": str(self.workspace_id), "name": "Daily practice"}
        self.url = "/api/workspaces/"

    def test_list_returns_workspaces_with_shared_identifiers(self):
        workspace = Workspace.objects.create(
            id=self.workspace_id,
            name=self.payload["name"],
        )

        response = self.client.get(self.url)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["workspaces"][0]["id"], str(workspace.id))
        self.assertEqual(response.json()["workspaces"][0]["status"], "active")

    def test_registration_creates_workspace_and_retries_idempotently(self):
        first = self.client.post(
            self.url,
            data=json.dumps(self.payload),
            content_type="application/json",
        )
        retry = self.client.post(
            self.url,
            data=json.dumps(self.payload),
            content_type="application/json",
        )

        self.assertEqual(first.status_code, 201)
        self.assertEqual(retry.status_code, 200)
        self.assertEqual(Workspace.objects.count(), 1)

    def test_registration_rejects_invalid_names_and_identifier_conflicts(self):
        invalid = self.client.post(
            self.url,
            data=json.dumps({**self.payload, "name": "   "}),
            content_type="application/json",
        )
        Workspace.objects.create(id=self.workspace_id, name="Another name")
        conflict = self.client.post(
            self.url,
            data=json.dumps(self.payload),
            content_type="application/json",
        )

        self.assertEqual(invalid.status_code, 400)
        self.assertEqual(conflict.status_code, 409)

    def test_workspace_can_be_archived_and_restored(self):
        Workspace.objects.create(id=self.workspace_id, name=self.payload["name"])
        detail_url = f"{self.url}{self.workspace_id}/"

        archived = self.client.patch(
            detail_url,
            data=json.dumps({"status": "archived"}),
            content_type="application/json",
        )
        restored = self.client.patch(
            detail_url,
            data=json.dumps({"status": "active"}),
            content_type="application/json",
        )

        self.assertEqual(archived.status_code, 200)
        self.assertEqual(archived.json()["workspace"]["status"], "archived")
        self.assertEqual(restored.json()["workspace"]["status"], "active")

    def test_status_update_rejects_unknown_workspace_states(self):
        Workspace.objects.create(id=self.workspace_id, name=self.payload["name"])

        response = self.client.patch(
            f"{self.url}{self.workspace_id}/",
            data=json.dumps({"status": "deleted"}),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 400)

    def test_workspace_api_reports_unavailable_database(self):
        with patch(
            "core.views.Workspace.objects.all",
            side_effect=OperationalError("database unavailable"),
        ):
            response = self.client.get(self.url)

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["error"], "workspace_database_unavailable")

    def test_workspace_writes_require_csrf_protection(self):
        client = Client(enforce_csrf_checks=True)

        response = client.post(
            self.url,
            data=json.dumps(self.payload),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 403)


class VocabularyModelTests(TestCase):
    def test_duplicate_key_ignores_case_and_extra_whitespace_but_keeps_apostrophes(self):
        workspace = Workspace.objects.create(name="Vocabulary")
        VocabularyEntry.objects.create(workspace=workspace, form="  DON'T   stop ")

        self.assertEqual(normalize_vocabulary_form("don't stop"), "don't stop")
        self.assertEqual(normalize_vocabulary_form("don t stop"), "don t stop")
        self.assertNotEqual(
            normalize_vocabulary_form("running"),
            normalize_vocabulary_form("run"),
        )
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                VocabularyEntry.objects.create(workspace=workspace, form="don't stop")

    def test_same_form_is_allowed_in_another_workspace(self):
        first = Workspace.objects.create(name="First")
        second = Workspace.objects.create(name="Second")
        VocabularyEntry.objects.create(workspace=first, form="look up")
        VocabularyEntry.objects.create(workspace=second, form="LOOK   UP")
        self.assertEqual(VocabularyEntry.objects.count(), 2)


class VocabularyEndpointTests(TestCase):
    def setUp(self):
        self.workspace = Workspace.objects.create(name="Notebook")
        self.other_workspace = Workspace.objects.create(name="Other notebook")
        self.holder_id = uuid.uuid4()
        WorkspaceLease.objects.create(
            workspace=self.workspace,
            holder_id=self.holder_id,
            fencing_token=1,
            expires_at=timezone.now() + timedelta(seconds=60),
        )
        self.client.defaults["HTTP_X_WORKSPACE_LEASE"] = str(self.holder_id)
        self.client.defaults["HTTP_X_FENCING_TOKEN"] = "1"
        self.url = f"/api/workspaces/{self.workspace.id}/vocabulary/"

    def post_entry(self, form, meanings=None, url=None):
        return self.client.post(
            url or self.url,
            data=json.dumps({"form": form, "meanings": meanings or []}),
            content_type="application/json",
        )

    def test_create_search_and_duplicate_offer_the_existing_entry(self):
        created = self.post_entry("  Look   up ", ["جست‌وجو کردن", "نگاه کردن به"])
        self.assertEqual(created.status_code, 201)
        entry = created.json()["entry"]
        self.assertEqual(entry["form"], "Look up")
        self.assertEqual([meaning["text"] for meaning in entry["meanings"]], ["جست‌وجو کردن", "نگاه کردن به"])

        duplicate = self.post_entry("LOOK up")
        self.assertEqual(duplicate.status_code, 409)
        self.assertEqual(duplicate.json()["entry"]["id"], entry["id"])

        searched = self.client.get(f"{self.url}?q=look")
        self.assertEqual([item["id"] for item in searched.json()["entries"]], [entry["id"]])

    def test_edit_add_and_remove_meanings_and_delete_entry(self):
        entry_id = self.post_entry("take off", ["درآوردن"] ).json()["entry"]["id"]
        detail = f"{self.url}{entry_id}/"
        edited = self.client.patch(
            detail,
            data=json.dumps({"form": "take off", "meanings": ["درآوردن", "بلند شدن"]}),
            content_type="application/json",
        )
        self.assertEqual(edited.status_code, 200)
        self.assertEqual([item["text"] for item in edited.json()["entry"]["meanings"]], ["درآوردن", "بلند شدن"])

        reduced = self.client.patch(
            detail,
            data=json.dumps({"form": "take off", "meanings": ["بلند شدن"]}),
            content_type="application/json",
        )
        self.assertEqual([item["text"] for item in reduced.json()["entry"]["meanings"]], ["بلند شدن"])
        deleted = self.client.delete(detail)
        self.assertEqual(deleted.status_code, 200)
        self.assertFalse(VocabularyEntry.objects.filter(id=entry_id).exists())

    def test_entries_are_workspace_scoped_and_inactive_workspaces_are_read_only(self):
        first_entry = self.post_entry("break down").json()["entry"]
        other_url = f"/api/workspaces/{self.other_workspace.id}/vocabulary/"
        self.assertEqual(self.client.get(other_url).json()["entries"], [])
        cross_workspace_edit = self.client.patch(
            f"{other_url}{first_entry['id']}/",
            data=json.dumps({"form": "break down", "meanings": []}),
            content_type="application/json",
        )
        self.assertEqual(cross_workspace_edit.status_code, 404)
        self.workspace.status = Workspace.Status.ARCHIVED
        self.workspace.save()
        self.assertEqual(self.post_entry("turn on").status_code, 409)

    def test_api_rejects_raw_answer_field_and_invalid_meanings(self):
        response = self.client.post(
            self.url,
            data=json.dumps({"form": "walk away", "meanings": [], "answer": "private raw answer"}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 400)
        invalid_meaning = self.post_entry("walk away", [""])
        self.assertEqual(invalid_meaning.status_code, 400)

    def test_vocabulary_writes_require_csrf_protection(self):
        client = Client(enforce_csrf_checks=True)
        response = client.post(
            self.url,
            data=json.dumps({"form": "give up", "meanings": []}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 403)


class VocabularySyncEndpointTests(TestCase):
    def setUp(self):
        self.workspace = Workspace.objects.create(name="Sync notebook")
        self.other_workspace = Workspace.objects.create(name="Other sync notebook")
        self.holder_id = uuid.uuid4()
        WorkspaceLease.objects.create(
            workspace=self.workspace,
            holder_id=self.holder_id,
            fencing_token=1,
            expires_at=timezone.now() + timedelta(seconds=60),
        )
        self.client.defaults["HTTP_X_WORKSPACE_LEASE"] = str(self.holder_id)
        self.client.defaults["HTTP_X_FENCING_TOKEN"] = "1"
        self.url = f"/api/workspaces/{self.workspace.id}/vocabulary/sync/"

    def operation(self, *, kind="entry.save", entry_id=None, operation_id=None, base_version=0, form="look up", meanings=None, lemma_id=None, workspace_id=None):
        return {
            "operationId": str(operation_id or uuid.uuid4()),
            "workspaceId": str(workspace_id or self.workspace.id),
            "type": kind,
            "entryId": str(entry_id or uuid.uuid4()),
            "baseVersion": base_version,
            "payload": None if kind == "entry.delete" else {
                "form": form,
                "meanings": meanings or [],
                "lemmaEntryId": str(lemma_id) if lemma_id else None,
            },
        }

    def sync(self, operations):
        return self.client.post(self.url, data=json.dumps({"operations": operations}), content_type="application/json")

    def test_batch_creates_entries_meanings_and_lemma_relationship_in_one_workspace(self):
        base_id = uuid.uuid4()
        observed_id = uuid.uuid4()
        meaning_id = uuid.uuid4()
        operations = [
            self.operation(entry_id=base_id, form="run"),
            self.operation(entry_id=observed_id, form="running", lemma_id=base_id,
                           meanings=[{"id": str(meaning_id), "text": "دویدن"}]),
        ]
        response = self.sync(operations)
        self.assertEqual(response.status_code, 200)
        self.assertEqual([item["status"] for item in response.json()["results"]], ["applied", "applied"])
        observed = response.json()["results"][1]["result"]["entry"]
        self.assertEqual(observed["version"], 1)
        self.assertEqual(observed["lemmaEntryId"], str(base_id))
        self.assertEqual(observed["meanings"], [{"id": str(meaning_id), "text": "دویدن"}])
        cross_workspace = self.client.get(f"/api/workspaces/{self.other_workspace.id}/vocabulary/sync/")
        self.assertEqual(cross_workspace.json()["entries"], [])

    def test_replaying_an_operation_is_idempotent_and_uuid_reuse_is_rejected(self):
        operation = self.operation(form="turn on")
        first = self.sync([operation]).json()["results"][0]
        replay = self.sync([operation]).json()["results"][0]
        self.assertFalse(first["replayed"])
        self.assertTrue(replay["replayed"])
        self.assertEqual(VocabularyEntry.objects.filter(workspace=self.workspace).count(), 1)
        changed = {**operation, "payload": {**operation["payload"], "form": "turn off"}}
        reused = self.sync([changed]).json()["results"][0]
        self.assertEqual(reused["error"], "operation_id_reused")
        self.assertEqual(VocabularyEntry.objects.get(workspace=self.workspace).form, "turn on")

    def test_stale_version_returns_server_snapshot_without_overwriting_it(self):
        create = self.operation(form="break down")
        created = self.sync([create]).json()["results"][0]["result"]["entry"]
        update = self.operation(entry_id=created["id"], base_version=1, form="break down", meanings=[])
        self.assertEqual(self.sync([update]).json()["results"][0]["status"], "applied")
        stale = self.operation(entry_id=created["id"], base_version=1, form="break into", meanings=[])
        result = self.sync([stale]).json()["results"][0]
        self.assertEqual(result["status"], "conflict")
        self.assertEqual(result["serverEntry"]["version"], 2)
        self.assertEqual(VocabularyEntry.objects.get(pk=created["id"]).form, "break down")

    def test_cross_workspace_lemma_and_raw_answer_fields_are_rejected(self):
        other_entry = VocabularyEntry.objects.create(workspace=self.other_workspace, form="run")
        operation = self.operation(form="running", lemma_id=other_entry.id)
        result = self.sync([operation]).json()["results"][0]
        self.assertEqual(result["status"], "conflict")
        raw_answer = {**self.operation(), "answer": "must never be accepted"}
        rejected = self.sync([raw_answer]).json()["results"][0]
        self.assertEqual(rejected["status"], "rejected")
        self.assertEqual(rejected["error"], "invalid_operation_shape")

    def test_sync_batch_size_and_active_workspace_rules(self):
        self.assertEqual(self.sync([]).status_code, 400)
        self.workspace.status = Workspace.Status.ARCHIVED
        self.workspace.save()
        self.assertEqual(self.sync([self.operation()]).status_code, 409)

    def test_missing_expired_and_stale_fences_cannot_write(self):
        operation = self.operation(form="stale writer")
        missing = Client().post(
            self.url,
            data=json.dumps({"operations": [operation]}),
            content_type="application/json",
        )
        self.assertEqual(missing.status_code, 409)
        self.assertEqual(missing.json()["error"], "lease_required")

        self.workspace.lease.expires_at = timezone.now() - timedelta(seconds=1)
        self.workspace.lease.save(update_fields=("expires_at",))
        expired = self.sync([operation])
        self.assertEqual(expired.status_code, 409)
        self.assertFalse(VocabularyEntry.objects.filter(form="stale writer").exists())

    def test_old_holder_cannot_overwrite_after_a_new_claim_increments_fence(self):
        create = self.operation(form="keep current")
        entry = self.sync([create]).json()["results"][0]["result"]["entry"]
        self.workspace.lease.expires_at = timezone.now() - timedelta(seconds=1)
        self.workspace.lease.save(update_fields=("expires_at",))
        new_holder = uuid.uuid4()
        claimed = self.client.post(
            f"/api/workspaces/{self.workspace.id}/lease/",
            data=json.dumps({"holderId": str(new_holder)}),
            content_type="application/json",
        )
        self.assertEqual(claimed.json()["fencingToken"], 2)
        update = self.operation(entry_id=entry["id"], base_version=1, form="stale overwrite")
        response = self.sync([update])
        self.assertEqual(response.status_code, 409)
        entry_record = VocabularyEntry.objects.get(pk=entry["id"])
        self.assertEqual(entry_record.form, "keep current")

    def test_mutating_legacy_vocabulary_route_also_requires_current_fence(self):
        client = Client()
        response = client.post(
            f"/api/workspaces/{self.workspace.id}/vocabulary/",
            data=json.dumps({"form": "unfenced", "meanings": []}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 409)
        self.assertFalse(VocabularyEntry.objects.filter(form="unfenced").exists())


class WorkspaceLeaseEndpointTests(TestCase):
    def setUp(self):
        self.workspace = Workspace.objects.create(name="Lease")
        self.base_url = f"/api/workspaces/{self.workspace.id}/lease/"

    def acquire(self, holder_id):
        return self.client.post(
            self.base_url,
            data=json.dumps({"holderId": str(holder_id)}),
            content_type="application/json",
        )

    def client_for_lease(self, holder_id, token):
        client = Client()
        client.defaults["HTTP_X_WORKSPACE_LEASE"] = str(holder_id)
        client.defaults["HTTP_X_FENCING_TOKEN"] = str(token)
        return client

    def test_new_claim_increments_fence_and_other_holder_waits(self):
        first_holder = uuid.uuid4()
        first = self.acquire(first_holder)
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.json()["fencingToken"], 1)
        self.assertEqual(self.acquire(uuid.uuid4()).status_code, 409)

        self.workspace.lease.expires_at = timezone.now() - timedelta(seconds=1)
        self.workspace.lease.save(update_fields=("expires_at",))
        second_holder = uuid.uuid4()
        second = self.acquire(second_holder)
        self.assertEqual(second.json()["fencingToken"], 2)

    def test_heartbeat_extends_only_current_unexpired_lease(self):
        holder_id = uuid.uuid4()
        lease = self.acquire(holder_id).json()
        client = self.client_for_lease(holder_id, lease["fencingToken"])
        response = client.post(f"{self.base_url}heartbeat/", data="{}", content_type="application/json")
        self.assertEqual(response.status_code, 200)
        self.assertGreater(response.json()["expiresAt"], lease["expiresAt"])

        stale = self.client_for_lease(holder_id, lease["fencingToken"] + 1)
        self.assertEqual(stale.post(f"{self.base_url}heartbeat/", data="{}", content_type="application/json").status_code, 409)

    def test_same_holder_renews_without_changing_fence_and_release_is_fenced(self):
        holder_id = uuid.uuid4()
        first = self.acquire(holder_id).json()
        again = self.acquire(holder_id).json()
        self.assertEqual(again["fencingToken"], first["fencingToken"])
        client = self.client_for_lease(holder_id, first["fencingToken"])
        released = client.post(f"{self.base_url}release/", data="{}", content_type="application/json")
        self.assertTrue(released.json()["released"])
        self.assertEqual(self.acquire(uuid.uuid4()).json()["fencingToken"], 2)

    def test_lease_is_workspace_scoped(self):
        first_holder = uuid.uuid4()
        self.assertEqual(self.acquire(first_holder).status_code, 200)
        other = Workspace.objects.create(name="Other lease")
        response = self.client.post(
            f"/api/workspaces/{other.id}/lease/",
            data=json.dumps({"holderId": str(uuid.uuid4())}),
            content_type="application/json",
        )
        self.assertEqual(response.json()["fencingToken"], 1)
