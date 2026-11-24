import hashlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile


spec = importlib.util.spec_from_file_location(
    "bootstrap", Path(__file__).resolve().parents[1] / "electron/plugins/tts/cosyvoiceBootstrap.py"
)
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.archive = io.BytesIO()
        with zipfile.ZipFile(self.archive, "w") as wheel:
            for name in bootstrap.RESOURCE_FILES:
                wheel.writestr(f"wetext/fsts/{name}", b"\xd6\xfd\xb2~verified-resource")
            wheel.writestr("wetext/__init__.py", "raise RuntimeError('must not execute')")
            wheel.writestr("../../outside.txt", "must not extract")
        self.content = self.archive.getvalue()
        self.digest = hashlib.sha256(self.content).hexdigest()

    def test_verified_resources_are_cached_without_extracting_python_or_arbitrary_paths(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(bootstrap, "WHEEL_SHA256", self.digest), \
                patch.object(bootstrap.urllib.request, "urlopen", return_value=io.BytesIO(self.content)) as download:
            root = Path(bootstrap.prepare_resources(Path(directory) / "cache"))
            self.assertEqual(download.call_count, 1)
            for name in bootstrap.RESOURCE_FILES:
                self.assertTrue((root / name).is_file())
            self.assertFalse((root / "wetext/__init__.py").exists())
            self.assertFalse((Path(directory) / "outside.txt").exists())
            # An incomplete extracted file is repaired from the verified cache without network.
            target = root / bootstrap.RESOURCE_FILES[0]
            target.write_bytes(b"corrupted")
            bootstrap.prepare_resources(root)
            self.assertEqual(download.call_count, 1)
            self.assertEqual(target.read_bytes(), b"\xd6\xfd\xb2~verified-resource")

    def test_unverified_download_is_rejected_before_cache_or_resource_write(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(bootstrap.urllib.request, "urlopen", return_value=io.BytesIO(b"error page")):
            root = Path(directory)
            with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
                bootstrap.prepare_resources(root)
            self.assertFalse(list(root.iterdir()))


if __name__ == "__main__":
    unittest.main()
