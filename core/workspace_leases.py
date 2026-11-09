"""Workspace lease operations and fencing-token validation."""

from datetime import timedelta
from uuid import UUID

from django.db import IntegrityError, transaction
from django.db.models import F
from django.utils import timezone

from .models import Workspace, WorkspaceLease


LEASE_SECONDS = 60


class LeaseUnavailable(Exception):
    """Raised when another browser currently owns a Workspace lease."""


def acquire_lease(workspace: Workspace, holder_id: UUID) -> WorkspaceLease:
    """Acquire an expired lease or renew the current browser's lease."""
    now = timezone.now()
    try:
        with transaction.atomic():
            lease, _ = WorkspaceLease.objects.get_or_create(
                workspace=workspace,
                defaults={"expires_at": now},
            )
    except IntegrityError:
        lease = WorkspaceLease.objects.get(workspace=workspace)

    with transaction.atomic():
        lease = WorkspaceLease.objects.get(pk=lease.pk)
        if lease.holder_id == holder_id and lease.expires_at > now:
            updated = WorkspaceLease.objects.filter(
                pk=lease.pk,
                holder_id=holder_id,
                fencing_token=lease.fencing_token,
                expires_at__gt=now,
            ).update(expires_at=now + timedelta(seconds=LEASE_SECONDS))
        else:
            updated = WorkspaceLease.objects.filter(
                pk=lease.pk,
                expires_at__lte=now,
            ).update(
                holder_id=holder_id,
                fencing_token=F("fencing_token") + 1,
                expires_at=now + timedelta(seconds=LEASE_SECONDS),
            )
        if not updated:
            raise LeaseUnavailable
        return WorkspaceLease.objects.get(pk=lease.pk)


def heartbeat_lease(workspace_id, holder_id: UUID, fencing_token: int):
    """Extend only a lease that is still current and unexpired."""
    now = timezone.now()
    updated = WorkspaceLease.objects.filter(
        workspace_id=workspace_id,
        holder_id=holder_id,
        fencing_token=fencing_token,
        expires_at__gt=now,
        workspace__status=Workspace.Status.ACTIVE,
    ).update(expires_at=now + timedelta(seconds=LEASE_SECONDS))
    if not updated:
        return None
    return WorkspaceLease.objects.get(workspace_id=workspace_id)


def release_lease(workspace_id, holder_id: UUID, fencing_token: int) -> bool:
    """Expire a lease only when its current holder and token match."""
    now = timezone.now()
    return bool(WorkspaceLease.objects.filter(
        workspace_id=workspace_id,
        holder_id=holder_id,
        fencing_token=fencing_token,
    ).update(holder_id=None, expires_at=now))


def lease_is_current(workspace_id, holder_id: UUID, fencing_token: int) -> bool:
    """Return whether a modifying request carries the current live fence."""
    return WorkspaceLease.objects.filter(
        workspace_id=workspace_id,
        workspace__status=Workspace.Status.ACTIVE,
        holder_id=holder_id,
        fencing_token=fencing_token,
        expires_at__gt=timezone.now(),
    ).exists()


def lease_payload(lease: WorkspaceLease) -> dict:
    return {
        "holderId": str(lease.holder_id),
        "fencingToken": lease.fencing_token,
        "expiresAt": lease.expires_at.isoformat(),
    }
