"""URL patterns for the application shell, health, and Workspaces."""

from django.urls import path

from . import views


urlpatterns = [
    path("", views.home, name="home"),
    path("health/", views.health, name="health"),
    path("api/workspaces/", views.workspace_collection, name="workspace-collection"),
    path(
        "api/workspaces/<uuid:workspace_id>/",
        views.workspace_detail,
        name="workspace-detail",
    ),
    path(
        "api/workspaces/<uuid:workspace_id>/lease/",
        views.workspace_lease_acquire,
        name="workspace-lease-acquire",
    ),
    path(
        "api/workspaces/<uuid:workspace_id>/lease/heartbeat/",
        views.workspace_lease_heartbeat,
        name="workspace-lease-heartbeat",
    ),
    path(
        "api/workspaces/<uuid:workspace_id>/lease/release/",
        views.workspace_lease_release,
        name="workspace-lease-release",
    ),
    path(
        "api/workspaces/<uuid:workspace_id>/vocabulary/",
        views.vocabulary_collection,
        name="vocabulary-collection",
    ),
    path(
        "api/workspaces/<uuid:workspace_id>/vocabulary/lemmatize/",
        views.vocabulary_lemma_suggestions,
        name="vocabulary-lemma-suggestions",
    ),
    path(
        "api/workspaces/<uuid:workspace_id>/vocabulary/lemma/",
        views.vocabulary_lemma_confirm,
        name="vocabulary-lemma-confirm",
    ),
    path(
        "api/workspaces/<uuid:workspace_id>/vocabulary/sync/",
        views.vocabulary_sync,
        name="vocabulary-sync",
    ),
    path(
        "api/workspaces/<uuid:workspace_id>/vocabulary/<uuid:entry_id>/",
        views.vocabulary_detail,
        name="vocabulary-detail",
    ),
]
