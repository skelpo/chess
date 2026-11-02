"""Measure prepared diagnostic copies serially; keep production source untouched.

This pass runs on a shared host. Instruction counts and output parity are the
evidence; its wall times/cycles are recorded, not used as speedup guarantees.
"""
from pathlib import Path
import json
import re
import subprocess

root = Path('dist/perry-blockers')
variants = json.loads((root / 'variants/variants.json').read_text())
rows = []
references = {}

def fingerprint(value):
    return {k: v for k, v in value.items() if k != 'milliseconds'}

def measure(name, command, args, round_index, group):
    result = subprocess.run(['/usr/bin/time', '-l', *command, *args],
                            capture_output=True, text=True, check=True, timeout=240)
    value = json.loads(result.stdout)
    key = (group, *args)
    if group == 'edges':
        key = (group, args[-1])
        comparison = {k: value[k] for k in ['amount', 'warmup', 'checksum']}
    else:
        comparison = fingerprint(value)
    if key in references:
        assert references[key] == comparison, (name, args, value, references[key])
    else:
        references[key] = comparison
    counters = {}
    for key, label in [('instructions', 'instructions retired'), ('cycles', 'cycles elapsed'),
                       ('peakRssBytes', 'maximum resident set size')]:
        counters[key] = int(re.search(r'(\d+)\s+' + label, result.stderr)[1])
    rows.append(dict(group=group, variant=name, round=round_index, **value, **counters))
    (root / 'diagnostic-results.json').write_text(json.dumps(rows, indent=2)+'\n')
    print(group, name, args, counters['instructions'], flush=True)

# Node's unchanged engine establishes the full result/state fingerprints.
for mode, amount in [('evaluate', '100000'), ('search', '250000'), ('perft', '4'), ('legal', '1000')]:
    measure('Node original', ['node', 'scripts/compare-workload.ts'], [mode, amount], -1, 'engine')
for name in variants:
    for mode, amount in [('perft', '4'), ('legal', '1000')]:
        measure(name, [str(root/'variants'/name/'engine')], [mode, amount], -1, 'engine')
for rnd in range(2):
    for name in variants[rnd:] + variants[:rnd]:
        for mode, amount in [('evaluate', '100000'), ('search', '250000')]:
            measure(name, [str(root/'variants'/name/'engine')], [mode, amount], rnd, 'engine')

for rnd in range(3):
    programs = [('Node', ['node', 'scripts/repro-perry-array-edges.ts']),
                ('Perry current', [str(root/'array-edges')])]
    for name, command in programs[rnd % 2:] + programs[:rnd % 2]:
        for mode in (['plain', 'bounded'] if rnd % 2 == 0 else ['bounded', 'plain']):
            for amount in ['1000000', '2000000']:
                measure(name, command, [mode, amount], rnd, 'edges')
(root / 'measurements-complete').write_text('success\n')
