"""Corresponding-source integrity checks, independent of network availability."""

import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "sources", Path(__file__).resolve().parents[1] / "scripts/bundle-debian-sources.py"
)
sources = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sources)


class SourceIntegrity(unittest.TestCase):
    def test_inventory_deduplicates_shared_sources_and_rejects_traversal(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "inventory.tsv"
            path.write_text("liba\t1\tpkg\t1:2.0-1\nlibb\t1\tpkg\t1:2.0-1\n")
            self.assertEqual(sources.inventory([path]), [("pkg", "1:2.0-1")])
            for record in ("a\t1\tpkg\t../../escape\n", "a\t1\t../pkg\t1\n", ""):
                path.write_text(record)
                with self.assertRaises(ValueError):
                    sources.inventory([path])

    def test_corrupt_download_never_enters_verified_cache(self):
        content = b"expected archive"
        file = {"name": "pkg.tar.gz", "size": len(content), "sha1": hashlib.sha1(content).hexdigest()}
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(sources, "request", return_value=io.BytesIO(b"corrupt")):
                with self.assertRaisesRegex(ValueError, "hash/size mismatch"):
                    sources.download(file, Path(directory))
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_snapshot_unsafe_member_name_is_rejected(self):
        digest = "a" * 40
        response = {"result": [{"hash": digest}], "fileinfo": {digest: [{"name": "../bad.dsc", "size": 1}]}}
        with patch.object(sources, "request", return_value=io.BytesIO(json.dumps(response).encode())):
            with self.assertRaisesRegex(ValueError, "unsafe Snapshot filename"):
                sources.source_files(("pkg", "1"))

    def test_dsc_must_cover_every_archive_with_matching_sha256(self):
        file = {"name": "pkg.tar.gz", "size": 3, "sha256": "b" * 64}
        control = {"name": "pkg.dsc", "sha1": "c" * 40}
        item = {"files": [control, file]}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / control["sha1"]
            path.write_text(f"Checksums-Sha256:\n {file['sha256']} 3 pkg.tar.gz\n")
            sources.verify_source_control(item, Path(directory))
            for text in (
                "Checksums-Sha256:\n",
                f"Checksums-Sha256:\n {'d' * 64} 3 pkg.tar.gz\n",
                f"Checksums-Sha256:\n {file['sha256']} 3 other.tar.gz\n",
            ):
                path.write_text(text)
                with self.assertRaises(ValueError):
                    sources.verify_source_control(item, Path(directory))


if __name__ == "__main__":
    unittest.main()
