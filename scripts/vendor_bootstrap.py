"""Download the pinned Bootstrap distribution into local static assets."""

from __future__ import annotations

import sys
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
VERSION = "5.3.8"
MAX_ARCHIVE_SIZE = 10 * 1024 * 1024
DEFAULT_ARCHIVE = ROOT / ".runtime" / f"bootstrap-{VERSION}-dist.zip"
DEFAULT_LICENSE = ROOT / ".runtime" / "bootstrap-LICENSE"


def main() -> int:
    """Copy only required, version-pinned files from a local release archive."""
    archive_path = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else DEFAULT_ARCHIVE
    if not archive_path.is_file():
        raise FileNotFoundError(f"Bootstrap archive was not found: {archive_path}")
    if archive_path.stat().st_size > MAX_ARCHIVE_SIZE:
        raise RuntimeError("Bootstrap archive exceeded the 10 MiB safety limit.")

    with zipfile.ZipFile(archive_path) as archive:
        expected = {
            f"bootstrap-{VERSION}-dist/css/bootstrap.rtl.min.css": (
                ROOT
                / "static"
                / "vendor"
                / "bootstrap"
                / "css"
                / "bootstrap.rtl.min.css"
            ),
            f"bootstrap-{VERSION}-dist/css/bootstrap.rtl.min.css.map": (
                ROOT
                / "static"
                / "vendor"
                / "bootstrap"
                / "css"
                / "bootstrap.rtl.min.css.map"
            ),
            f"bootstrap-{VERSION}-dist/js/bootstrap.bundle.min.js": (
                ROOT
                / "static"
                / "vendor"
                / "bootstrap"
                / "js"
                / "bootstrap.bundle.min.js"
            ),
            f"bootstrap-{VERSION}-dist/js/bootstrap.bundle.min.js.map": (
                ROOT
                / "static"
                / "vendor"
                / "bootstrap"
                / "js"
                / "bootstrap.bundle.min.js.map"
            ),
        }
        for member, destination in expected.items():
            try:
                info = archive.getinfo(member)
                if info.file_size > 2 * 1024 * 1024:
                    raise RuntimeError(
                        f"Bootstrap file exceeded the size limit: {member}"
                    )
                contents = archive.read(member)
            except KeyError as exc:
                raise RuntimeError(f"Bootstrap archive is missing {member}.") from exc
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(contents)

    license_path = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else DEFAULT_LICENSE
    if not license_path.is_file() or license_path.stat().st_size > 20 * 1024:
        raise RuntimeError(
            "The matching Bootstrap license file is missing or oversized."
        )
    license_text = license_path.read_text(encoding="utf-8")
    if not license_text.startswith("The MIT License"):
        raise RuntimeError(
            "The Bootstrap license file did not match the expected MIT license."
        )
    license_destination = ROOT / "static" / "vendor" / "bootstrap" / "LICENSE"
    license_destination.write_text(license_text, encoding="utf-8")

    print(f"Bootstrap {VERSION} copied to static/vendor/bootstrap.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
