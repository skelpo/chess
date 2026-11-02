"""Compare a synthetic access reduction serially; run after all builds finish."""
from pathlib import Path
import json
import re
import subprocess
import time

root = Path("dist/perry-speed-size")
programs = [
    ("Node", ["node", "scripts/repro-perry-access.ts"]),
    ("Bun", ["bun", "scripts/repro-perry-access.ts"]),
    ("Perry original", [str(root / "repro-access-original")]),
    ("ScriptC", [str(root / "repro-access-scriptc")]),
]
variants = ["method", "field", "local", "live-bound", "typed-local", "flat", "directions", "arithmetic", "fixed-bound", "fixed-typed"]
results = []
for round_index in range(3):
    for variant in variants[round_index:] + variants[:round_index]:
        for name, command in programs[round_index:] + programs[:round_index]:
            start = time.monotonic()
            run = subprocess.run(["/usr/bin/time", "-l", *command, variant, "5000000"],
                                 text=True, capture_output=True, timeout=120, check=True)
            wall_ms = (time.monotonic() - start) * 1000
            data = json.loads(run.stdout)
            assert data["warmup"] == 42188 and data["checksum"] == 2109378, data
            def counter(label):
                match = re.search(r"(\d+)\s+" + label, run.stderr)
                assert match is not None, run.stderr
                return int(match[1])
            results.append({"runtime": name, "round": round_index, **data,
                            "processWallMs": wall_ms,
                            "instructions": counter("instructions retired"),
                            "cycles": counter("cycles elapsed"),
                            "peakRssBytes": counter("maximum resident set size")})
            (root / "access-results.json").write_text(json.dumps({
                "methodology": "Serial fresh processes, rotated variants/runtime order, 100000 warmup probes, 5000000 timed probes. Identical visit order and checksums. Inner timer excludes warmup; OS counters include the full process. Synthetic controls are not full-engine speedup claims.",
                "rounds": 3, "results": results,
            }, indent=2) + "\n")
            print(variant, name, round(data["milliseconds"], 2), "ms", flush=True)
