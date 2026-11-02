"""Package the tested macOS ARM64 executable with its executable bit intact."""
from pathlib import Path
import gzip
import hashlib
import io
import json
import lzma
import subprocess
import tarfile

binary = Path("dist/chess-min")
subprocess.run(["codesign", "--verify", "--strict", str(binary)], check=True)
payload = binary.read_bytes()
archive = io.BytesIO()
with tarfile.open(fileobj=archive, mode="w", format=tarfile.USTAR_FORMAT) as tar:
    entry = tarfile.TarInfo("chess")
    entry.size = len(payload)
    entry.mode = 0o755
    entry.mtime = 0
    tar.addfile(entry, io.BytesIO(payload))
output = io.BytesIO()
with gzip.GzipFile(fileobj=output, mode="wb", filename="", mtime=0, compresslevel=9) as stream:
    stream.write(archive.getvalue())
package = Path("dist/chess-min-macos-arm64.tar.gz")
package.write_bytes(output.getvalue())
package_xz = Path("dist/chess-min-macos-arm64.tar.xz")
package_xz.write_bytes(lzma.compress(archive.getvalue(), preset=9 | lzma.PRESET_EXTREME))
for packed in (package, package_xz):
    with tarfile.open(fileobj=io.BytesIO(packed.read_bytes()), mode="r:*") as tar:
        members = tar.getmembers()
        assert len(members) == 1 and members[0].name == "chess"
        assert members[0].mode == 0o755
        extracted = tar.extractfile(members[0])
        assert extracted is not None and extracted.read() == payload

result = {
    "binary": {"path": str(binary), "bytes": len(payload),
               "sha256": hashlib.sha256(payload).hexdigest()},
    "package": {"path": str(package), "bytes": package.stat().st_size,
                "sha256": hashlib.sha256(package.read_bytes()).hexdigest()},
    "packageXz": {"path": str(package_xz), "bytes": package_xz.stat().st_size,
                  "sha256": hashlib.sha256(package_xz.read_bytes()).hexdigest()},
    "roundtripVerified": True,
}
Path("dist/chess-min-package.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result, indent=2))
