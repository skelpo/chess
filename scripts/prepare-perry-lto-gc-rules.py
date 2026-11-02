"""Retain callback effects when fat LTO folds two trivial forwarding wrappers."""
from pathlib import Path
import sys

source, output = map(Path, sys.argv[1:])
rules = (source / "scripts/gc_call_effects/seeds.txt").read_text()
for wrapper, targets in [
    ("js_async_hooks_provider_defer_destroy",
     "provider_ffi::(js_async_hooks_provider_defer_destroy|defer_destroy_after_check_turns)"),
    ("js_async_hooks_provider_destroy",
     "(provider_ffi::js_async_hooks_provider_destroy|destroy)"),
]:
    before = (f"indirect exact {wrapper} => exact "
              f"perry_runtime::async_hooks::provider_ffi::{wrapper} --")
    after = (f"indirect exact {wrapper} => regex "
             f"^perry_runtime::async_hooks::{targets}$ --")
    if rules.count(before) != 1:
        raise SystemExit("Unexpected callback rule; review the matching Perry revision: " + wrapper)
    rules = rules.replace(before, after)
# Both replacements ADD the known direct callee as an alternative target.
# They do not drop GC seeds, suppress unknown calls or declare a callback safe.
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(rules)
