"""Use verified, bundled WeText FSTs instead of downloading its entire model repository."""
import hashlib
import importlib
import os
from pathlib import Path
import runpy
import sys
import tempfile
import urllib.request
import zipfile


WHEEL_URL = (
    "https://files.pythonhosted.org/packages/2b/9d/"
    "19af22eddb1ae7c52bcdec1d0ba854a6a7611f8a309a5f911dc21f6892ae/"
    "wetext-0.0.9-py3-none-any.whl"
)
WHEEL_SHA256 = "effa5565c0bacfaed0684ed667f60fd0b59fe076c08b4600ad5d8473923802d9"
RESOURCE_FILES = tuple(
    f"{language}/tn/{kind}.fst"
    for language in ("zh", "en") for kind in ("tagger", "verbalizer")
)


def prepare_resources(root):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    wheel = root / "wetext-0.0.9.whl"
    if not wheel.exists() or hashlib.sha256(wheel.read_bytes()).hexdigest() != WHEEL_SHA256:
        print("[tts] Downloading verified WeText resources from PyPI (1.5 MB)", flush=True)
        with urllib.request.urlopen(WHEEL_URL, timeout=60) as response:
            content = response.read(8 * 1024 * 1024)
        if hashlib.sha256(content).hexdigest() != WHEEL_SHA256:
            raise RuntimeError("WeText resource checksum mismatch")
        with tempfile.NamedTemporaryFile(dir=root, delete=False) as temporary:
            temporary.write(content)
            temporary_path = Path(temporary.name)
        os.replace(temporary_path, wheel)
    # Extract only fixed resource paths, never Python code from the downloaded wheel.
    # Re-read the verified archive on every startup to repair incomplete/corrupt extracted files.
    with zipfile.ZipFile(wheel) as archive:
        for filename in RESOURCE_FILES:
            content = archive.read(f"wetext/fsts/{filename}")
            if content[:4] != b"\xd6\xfd\xb2~":
                raise RuntimeError(f"Invalid WeText FST: {filename}")
            target = root / filename
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
    return str(root)


def main():
    resource_dir = prepare_resources("/data/cache/wetext-0.0.9")
    # Keep the image's installed Normalizer implementation; replace only its resource lookup.
    module = importlib.import_module("wetext.wetext")
    original_download = getattr(module, "snapshot_download", None)
    if original_download is not None:
        def cached_download(model_id, *args, **kwargs):
            if model_id == "pengzhendong/wetext":
                return resource_dir
            return original_download(model_id, *args, **kwargs)
        module.snapshot_download = cached_download
    sys.path.insert(0, "/app")
    os.chdir("/app")
    runpy.run_path("/app/app.py", run_name="__main__")


if __name__ == "__main__":
    main()
