"""Tests for local lemma rules, Workspace isolation, and request privacy."""

import json
import uuid
from datetime import timedelta
from django.test import SimpleTestCase, TestCase
from django.utils import timezone

from core.lemmatization import suggest_lemmas, validate_selected_form
from core.models import VocabularyEntry, Workspace, WorkspaceLease


class OfflineLemmaRuleTests(SimpleTestCase):
    def test_regular_verb_noun_and_adjective_rules(self):
        self.assertIn("run", {item["form"] for item in suggest_lemmas("running")})
        self.assertEqual({item["form"] for item in suggest_lemmas("making")}, {"make"})
        self.assertEqual({item["form"] for item in suggest_lemmas("baked")}, {"bake"})
        self.assertIn("baby", {item["form"] for item in suggest_lemmas("babies")})
        self.assertIn("happy", {item["form"] for item in suggest_lemmas("happier")})
        self.assertIn("walk", {item["form"] for item in suggest_lemmas("walked")})

    def test_irregular_forms_and_ambiguous_saw_are_returned(self):
        self.assertIn("go", {item["form"] for item in suggest_lemmas("went")})
        self.assertIn("child", {item["form"] for item in suggest_lemmas("children")})
        self.assertIn("good", {item["form"] for item in suggest_lemmas("better")})
        self.assertEqual(
            {item["form"] for item in suggest_lemmas("saw")},
            {"see", "saw"},
        )

    def test_phrasal_verbs_are_processed_as_selected_phrases(self):
        self.assertIn("look it up", {item["form"] for item in suggest_lemmas("looking it up")})

    def test_sentence_and_nonlexical_input_are_rejected(self):
        for form in (
            "I am looking for it",
            "They saw it.",
            "Coffee tastes good",
            "look up, please",
            "word\nphrase",
        ):
            with self.subTest(form=form), self.assertRaises(ValueError):
                validate_selected_form(form)


class LemmaEndpointTests(TestCase):
    def setUp(self):
        self.workspace = Workspace.objects.create(name="First")
        self.other_workspace = Workspace.objects.create(name="Second")
        holder_id = uuid.uuid4()
        WorkspaceLease.objects.create(
            workspace=self.workspace,
            holder_id=holder_id,
            fencing_token=1,
            expires_at=timezone.now() + timedelta(seconds=60),
        )
        self.client.defaults["HTTP_X_WORKSPACE_LEASE"] = str(holder_id)
        self.client.defaults["HTTP_X_FENCING_TOKEN"] = "1"
        self.suggest_url = f"/api/workspaces/{self.workspace.id}/vocabulary/lemmatize/"
        self.confirm_url = f"/api/workspaces/{self.workspace.id}/vocabulary/lemma/"

    def post_json(self, url, payload):
        return self.client.post(url, data=json.dumps(payload), content_type="application/json")

    def test_suggestions_accept_only_the_selected_form_field(self):
        suggested = self.post_json(self.suggest_url, {"form": "saw"})
        rejected = self.post_json(
            self.suggest_url,
            {"form": "saw", "sentence": "I saw a movie yesterday."},
        )
        self.assertEqual(suggested.status_code, 200)
        self.assertEqual({item["form"] for item in suggested.json()["suggestions"]}, {"see", "saw"})
        self.assertEqual(rejected.status_code, 400)

    def test_confirmation_creates_independent_entries_and_preserves_relation(self):
        response = self.post_json(self.confirm_url, {"form": "running", "lemma": "run"})
        self.assertEqual(response.status_code, 201)
        observed = VocabularyEntry.objects.get(workspace=self.workspace, form="running")
        base = VocabularyEntry.objects.get(workspace=self.workspace, form="run")
        self.assertNotEqual(observed.id, base.id)
        self.assertEqual(observed.lemma_entry_id, base.id)
        self.assertEqual(response.json()["observed"]["lemmaForm"], "run")

    def test_same_spelling_stays_independent_and_needs_no_self_relation(self):
        response = self.post_json(self.confirm_url, {"form": "saw", "lemma": "saw"})
        entry = VocabularyEntry.objects.get(workspace=self.workspace, form="saw")
        self.assertEqual(response.status_code, 201)
        self.assertIsNone(entry.lemma_entry_id)

    def test_workspace_isolation_applies_to_suggestions_and_confirmed_records(self):
        response = self.post_json(self.confirm_url, {"form": "went", "lemma": "go"})
        other_suggestions = self.client.post(
            f"/api/workspaces/{self.other_workspace.id}/vocabulary/lemmatize/",
            data=json.dumps({"form": "went"}),
            content_type="application/json",
        )
        observed = VocabularyEntry.objects.get(workspace=self.workspace, form="went")
        base = VocabularyEntry.objects.get(workspace=self.workspace, form="go")
        self.assertEqual(response.status_code, 201)
        self.assertEqual(other_suggestions.status_code, 200)
        self.assertFalse(VocabularyEntry.objects.filter(workspace=self.other_workspace).exists())
        self.assertEqual(observed.lemma_entry_id, base.id)
        self.assertNotEqual(observed.workspace_id, self.other_workspace.id)

    def test_invalid_sentence_is_not_accepted_or_saved(self):
        raw_sentence = self.post_json(
            self.confirm_url,
            {"form": "I am leaving now", "lemma": "leave"},
        )
        self.assertEqual(raw_sentence.status_code, 400)
        self.assertFalse(VocabularyEntry.objects.exists())

    def test_archived_workspace_cannot_receive_lemma_changes(self):
        self.workspace.status = Workspace.Status.ARCHIVED
        self.workspace.save()
        response = self.post_json(self.confirm_url, {"form": "went", "lemma": "go"})
        self.assertEqual(response.status_code, 409)
