"""URL configuration for the local Shadowing application."""

from django.urls import include, path


urlpatterns = [
    path("", include("core.urls")),
]
