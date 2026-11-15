#!/usr/bin/env python3
"""Counterfactuals for the bundle section of `validate_contracts.py`.

WHY THIS FILE EXISTS

That section was dead for the life of the job: `dist/` is gitignored and the
required `contracts` job never built a bundle, so it printed
"(no dist/plugins yet; bundle checks skipped)" and exited 0. A check that has
never been observed to fail is not known to be a check.

`scripts/contract-bundle-fixture.sh` now builds one real signed bundle from the
tree (no Docker, no registry), so the section runs in CI. This file is what makes
the section's FAILURE paths real: each case takes the untouched bundle, alters
exactly one thing, and asserts the validator reports it.

The one alteration that must NOT fail is `version`, and it is asserted here as a
pass on purpose. `manifest.json` is excluded from the payload digest
(`crates/bundle/src/lib.rs:321`) because it is protected by the Ed25519 signature
over `manifestDigest` instead - which this Python validator does not check and
`crates/bundle` does. Asserting it here records the boundary, so a later reader
cannot mistake it for an oversight in either direction.

Run: python3 tests/contract/test_bundle_validation.py
Requires: a bundle at dist/plugins/*.plugin.zip (run the fixture script first),
          and `jsonschema` (the same dependency validate_contracts.py declares).
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BUNDLE_DIR = ROOT / "dist" / "plugins"
VALIDATOR = ROOT / "tests" / "contract" / "validate_contracts.py"


def find_bundle() -> Path | None:
    if not BUNDLE_DIR.is_dir():
        return None
    bundles = sorted(BUNDLE_DIR.glob("*.plugin.zip"))
    return bundles[0] if bundles else None


def read_bundle(path: Path) -> dict[str, bytes]:
    with zipfile.ZipFile(path) as archive:
        return {name: archive.read(name) for name in archive.namelist()}


def write_bundle(path: Path, files: dict[str, bytes]) -> None:
    with zipfile.ZipFile(path, "w") as archive:
        for name, data in files.items():
            archive.writestr(name, data)


class BundleValidationTest(unittest.TestCase):
    """Each test mutates one thing and re-runs the real validator."""

    bundle: Path | None = None

    @classmethod
    def setUpClass(cls) -> None:
        cls.bundle = find_bundle()
        if cls.bundle is None:
            raise unittest.SkipTest(
                "no dist/plugins/*.plugin.zip; run scripts/contract-bundle-fixture.sh"
            )
        cls.pristine = read_bundle(cls.bundle)

    def setUp(self) -> None:
        # Restore the untouched bundle before every case, so a failure in one
        # cannot be read as a failure in the next.
        write_bundle(self.bundle, dict(self.pristine))

    def tearDown(self) -> None:
        write_bundle(self.bundle, dict(self.pristine))

    def validate(self) -> tuple[int, str]:
        proc = subprocess.run(
            [sys.executable, str(VALIDATOR)],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        return proc.returncode, proc.stdout + proc.stderr

    def assert_rejected(self, needle: str, why: str) -> None:
        files = read_bundle(self.bundle)
        try:
            self.mutate(files)
            write_bundle(self.bundle, files)
        except KeyError as exc:
            self.fail(f"fixture bundle lacks {exc}; {why}")
        code, output = self.validate()
        self.assertNotEqual(code, 0, f"{why}: validator exited 0\n{output}")
        self.assertIn(needle, output, f"{why}: expected {needle!r} in output\n{output}")
        # The per-bundle line must not read as a pass for a bundle that failed.
        self.assertNotIn("ok bundle", output, f"{why}: printed 'ok bundle' anyway\n{output}")

    def mutate(self, files: dict[str, bytes]) -> None:
        raise NotImplementedError

    # -- the digest-covered files ------------------------------------------------

    def test_asset_index_edit_without_digest_update(self) -> None:
        def m(files: dict[str, bytes]) -> None:
            manifest = json.loads(files["manifest.json"])
            key = manifest["frontend"]["assetIndex"]
            files[key] = files[key] + b" "

        self.mutate = m
        self.assert_rejected("assetIndexDigest mismatch", "asset index altered")

    def test_remote_entry_edit_without_digest_update(self) -> None:
        def m(files: dict[str, bytes]) -> None:
            manifest = json.loads(files["manifest.json"])
            key = manifest["frontend"]["remoteEntry"]
            files[key] = files[key] + b"// tampered"

        self.mutate = m
        self.assert_rejected("remoteEntryDigest mismatch", "remote entry altered")

    # -- the schema --------------------------------------------------------------

    def test_image_reference_switched_to_a_tag(self) -> None:
        def m(files: dict[str, bytes]) -> None:
            manifest = json.loads(files["manifest.json"])
            manifest["backend"]["imageRef"] = "ghcr.io/x/y:latest"
            files["manifest.json"] = json.dumps(manifest).encode()

        self.mutate = m
        self.assert_rejected("does not match", "image ref is a mutable tag")

    def test_schema_version_downgraded(self) -> None:
        def m(files: dict[str, bytes]) -> None:
            manifest = json.loads(files["manifest.json"])
            manifest["schemaVersion"] = "1.0"
            files["manifest.json"] = json.dumps(manifest).encode()

        self.mutate = m
        self.assert_rejected("was expected", "schemaVersion 1.0 accepted as 1.1")

    # -- structural --------------------------------------------------------------

    def test_manifest_removed(self) -> None:
        def m(files: dict[str, bytes]) -> None:
            del files["manifest.json"]

        self.mutate = m
        self.assert_rejected("manifest.json", "bundle without a manifest")

    def test_asset_index_removed(self) -> None:
        def m(files: dict[str, bytes]) -> None:
            manifest = json.loads(files["manifest.json"])
            del files[manifest["frontend"]["assetIndex"]]

        self.mutate = m
        self.assert_rejected("asset-index.json", "bundle without its asset index")

    # -- the boundary, asserted so it cannot be re-read as an oversight ----------

    def test_a_bare_version_bump_is_not_this_layers_job(self) -> None:
        """`version` is signature-covered, not payload-digest-covered.

        `build_bundle_from_dir` removes `manifest.json` from the payload before
        computing `artifactDigest` (crates/bundle/src/lib.rs:321) and signs
        (artifactDigest, manifestDigest) instead. Verifying that signature is
        `crates/bundle::verify_bundle`'s job, in the `rust` check. This validator
        re-derives digests and checks schema only, so a bare version edit passes
        here - correctly. If this test starts failing, either the manifest became
        payload-covered (a contract change worth an ADR) or this layer grew a
        signature check (then update the test and say so).
        """
        files = read_bundle(self.bundle)
        manifest = json.loads(files["manifest.json"])
        manifest["version"] = "9.9.9"
        files["manifest.json"] = json.dumps(manifest).encode()
        write_bundle(self.bundle, files)

        code, output = self.validate()
        self.assertEqual(code, 0, f"a bare version bump should pass this layer\n{output}")
        self.assertIn("ok bundle", output)


class EmptyBundleDirectoryTest(unittest.TestCase):
    """Zero bundles is a failure, not a skip."""

    def test_directory_with_no_zip_fails(self) -> None:
        if not BUNDLE_DIR.is_dir():
            raise unittest.SkipTest("no dist/plugins; run scripts/contract-bundle-fixture.sh")
        saved = {p.name: p.read_bytes() for p in BUNDLE_DIR.glob("*.plugin.zip")}
        try:
            for p in BUNDLE_DIR.glob("*.plugin.zip"):
                p.unlink()
            proc = subprocess.run(
                [sys.executable, str(VALIDATOR)],
                cwd=ROOT, capture_output=True, text=True,
            )
            output = proc.stdout + proc.stderr
            self.assertNotEqual(proc.returncode, 0, f"an empty bundle dir passed\n{output}")
            self.assertIn("holds no *.plugin.zip", output)
        finally:
            for name, data in saved.items():
                (BUNDLE_DIR / name).write_bytes(data)


if __name__ == "__main__":
    unittest.main(verbosity=2)
