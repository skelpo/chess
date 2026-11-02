"""Run the prepared old/current Perry artifacts serially, after all builds finish."""
from pathlib import Path
import hashlib
import json
import re
import statistics
import subprocess

root = Path('dist/perry-reassessment')
assert (root / 'matching-builds-complete').read_text().strip() == 'success'
rows = []

def measure(group, name, command, args, round_index, amount):
    process = subprocess.run(['/usr/bin/time', '-l', *command, *args], text=True,
                             capture_output=True, timeout=180, check=True)
    value = json.loads(process.stdout)
    expected = {5000000: 2109378, 10000000: 4218750}[amount]
    assert value['checksum'] == expected and value['warmup'] == 42188, value
    counters = {}
    for key, label in [('instructions', 'instructions retired'), ('cycles', 'cycles elapsed'),
                       ('peakRssBytes', 'maximum resident set size')]:
        match = re.search(r'(\d+)\s+' + label, process.stderr)
        assert match, process.stderr
        counters[key] = int(match[1])
    rows.append({'group': group, 'runtime': name, 'round': round_index,
                 'amount': amount, 'args': args, **value, **counters})
    (root / 'micro-results.json').write_text(json.dumps({
        'methodology': 'Serial rotated fresh processes; 100k warmup; inner wall timer excludes setup/warmup. OS counters cover complete process. Slopes use median I(10M)-I(5M) over 5M. Each compiler links its matching runtime; main includes changes beyond the four issue fixes.',
        'results': rows,
    }, indent=2) + '\n')
    print(group, name, args, round(value['milliseconds'], 2), flush=True)

programs = [('Perry original', ['dist/perry-issues/access-stock']),
            ('Perry current', [str(root / 'access-current')]),
            ('Node', ['node', 'scripts/repro-perry-access.ts'])]
variants = ['method', 'local', 'live-bound', 'fixed-bound', 'directions', 'arithmetic']
for rnd in range(3):
    for variant in variants[rnd:] + variants[:rnd]:
        for name, command in programs[rnd:] + programs[:rnd]:
            for amount in ([5000000, 10000000] if rnd % 2 == 0 else [10000000, 5000000]):
                measure('access', name, command, [variant, str(amount)], rnd, amount)
programs = [('old postfix', ['dist/perry-issues/increment-postfix']),
            ('new postfix', [str(root / 'increment-current')]),
            ('old plus', ['dist/perry-issues/increment-plus']),
            ('new plus', [str(root / 'increment-plus-current')])]
for rnd in range(3):
    for name, command in programs[rnd:] + programs[:rnd]:
        for amount in ([5000000, 10000000] if rnd % 2 == 0 else [10000000, 5000000]):
            measure('increment', name, command, [str(amount)], rnd, amount)
programs = [('Perry original', ['dist/profiles/repro-perry-board']),
            ('Perry current', [str(root / 'board-current')]),
            ('Node', ['node', 'scripts/repro-perry-board.ts'])]
for rnd in range(3):
    for variant in ['forof', 'indexed']:
        for name, command in programs[rnd:] + programs[:rnd]:
            measure('iterator', name, command, [variant, '5000000'], rnd, 5000000)
for script, args, log in [
    ('scripts/compare-runtimes.ts', ['--manifest', str(root / 'engine-manifest.json')], 'engine-benchmark.log'),
    ('scripts/benchmark.ts', ['--manifest', str(root / 'ui-manifest.json'), '--local-only'], 'ui-benchmark.log'),
]:
    with (root / log).open('w') as output:
        subprocess.run(['node', script, *args], stdout=output, stderr=subprocess.STDOUT, check=True)
    print('completed', script, flush=True)
(root / 'measurements-complete').write_text('success\n')
