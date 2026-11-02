"""Account macOS sample main-thread trees, excluding unrelated sleeping threads.

Usage: python3 scripts/analyze-perry-sample.py sample.txt output.json
Self counts are a node's inclusive count minus its immediate children. Inclusive
symbol counts deduplicate recursive frames for each self-count contribution.
"""
from collections import Counter
from pathlib import Path
import json
import re
import subprocess
import sys

source, output = map(Path, sys.argv[1:])
lines = source.read_text().split('Call graph:\n', 1)[1].split(
    'Total number in stack', 1)[0].splitlines()
nodes = []
stack = []
main = False
total = 0
for line in lines:
    match = re.match(r'^([ +!:|]*)(\d+) (.*)$', line)
    if not match:
        continue
    prefix, count, label = match.groups()
    count = int(count)
    if label.startswith('Thread_'):
        if main:
            break
        main = 'com.apple.main-thread' in label
        if main:
            total = count
        continue
    if not main:
        continue
    depth = len(prefix)
    while stack and nodes[stack[-1]]['depth'] >= depth:
        stack.pop()
    name = label.split('  (in ', 1)[0]
    parent = stack[-1] if stack else None
    offset = re.search(r'\) \+ (\d+)', label)
    node = dict(depth=depth, count=count, self=count, name=name,
                offset=int(offset[1]) if offset else None, parent=parent)
    if parent is not None:
        nodes[parent]['self'] -= count
    stack.append(len(nodes))
    nodes.append(node)
assert total and all(n['self'] >= 0 for n in nodes)
assert sum(n['self'] for n in nodes) == total
names = list(dict.fromkeys(n['name'] for n in nodes))
demangled = subprocess.run(['rustfilt'], input='\n'.join(names)+'\n',
                           text=True, capture_output=True, check=True).stdout.splitlines()
display = dict(zip(names, demangled))
self_counts, inclusive, pcs = Counter(), Counter(), Counter()
families = Counter()
for i, node in enumerate(nodes):
    count = node['self']
    if not count:
        continue
    self_counts[node['name']] += count
    pcs[(node['name'], node['offset'])] += count
    seen = set()
    ancestor = i
    while ancestor is not None:
        seen.add(nodes[ancestor]['name'])
        ancestor = nodes[ancestor]['parent']
    for name in seen:
        inclusive[name] += count
    name = display[node['name']]
    if name.startswith(('perry_method_engine_', 'perry_fn_engine_', 'perry_closure_engine_')):
        family = 'generated engine'
    elif 'perry_runtime::' in name or name.startswith('js_'):
        family = 'runtime'
    elif 'tlv_get_addr' in name:
        family = 'TLS lookup'
    elif name.startswith('perry_'):
        family = 'generated support'
    else:
        family = 'other'
    families[family] += count
result = dict(source=str(source), totalMainThreadSamples=total,
              method='Residual main-thread tree counts; recursive inclusive symbols counted once per sample. Sampling shares are not removable-overhead estimates.',
              families=[dict(name=k,samples=v,percent=100*v/total) for k,v in families.most_common()],
              functions=[dict(name=name,demangled=display[name],selfSamples=self_counts[name],
                              selfPercent=100*self_counts[name]/total,
                              inclusiveSamples=inclusive[name],inclusivePercent=100*inclusive[name]/total)
                         for name in sorted(inclusive,key=lambda n:self_counts[n],reverse=True)],
              locations=[dict(name=name,offset=offset,samples=count,percent=100*count/total)
                         for (name,offset),count in pcs.most_common()])
output.write_text(json.dumps(result,indent=2)+'\n')
print(source,total,'samples',families)
for name,count in self_counts.most_common(12):
    print(f'{100*count/total:5.2f}%',display[name])
